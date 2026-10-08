import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 64 * 1024;
const MAX_PATHS = 256;
const invalid = (reason: string): Error => new Error(`go.work: ${reason}`);
const inside = (root: string, file: string): boolean => {
  const rel = path.relative(root, file);
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};

/** No CLI lookup or project mutation. Unknown grammar never yields partial coverage. */
export async function discoverScopedGoWorkspace(cwd: string, rootRealPath: string): Promise<null | { file: string; moduleRoots: readonly string[] }> {
  try {
    const root = await fs.realpath(rootRealPath);
    let directory = await fs.realpath(cwd);
    if (root !== rootRealPath || !inside(root, directory)) throw invalid('execution directory outside the canonical root');
    for (let depth = 0; depth < 128; depth++) {
      const file = path.join(directory, 'go.work');
      const stat = await fs.lstat(file).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      });
      if (stat) {
        const text = await readWorkspace(file);
        const { uses, replacements } = workspacePaths(text);
        const moduleRoots: string[] = [];
        for (const [values, members] of [[uses, true], [replacements, false]] as const) {
          for (const value of values) {
            if (!value || /[\x00-\x1f\x7f]/.test(value)) throw invalid('invalid local path');
            // Foreign-platform absolute paths must never become a relative directory.
            if (process.platform !== 'win32' && (/^[A-Za-z]:/.test(value) || value.includes('\\'))) throw invalid('unsupported Windows path on this host');
            const resolved = path.resolve(directory, value);
            if (!inside(root, resolved)) throw invalid('local path outside authorized root');
            const canonical = await fs.realpath(resolved);
            if (!inside(root, canonical) || !(await fs.stat(canonical)).isDirectory()) throw invalid('local path escapes authorized root');
            const manifest = await fs.realpath(path.join(canonical, 'go.mod'));
            if (!inside(root, manifest) || !(await fs.stat(manifest)).isFile()) throw invalid('module manifest outside authorized root');
            if (members && !moduleRoots.includes(canonical)) moduleRoots.push(canonical);
          }
        }
        if (await fs.realpath(directory) !== directory || await readWorkspace(file) !== text) throw invalid('workspace changed during discovery');
        return { file, moduleRoots };
      }
      if (directory === root) return null;
      directory = path.dirname(directory);
    }
    throw invalid('ancestor limit exceeded');
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('go.work:')) throw error;
    throw invalid('metadata or module path unavailable');
  }
}

/** Descriptor-bound read: no symlinks, special files, hardlinks or growing input. */
async function readWorkspace(file: string): Promise<string> {
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_BYTES) throw invalid('metadata exceeds safe read limits');
    const buffer = Buffer.alloc(before.size + 1);
    let used = 0;
    while (used < buffer.length) {
      const read = await handle.read(buffer, used, buffer.length - used, used);
      if (!read.bytesRead) break;
      used += read.bytesRead;
    }
    const same = (value: typeof before) => value.isFile() && value.nlink === 1 &&
      value.dev === before.dev && value.ino === before.ino && value.size === before.size &&
      value.mtimeMs === before.mtimeMs && value.ctimeMs === before.ctimeMs;
    if (used !== before.size || !same(await handle.stat()) || !same(await fs.lstat(file))) throw invalid('metadata changed during read');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, used));
  } finally { await handle.close(); }
}

type Token = { value: string; quoted: boolean };

