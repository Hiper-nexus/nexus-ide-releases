import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface AgentSpecPatch {
  name: string;
  tools?: string[];
  skills?: string[];
  model?: string;
  effort?: string;
  category?: string;
  systemPrompt?: string;
}

export interface AgentSpecWriteCandidate {
  readonly patch: AgentSpecPatch;
  readonly currentFingerprint: string;
  readonly nextContents: string;
  readonly path: string;
}

// No path separators, no leading dot, no traversal — the name maps 1:1 to a
// filename inside ~/.claude/agents.
const SAFE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/;
// Frontmatter scalar values live on a single line; a comma-list token must not
// smuggle a list separator either.
const SCALAR_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.\- ]{0,127}$/;
const LIST_TOKEN_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.\-]{0,127}$/;
const EFFORT_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/;

function assertName(name: string): string {
  if (!SAFE_NAME_RE.test(name) || name.includes('..')) {
    throw new Error('invalid agent spec name');
  }
  return name;
}

function targetPath(name: string): string {
  return path.join(os.homedir(), '.claude', 'agents', `${assertName(name)}.md`);
}

function sameFile(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function readCurrent(file: string): { contents: string; fingerprint: string } {
  if (!fs.existsSync(file)) {
    return {
      contents: '',
      fingerprint: createHash('sha256').update('missing').digest('hex'),
    };
  }
  const before = fs.lstatSync(file);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
    throw new Error('agent spec must be a regular single-link file');
  }
  if (before.size > 1_000_000) throw new Error('agent spec is too large');
  const noFollow = 'O_NOFOLLOW' in fs.constants ? fs.constants.O_NOFOLLOW : 0;
  const fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || !sameFile(before, opened)) {
      throw new Error('agent spec changed while opening');
    }
    const contents = fs.readFileSync(fd, 'utf8');
    const after = fs.lstatSync(file);
    if (after.isSymbolicLink() || !sameFile(opened, after)) {
      throw new Error('agent spec changed while reading');
    }
    return {
      contents,
      fingerprint: createHash('sha256')
        .update('present\0')
        .update(contents)
        .digest('hex'),
    };
  } finally {
    fs.closeSync(fd);
  }
}

/** Reject any value that could break out of a single frontmatter line. */
function assertScalar(field: string, value: string): string {
  const trimmed = value.trim();
  if (!SCALAR_RE.test(trimmed)) {
    throw new Error(`invalid ${field} value`);
  }
  return trimmed;
}

function assertList(field: string, values: string[]): string[] {
  return values.map((raw) => {
    const token = raw.trim();
    if (!LIST_TOKEN_RE.test(token)) {
      throw new Error(`invalid ${field} entry: ${raw}`);
    }
    return token;
  });
}

function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } {
  if (!raw.startsWith('---\n')) return { data: {}, body: raw };
  const end = raw.indexOf('\n---', 4);
  if (end < 0) return { data: {}, body: raw };
  const block = raw.slice(4, end).trim();
  const body = raw.slice(end + 4).replace(/^\n/, '');
  const data: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const sep = line.indexOf(':');
    if (sep <= 0) continue;
    data[line.slice(0, sep).trim()] = line.slice(sep + 1).trim();
  }
  return { data, body };
}

function serialize(data: Record<string, string>, body: string): string {
  const lines = Object.entries(data)
    .filter(([, value]) => value.length > 0)
    .map(([key, value]) => `${key}: ${value}`);
  return `---\n${lines.join('\n')}\n---\n\n${body.trim()}\n`;
}

function nextAgentSpecContents(patch: AgentSpecPatch, current: string): string {
  const parsed = parseFrontmatter(current);
  const data = { ...parsed.data };
  if (patch.tools) data.tools = assertList('tools', patch.tools).join(', ');
  if (patch.skills) data.skills = assertList('skills', patch.skills).join(', ');
  if (patch.model !== undefined) data.model = assertScalar('model', patch.model);
  if (patch.effort !== undefined) {
    const effort = patch.effort.trim().toLowerCase();
    if (!EFFORT_RE.test(effort)) throw new Error('invalid effort value');
    data.effort = effort;
  }
  if (patch.category !== undefined) {
    data.category = assertScalar('category', patch.category);
  }
  const body =
    patch.systemPrompt ??
    parsed.body ??
    `# ${patch.name}\n\nDescribe this agent's operating contract here.`;
  const serialized = serialize(data, body);
  if (serialized.split('\n---', 2).length < 2) {
    throw new Error('refusing to write malformed frontmatter');
  }
  return serialized;
}

export function prepareAgentSpecWrite(
  patch: AgentSpecPatch,
): AgentSpecWriteCandidate {
  const file = targetPath(patch.name);
  const current = readCurrent(file);
  const nextContents = nextAgentSpecContents(patch, current.contents);
  if (nextContents.length > 6_000) {
    throw new Error(
      'agent spec review exceeds 6000 characters; shorten it before approval',
    );
  }
  if (
    /[\0-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(
      nextContents,
    )
  ) {
    throw new Error('agent spec contains invisible control characters');
  }
  return Object.freeze({
    patch: Object.freeze({ ...patch }),
    currentFingerprint: current.fingerprint,
    nextContents,
    path: file,
  });
}

export function writeAgentSpec(
  patch: AgentSpecPatch,
  expectedFingerprint?: string,
): { ok: boolean; path?: string; error?: string } {
  try {
    const file = targetPath(patch.name);
    const current = readCurrent(file);
    if (
      expectedFingerprint !== undefined &&
      current.fingerprint !== expectedFingerprint
    ) {
      throw new Error('agent spec changed while native confirmation was open');
    }
    const serialized = nextAgentSpecContents(patch, current.contents);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeAgentSpecFile(file, serialized);
    return { ok: true, path: file };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function writeAgentSpecFile(file: string, contents: string): void {
  const tmp = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  let fd: number | null = null;
  try {
    const noFollow = 'O_NOFOLLOW' in fs.constants ? fs.constants.O_NOFOLLOW : 0;
    fd = fs.openSync(
      tmp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
      0o600,
    );
    fs.writeFileSync(fd, contents, 'utf8');
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
  } finally {
    if (fd !== null) fs.closeSync(fd);
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Renamed successfully or never created.
    }
  }
}