/** Only Go's line comments and string literals; unsupported syntax fails closed. */
function lexLines(text: string): Token[][] {
  const lines: Token[][] = [[]];
  let at = 0;
  const push = (value: string, quoted = false) => {
    if (!value || /[\x00-\x1f\x7f]/.test(value)) throw invalid('invalid token');
    lines[lines.length - 1]!.push({ value, quoted });
  };
  while (at < text.length) {
    const char = text[at]!;
    if (char === '\n') { lines.push([]); at++; continue; }
    if (char === ' ' || char === '\t' || char === '\r') { at++; continue; }
    if (text.startsWith('//', at)) { while (at < text.length && text[at] !== '\n') at++; continue; }
    if (char === '"' || char === '`') {
      const quote = char; at++; const bytes: Buffer[] = []; let closed = false;
      while (at < text.length) {
        const current = String.fromCodePoint(text.codePointAt(at)!); at += current.length;
        if (current === quote) { closed = true; break; }
        if (current === '\n' || current === '\r') throw invalid('multiline path unsupported');
        if (current !== '\\' || quote === '`') { bytes.push(Buffer.from(current)); continue; }
        const escape = text[at++];
        const simple: Record<string, string> = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', '"': '"' };
        if (escape && Object.hasOwn(simple, escape)) { bytes.push(Buffer.from(simple[escape]!)); continue; }
        const octal = Boolean(escape && /^[0-7]$/.test(escape));
        const width = octal ? 2 : escape === 'x' ? 2 : escape === 'u' ? 4 : escape === 'U' ? 8 : 0;
        if (!width) throw invalid('unsupported string escape');
        const digits = (octal ? escape : '') + text.slice(at, at + width); at += width;
        if (digits.length !== width + (octal ? 1 : 0) || !(octal ? /^[0-7]+$/ : /^[\da-fA-F]+$/).test(digits)) throw invalid('invalid string escape');
        const value = Number.parseInt(digits, octal ? 8 : 16);
        if (octal || escape === 'x') { if (value > 255) throw invalid('byte escape out of range'); bytes.push(Buffer.from([value])); }
        else { if (value > 0x10ffff || value >= 0xd800 && value <= 0xdfff) throw invalid('unicode escape out of range'); bytes.push(Buffer.from(String.fromCodePoint(value))); }
      }
      if (!closed) throw invalid('unterminated path');
      push(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(bytes)), true);
      if (at < text.length && !/[\s)]/.test(text[at]!) && !text.startsWith('//', at)) throw invalid('missing token separator');
      continue;
    }
    if (char === '(' || char === ')') { push(char); at++; continue; }
    if (text.startsWith('=>', at)) { push('=>'); at += 2; continue; }
    const start = at;
    while (at < text.length && !/[\s()"`]/.test(text[at]!) && !text.startsWith('=>', at) && !text.startsWith('//', at)) at++;
    if (at === start) throw invalid('unsupported token');
    if (text.startsWith('//', at)) throw invalid('comment adjacent to unquoted token is ambiguous');
    const value = text.slice(start, at);
    if (/[;{}]/.test(value) || value.includes('/*') || value.includes('*/')) throw invalid('unsupported syntax');
    push(value);
  }
  return lines;
}

function workspacePaths(text: string): { uses: string[]; replacements: string[] } {
  const uses: string[] = []; const replacements: string[] = [];
  let block: string | null = null; let paths = 0;
  const take = (directive: string, tokens: Token[]) => {
    if (tokens.some(token => !token.quoted && ['(', ')'].includes(token.value))) throw invalid('nested or malformed block');
    const values = tokens.map(token => token.value);
    if (directive === 'use') {
      if (values.length !== 1 || ++paths > MAX_PATHS) throw invalid('invalid or excessive module inventory');
      uses.push(values[0]!);
    } else if (directive === 'replace') {
      const arrow = tokens.findIndex(token => !token.quoted && token.value === '=>');
      if (![1, 2].includes(arrow) || values.slice(arrow + 1).length < 1 || values.slice(arrow + 1).length > 2 || values.lastIndexOf('=>') !== arrow) throw invalid('invalid replacement');
      if (arrow === 2 && !/^v\d/.test(values[1]!)) throw invalid('unsupported replacement version');
      const target = values[arrow + 1]!;
      if (values.length === arrow + 2) {
        if (!/^(?:\.{1,2}(?:[\\/]|$)|[\\/]|[A-Za-z]:)/.test(target)) throw invalid('replacement without a local path or version');
        if (++paths > MAX_PATHS) throw invalid('replacement inventory limit exceeded');
        replacements.push(target);
      } else if (/^(?:\.{1,2}(?:[\\/]|$)|[\\/]|[A-Za-z]:)/.test(target) || !/^v\d/.test(values[arrow + 2]!)) throw invalid('ambiguous replacement');
    } else if (directive === 'go' || directive === 'toolchain' || directive === 'godebug') {
      if (values.length !== 1 || values[0] === '=>') throw invalid('unsupported directive syntax');
    } else throw invalid('unsupported directive');
  };
  for (const line of lexLines(text)) {
    if (!line.length) continue;
    if (block) {
      if (line.length === 1 && !line[0]!.quoted && line[0]!.value === ')') { block = null; continue; }
      take(block, line); continue;
    }
    const [head, ...tail] = line;
    if (head!.quoted || !['use', 'replace', 'go', 'toolchain', 'godebug'].includes(head!.value)) throw invalid('unsupported directive');
    if (tail.length === 1 && !tail[0]!.quoted && tail[0]!.value === '(') {
      if (!['use', 'replace', 'godebug'].includes(head!.value)) throw invalid('unsupported block');
      block = head!.value; continue;
    }
    take(head!.value, tail);
  }
  if (block) throw invalid('unterminated block');
  return { uses, replacements };
}
