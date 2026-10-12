// Resource scheduling only. This catalog never authorizes shell side effects.
const path = require('node:path');
const fs = require('node:fs');
function packageInfo(file) {
  if (!path.isAbsolute(file)) return null;
  let directory = path.dirname(file);
  for (let depth = 0; depth < 16; depth++) {
    try {
      const manifest = path.join(directory, 'package.json');
      if (fs.statSync(manifest).size <= 65536) {
        const value = JSON.parse(fs.readFileSync(manifest, 'utf8'));
        if (typeof value.name === 'string') return { directory, name: value.name.toLowerCase(), value };
      }
    } catch {}
    const parent = path.dirname(directory); if (parent === directory) break; directory = parent;
  }
  return null;
}
function knownPackage(file) { return packageInfo(file)?.name || ''; }
function isMcpService(entry) {
  if (!entry || entry.startsWith('-')) return false;
  let file;
  try { file = fs.realpathSync(entry); } catch { return false; }
  // The generated Nexus stdio bridge is a service, even without an npm package.
  if (path.basename(file) === 'nexus-mcp-bridge.cjs' && path.basename(path.dirname(file)) === 'mcp-bridge' &&
      path.basename(path.dirname(path.dirname(file))) === '.nexus') {
    let fd;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      if (!fs.fstatSync(fd).isFile()) return false;
      const bytes = Buffer.alloc(256);
      const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
      if (bytes.subarray(0, count).toString('utf8').startsWith("'use strict';\n// Nexus IDE — ponte MCP para o MiniMax Code. Gerado pelo Nexus; não edite.")) return true;
    } catch {} finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  const info = packageInfo(file);
  if (!info) return false;
  const value = info.value;
  const declaredMcp = typeof value.mcpName === 'string' && value.mcpName.includes('/') ||
    typeof value.dependencies?.['@modelcontextprotocol/sdk'] === 'string' || info.name === 'mcp-remote';
  if (!declaredMcp) return false;
  const bins = typeof value.bin === 'string' ? [[info.name, value.bin]] : value.bin && typeof value.bin === 'object' ? Object.entries(value.bin) : [];
  // Only the server bin is a service: a single-bin package, or a bin named for MCP.
  // A sibling compile/build bin of the same package stays metered.
  const serverBins = bins.length === 1 ? bins : bins.filter(([name]) => /mcp/i.test(name));
  return serverBins.some(([, bin]) => {
    if (typeof bin !== 'string') return false;
    const candidate = path.resolve(info.directory, bin);
    if (!candidate.startsWith(info.directory + path.sep)) return false;
    try { return fs.realpathSync(candidate) === file; } catch { return false; }
  });
}
function moduleKind(file) {
  if (typeof file !== 'string') return null;
  let resolved = file;
  try { resolved = fs.realpathSync(file); } catch {}
  const normalized = resolved.replace(/\\/g, '/').toLowerCase();
  if (/(?:^|\/)(?:typescript|@typescript\/native-preview)(?:\/|$)/.test(normalized)) return 'typescript';
  if (/(?:^|\/)(?:vitest|@vitest\/[^/]+|jest|jest-cli|jest-runtime|@jest\/[^/]+|mocha)(?:\/|$)/.test(normalized)) return 'tests';
  if (/(?:^|\/)(?:vite|esbuild|webpack|webpack-cli|rollup|@rollup\/[^/]+|electron-forge|@electron-forge\/[^/]+)(?:\/|$)/.test(normalized)) return 'build';
  const packageName = knownPackage(resolved);
  if (packageName === 'typescript' || packageName === '@typescript/native-preview') return 'typescript';
  if (/^(?:vitest|@vitest\/|jest|jest-cli|jest-runtime|@jest\/|mocha$)/.test(packageName)) return 'tests';
  if (/^(?:vite|esbuild|webpack|webpack-cli|rollup|@rollup\/|@electron-forge\/)/.test(packageName)) return 'build';
  if (path.isAbsolute(resolved) && /\.[cm]?js$/i.test(resolved)) {
    let fd;
    try {
      fd = fs.openSync(resolved, 'r'); const bytes = Buffer.alloc(16384); const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
      const header = bytes.subarray(0, count).toString('utf8');
      if (/^\s*\/\*![\s\S]{0,1024}Copyright \(c\) Microsoft Corporation\./.test(header) && /\bvar versionMajorMinor\s*=\s*["']\d+\.\d+["']/.test(header)) return 'typescript';
    } catch {} finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  return null;
}
// Node keeps the bin link in argv[1] (`…/bin/npx`), not npm's npx-cli.js.
function launcherName(entry) {
  const name = path.basename(entry).toLowerCase();
  if (name !== 'npx' && name !== 'npm') return name;
  try { const real = path.basename(fs.realpathSync(entry)).toLowerCase(); return /^np[mx]-cli\.js$/.test(real) ? real : name; } catch { return name; }
}
// npx / npm exec run another program; that target is classified on its own.
function isDispatcher(argv) {
  const name = launcherName(argv[1] || '');
  if (!/^(?:npm-cli|npx-cli)(?:\.[cm]?js)?$/.test(name)) return false;
  if (name.startsWith('npx-cli')) return true;
  const takesValue = new Set(['--workspace', '-w', '--prefix', '--dir', '-C', '--filter', '--cache', '--userconfig', '--globalconfig']);
  for (let i = 2; i < argv.length; i++) { if (takesValue.has(argv[i])) { i++; continue; } if (!argv[i].startsWith('-')) return argv[i] === 'exec'; }
  return false;
}
function isPersistent(argv) {
  const entry = argv[1] || '', args = argv.slice(2);
  const name = launcherName(entry);
  const normalized = entry.replace(/\\/g, '/').toLowerCase();
  if (isMcpService(entry)) return true;
  if (/^(?:npm-cli|npx-cli|pnpm|yarn|bun)(?:\.[cm]?js)?$/.test(name)) {
    const values = []; const takesValue = new Set(['--workspace', '-w', '--prefix', '--dir', '-C', '--filter', '--cache', '--userconfig', '--globalconfig']);
    for (let i = 0; i < args.length; i++) { if (takesValue.has(args[i])) { i++; continue; } if (!args[i].startsWith('-')) values.push(args[i]); }
    // npx/exec dispatch another program. Keep their child-process hooks active,
    // but let the child own the finite-work reservation; an MCP child may live
    // for the whole CLI session. Explicit install/ci/run-build remain metered.
    if (name.startsWith('npx-cli') || values[0] === 'exec') return true;
    if (/^(?:run(?:-script)?\s+)?(?:dev|start)(?:\s|$)/.test(values.join(' '))) return true;
    if ((name.startsWith('npx-cli') || values[0] === 'exec') && values.includes('vite') && !values.includes('build')) return true;
  }
  if (/^(?:server|dev|serve)(?:\.[cm]?js)?$/.test(name)) return true;
  if (/(?:^|\/)vite(?:\/|\.[cm]?js$|$)/.test(normalized) || knownPackage(entry) === 'vite') return !args.includes('build');
  if (/(?:^|\/)esbuild(?:\/|$)/.test(normalized) || knownPackage(entry) === 'esbuild') return args.some((arg) => /^--(?:serve|watch)(?:=|$)/.test(arg));
  return false;
}
// F-982: classify the program each simple command runs, the way the shell
// reads it. Matching tool names anywhere in the text queued `type node`,
// `which node`, `node -v`, grep patterns, commit messages and heredoc bodies
// ("…must not make them…") behind the project's build slot for up to 300 s.
// Reading only command position must not let heavy work escape either: wrapper
// option values, xargs/find -exec, shells reading a heredoc or pipe, and
// substitutions in double quotes or unquoted heredocs all name programs too.
const KIND_ORDER = ['typescript', 'tests', 'install', 'build'];
const heavier = (a, b) => (!b ? a : !a ? b : KIND_ORDER.indexOf(b) < KIND_ORDER.indexOf(a) ? b : a);
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
// Reserved words that precede the command they run.
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', 'coproc']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const PM_VALUE_OPTIONS = new Set(['--workspace', '-w', '--prefix', '--dir', '-C', '--filter', '--cache', '--userconfig', '--globalconfig', '--package', '-p']);
// npx / pnpx / bunx run another program, like `npm exec` and `pnpm dlx`.
const PM_RUNNERS = new Set(['npx', 'pnpx', 'bunx']);
// F-1273 (revisão): pnpm/yarn/bun also run a dependency's bin by name
// (`pnpm vitest run`, `yarn jest`, `bun run tsc`); that program is measured.
const PM_BINS = new Set(['vitest', 'jest', 'mocha', 'tsc', 'tsgo', 'vite', 'webpack', 'rollup', 'esbuild', 'pytest']);
// poetry/uv/pipenv options (global or of `run`) whose value is not the command.
const PY_RUNNER_VALUE_OPTIONS = new Set(['-C', '--directory', '-P', '--project', '-p', '--python', '--with', '--with-requirements',
  '--with-editable', '--from', '--package', '--extra', '--group', '--env-file', '--index', '--index-url']);
// Wrappers run the command that follows their own options. Option letters and
// names under `values` take an argument (so it is never the program); an
// option missing from the table might, so the command stays metered.
// `operands` precede the command (timeout DURATION); `noexec` options only
// describe the command (`command -v`, `sudo -l`); xargs gives the program
// its stdin as arguments, never as a script.
const TIME = { flags: 'ahlpqvV', values: 'fo', longFlags: ['append', 'portability', 'quiet', 'verbose'], longValues: ['format', 'output'] };
const TIMEOUT = { flags: 'fpv', values: 'ks', longFlags: ['foreground', 'preserve-status', 'verbose'], longValues: ['kill-after', 'signal'], operands: 1 };
const WRAPPERS = {
  env: { flags: 'i0v', values: 'aCLPSUu',
    longFlags: ['ignore-environment', 'null', 'debug', 'block-signal', 'default-signal', 'ignore-signal', 'list-signal-handling'],
    longValues: ['argv0', 'chdir', 'split-string', 'unset'] },
  nice: { values: 'n', longValues: ['adjustment'], numeric: true },
  nohup: {},
  caffeinate: { flags: 'dimsu', values: 'tw' },
  sudo: { flags: 'ABbEeHiKklNnPSsVv', values: 'CDghpRrTtUu', noexec: 'eKlVv', longNoexec: ['edit', 'list', 'remove-timestamp', 'validate'],
    longFlags: ['askpass', 'bell', 'background', 'preserve-env', 'set-home', 'login', 'reset-timestamp', 'no-update', 'non-interactive', 'preserve-groups', 'stdin', 'shell'],
    longValues: ['close-from', 'chdir', 'group', 'host', 'prompt', 'chroot', 'role', 'command-timeout', 'type', 'other-user', 'user', 'login-class'] },
  doas: { flags: 'nsL', values: 'uC' },
  time: TIME,
  exec: { flags: 'cl', values: 'a' },
  command: { flags: 'pvV', noexec: 'vV' },
  builtin: {},
  stdbuf: { values: 'eio', longValues: ['error', 'input', 'output'] },
  timeout: TIMEOUT,
  gtimeout: TIMEOUT,
  'cross-env': {},
  xargs: { flags: '0oprtx', optional: 'eil', values: 'adEIJLnPRSs', ownStdin: true,
    longFlags: ['null', 'open-tty', 'interactive', 'no-run-if-empty', 'verbose', 'exit', 'show-limits', 'eof', 'replace', 'max-lines'],
    longValues: ['arg-file', 'delimiter', 'max-args', 'max-procs', 'max-chars', 'process-slot-var'] },
  // F-982 (second review). `dashLong`: a single-dash word longer than one
  // letter is a long option (`arch -x86_64`, `xcrun -sdk`), not letters.
  // `commandValues`: the value is a command line (`script -c`, `flock -c`);
  // `trailingCommand`: `-c CMD` may also follow the operands (`flock FILE -c`).
  arch: { dashLong: true, flags: 'c', values: 'de', noexec: 'h',
    longFlags: ['32', '64', 'i386', 'x86_64', 'x86_64h', 'arm64', 'arm64e'], longValues: ['arch'] },
  xcrun: { dashLong: true, flags: 'klnrv', noexec: 'fh',
    longFlags: ['kill-cache', 'log', 'no-cache', 'run', 'verbose'], longValues: ['sdk', 'toolchain'],
    longNoexec: ['find', 'show-sdk-path', 'show-sdk-version', 'show-sdk-build-version', 'show-sdk-platform-path', 'show-sdk-platform-version', 'show-toolchain-path'] },
  // BSD `script [-adeFkqr] [-t time] [file [command …]]`; util-linux `script [-c command] [file]`.
  script: { flags: 'adeFfkqQr', values: 'tTIOBEmo', commandValues: 'c', noexec: 'pV', operands: 1, trailingCommand: true,
    longFlags: ['append', 'flush', 'force', 'quiet', 'return', 'timing'], longCommandValues: ['command'],
    longValues: ['echo', 'log-in', 'log-out', 'log-io', 'log-timing', 'logging-format', 'output-limit'] },
  setsid: { flags: 'cfw', noexec: 'hV', longFlags: ['ctty', 'fork', 'wait'] },
  flock: { flags: 'sexnouF', values: 'wE', noexec: 'hV', operands: 1, trailingCommand: true,
    longFlags: ['shared', 'exclusive', 'unlock', 'nonblock', 'nb', 'close', 'no-fork', 'verbose'],
    longValues: ['wait', 'timeout', 'conflict-exit-code'] },
  ionice: { flags: 't', values: 'cn', noexec: 'pPuhV', longFlags: ['ignore'], longValues: ['class', 'classdata'], longNoexec: ['pid', 'pgid', 'uid'] },
  taskset: { flags: 'ac', noexec: 'phV', longFlags: ['all-tasks', 'cpu-list'], longNoexec: ['pid'], operands: 1 },
  chrt: { flags: 'abdfioRrv', values: 'TPD', noexec: 'mphV', operands: 1,
    longFlags: ['all-tasks', 'batch', 'deadline', 'fifo', 'idle', 'other', 'rr', 'reset-on-fork', 'verbose'],
    longValues: ['sched-runtime', 'sched-period', 'sched-deadline'], longNoexec: ['max', 'pid'] },
  unbuffer: { flags: 'p' },
};
// Asking a heavy tool only for its version or help starts no work. `-v` is
// the version only for these (pytest -v and ninja -v run verbosely).
const INFO_ONLY_ARGS = new Set(['--version', '--help', '-h']);
const SHORT_VERSION = new Set(['tsc', 'tsgo', '_tsc', 'vitest', 'jest', 'make', 'gradle', 'gradlew', 'mvn', 'webpack', 'rollup', 'vite']);
const infoOnly = (name, args) => args.length > 0 &&
  args.every((arg) => INFO_ONLY_ARGS.has(arg) || (arg === '-v' && SHORT_VERSION.has(name)) || (arg === '-V' && (name === 'pytest' || name === 'mocha')));
// A run-time value ($VAR, $(…), `…`) inside a word.
const DYNAMIC = '\u0000';
const MAX_NESTING = 64;
const MAX_DEPTH = 16;
const newSegment = (pipedIn = false) => ({ words: [], heredocs: [], herestrings: [], stdinFile: false, pipedIn });
/**
 * Splits a command line the way the shell reads it into simple commands
 * ({ words, heredocs, herestrings, stdinFile, pipedIn }). Quotes are removed;
 * $(…), `…`, <(…) and ${…} run their own commands (in double quotes and in
 * unquoted heredoc bodies too), which become segments of their own. A heredoc
 * body is read only after the rest of its opening line, which stays a command;
 * redirection targets never become words.
 */
function shellSegments(command) {
  const ctx = { all: [], nesting: 0 };
  lex(String(command), ctx, 'list');
  return ctx.all;
}
function lex(src, ctx, mode) {
  let i = 0;
  const pending = [];
  const nested = (fn) => { if (++ctx.nesting > MAX_NESTING) throw new Error('shell nesting too deep'); try { return fn(); } finally { ctx.nesting--; } };
  function backtick(inDouble) {
    let inner = '';
    while (i < src.length && src[i] !== '`') {
      if (src[i] === '\\' && i + 1 < src.length && ('`$\\'.includes(src[i + 1]) || (inDouble && src[i + 1] === '"'))) { inner += src[i + 1]; i += 2; continue; }
      inner += src[i++];
    }
    i++;
    nested(() => lex(inner, ctx, 'list'));
    return DYNAMIC;
  }
  function single() { const end = src.indexOf("'", i); const text = src.slice(i, end < 0 ? src.length : end); i = end < 0 ? src.length : end + 1; return text; }
  function ansi() {
    let text = '';
    while (i < src.length && src[i] !== "'") { if (src[i] === '\\' && i + 1 < src.length) { text += src[i + 1]; i += 2; } else text += src[i++]; }
    i++;
    return text;
  }
  // "…" after its opening quote, or (untilEnd) a whole unquoted heredoc body.
  function double(untilEnd = false) {
    let text = '';
    while (i < src.length) {
      const ch = src[i++];
      if (ch === '"' && !untilEnd) return text;
      if (ch === '\\' && i < src.length) {
        const next = src[i];
        if (next === '\n') i++;
        else if ('$`\\'.includes(next) || (next === '"' && !untilEnd)) { text += next; i++; } else text += ch;
        continue;
      }
      if (ch === '`') text += backtick(!untilEnd);
      else if (ch === '$') text += dollar(true);
      else text += ch;
    }
    return text;
  }
  // ${…} and $((…)): the value is run-time, nested substitutions still run.
  // Inside "…", a `'` in ${…} is a plain character.
  function expansion(close, inDouble) {
    let depth = 0;
    while (i < src.length) {
      const ch = src[i++];
      if (ch === '\\') { i++; continue; }
      if (close === '}' && ch === "'" && !inDouble) { single(); continue; }
      if (ch === '"') { double(); continue; }
      if (ch === '`') { backtick(false); continue; }
      if (ch === '$') { dollar(false); continue; }
      if (ch === (close === '}' ? '{' : '(')) { depth++; continue; }
      if (close === '}' && ch === '}') { if (depth-- === 0) return; continue; }
      if (close === '))' && ch === ')') { if (depth === 0 && src[i] === ')') { i++; return; } depth--; }
    }
  }
  function dollar(inDouble) {
    const next = src[i];
    if (next === '(' && src[i + 1] === '(') { i += 2; nested(() => expansion('))', inDouble)); return DYNAMIC; }
    if (next === '(') { i++; nested(() => list(')', ctx.all)); return DYNAMIC; }
    if (next === '{') { i++; nested(() => expansion('}', inDouble)); return DYNAMIC; }
    if (!inDouble && next === "'") { i++; return ansi(); }
    if (!inDouble && next === '"') { i++; return double(); }
    if (next !== undefined && /[A-Za-z_]/.test(next)) { while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) i++; return DYNAMIC; }
    if (next !== undefined && /[0-9@*#?$!-]/.test(next)) { i++; return DYNAMIC; }
    return '$';
  }
  function heredoc(owner, strip) {
    while (src[i] === ' ' || src[i] === '\t') i++;
    let delimiter = '', quoted = false;
    while (i < src.length && !/[\s;&|()<>]/.test(src[i])) {
      const ch = src[i++];
      if (ch === "'" || ch === '"') { quoted = true; const end = src.indexOf(ch, i); delimiter += src.slice(i, end < 0 ? src.length : end); i = end < 0 ? src.length : end + 1; }
      else if (ch === '\\') { quoted = true; if (i < src.length) delimiter += src[i++]; }
      else delimiter += ch;
    }
    pending.push({ owner, strip, delimiter, quoted });
  }
  // Bodies start after the newline that ends their opening line. Ending a body
  // early (trimmed delimiter) only exposes more lines as commands.
  function bodies() {
    while (pending.length) {
      const doc = pending.shift(); const lines = [];
      while (i < src.length) {
        let end = src.indexOf('\n', i); if (end < 0) end = src.length;
        const line = src.slice(i, end); i = Math.min(end + 1, src.length);
        const text = doc.strip ? line.replace(/^\t+/, '') : line;
        if (text.trim() === doc.delimiter) break;
        lines.push(text);
      }
      const body = lines.join('\n');
      doc.owner.heredocs.push(body);
      // An unquoted body runs its $(…) and `…` in the shell that reads it.
      if (!doc.quoted) nested(() => lex(body, ctx, 'text'));
    }
  }
  function list(stop, out) {
    let seg = newSegment(), word = null, target = null, depth = 0, cases = 0;
    const endWord = () => {
      if (word === null) return;
      if (target === 'herestring') seg.herestrings.push(word);
      else if (target === 'stdin') seg.stdinFile = true;
      else if (target === null) {
        if (!seg.words.length && word === 'case') cases++;
        if (!seg.words.length && word === 'esac' && cases > 0) cases--;
        seg.words.push(word);
      }
      word = null; target = null;
    };
    const endSegment = (piped = false) => { endWord(); target = null; if (seg.words.length) out.push(seg); seg = newSegment(piped); };
    // `2>`, `{fd}>`: the number belongs to the redirection, not to the words.
    const endWordBeforeRedirect = () => { if (word !== null && /^(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})$/.test(word)) word = null; else endWord(); };
    while (i < src.length) {
      const ch = src[i];
      if (ch === '\n') { i++; endSegment(); bodies(); continue; }
      if (ch === ' ' || ch === '\t' || ch === '\r') { i++; endWord(); continue; }
      if (ch === '#' && word === null) { while (i < src.length && src[i] !== '\n') i++; continue; }
      if (ch === ';') { i++; endSegment(); continue; }
      if (ch === '|') { i++; if (src[i] === '|') { i++; endSegment(); } else { if (src[i] === '&') i++; endSegment(true); } continue; }
      if (ch === '&') {
        if (src[i + 1] === '>') { endWord(); i += 2; if (src[i] === '>') i++; target = 'drop'; continue; }
        i++; if (src[i] === '&') i++; endSegment(); continue;
      }
      if (ch === '<' || ch === '>') {
        if (src[i + 1] === '(') { i += 2; word = (word ?? '') + DYNAMIC; nested(() => list(')', ctx.all)); continue; }
        endWordBeforeRedirect();
        if (src.startsWith('<<<', i)) { i += 3; target = 'herestring'; continue; }
        if (src.startsWith('<<', i)) { i += 2; const strip = src[i] === '-'; if (strip) i++; heredoc(seg, strip); continue; }
        i++;
        if (ch === '>' && (src[i] === '>' || src[i] === '|')) i++;
        else if (ch === '<' && src[i] === '>') i++;
        if (src[i] === '&' && /[0-9-]/.test(src[i + 1] || '')) { i++; while (/[0-9-]/.test(src[i] || '')) i++; continue; }
        if (src[i] === '&') i++;
        target = ch === '<' ? 'stdin' : 'drop';
        continue;
      }
      if (ch === '(') {
        i++;
        // name=(…) is an array: its elements are words, not a subshell.
        if (word !== null && /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=$/.test(word)) { nested(() => list(')', [])); word += DYNAMIC; continue; }
        endSegment(); depth++; continue;
      }
      if (ch === ')') {
        i++; endSegment();
        if (depth > 0) depth--;
        else if (cases > 0) continue; // `pattern)` inside case … esac
        else if (stop === ')') return;
        continue;
      }
      i++;
      if (word === null) word = '';
      if (ch === "'") word += single();
      else if (ch === '"') word += double();
      else if (ch === '\\') { if (src[i] === '\n') { i++; if (word === '') word = null; } else if (i < src.length) word += src[i++]; }
      else if (ch === '`') word += backtick(false);
      else if (ch === '$') word += dollar(false);
      else word += ch;
    }
    endSegment();
  }
  if (mode === 'text') double(true); else list(null, ctx.all);
}
const toolName = (word) => path.basename(String(word || '').replace(/\\/g, '/')).toLowerCase().replace(/\.(?:cmd|bat|exe|[cm]?js)$/, '');
const splitWords = (value) => shellSegments(value || '').flatMap((seg) => seg.words);
function wrapperKind(name, args, seg, depth) {
  const spec = WRAPPERS[name];
  let i = 0;
  for (; i < args.length; i++) {
    let arg = args[i];
    if (arg === '--') { i++; break; }
    if (arg === '-' && name === 'env') continue;
    if (arg.length < 2 || arg[0] !== '-') break;
    if (spec.numeric && /^-\d+$/.test(arg)) continue;
    if (spec.dashLong && arg.length > 2 && arg[1] !== '-') arg = '-' + arg;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('='), long = arg.slice(2, eq < 0 ? undefined : eq);
      if (long === 'help' || long === 'version' || spec.longNoexec?.includes(long)) return null;
      if (spec.longCommandValues?.includes(long)) return commandKind(String((eq < 0 ? args[++i] : arg.slice(eq + 1)) ?? ''), depth + 1);
      if (spec.longValues?.includes(long)) {
        const value = eq < 0 ? args[++i] : arg.slice(eq + 1);
        // env -S splits its value into the arguments that follow.
        if (long === 'split-string') return wrapperKind(name, [...splitWords(value), ...args.slice(i + 1)], seg, depth + 1);
        continue;
      }
      if (spec.longFlags?.includes(long)) continue;
      return 'build';
    }
    for (let k = 1; k < arg.length; k++) {
      const letter = arg[k];
      if (spec.noexec?.includes(letter)) return null;
      if (spec.flags?.includes(letter)) continue;
      if (spec.optional?.includes(letter)) break;
      const command = spec.commandValues?.includes(letter);
      if (!command && !spec.values?.includes(letter)) return 'build';
      const value = k + 1 < arg.length ? arg.slice(k + 1) : args[++i];
      if (command) return commandKind(String(value ?? ''), depth + 1);
      if (name === 'env' && letter === 'S') return wrapperKind(name, [...splitWords(value), ...args.slice(i + 1)], seg, depth + 1);
      break;
    }
  }
  let rest = args.slice(i + (spec.operands || 0));
  if (spec.trailingCommand && rest.length) {
    if (rest[0] === '-c' || rest[0] === '--command') return commandKind(String(rest[1] ?? ''), depth + 1);
    if (rest[0].startsWith('--command=')) return commandKind(rest[0].slice(10), depth + 1);
    if (rest[0] === '--') rest = rest.slice(1);
  }
  return rest.length ? wordsKind(rest, spec.ownStdin ? newSegment() : seg, depth + 1) : null;
}
// sh/bash/zsh run `-c STRING`, a script file, or the program on their stdin.
function shellKind(args, seg, depth) {
  let command = false, stdin = false, i = 0;
  for (; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--' || arg === '-') { i++; break; }
    if (arg.startsWith('--')) { if (arg === '--rcfile' || arg === '--init-file') i++; continue; }
    if (!/^[-+]./.test(arg)) break;
    if (arg[0] === '-' && arg.includes('c')) command = true;
    if (arg[0] === '-' && arg.includes('s')) stdin = true;
    if (/[oO]/.test(arg)) i++; // -o option / -O shopt name
  }
  const rest = args.slice(i);
  if (command) return rest.length ? commandKind(rest[0], depth + 1) : null;
  if (rest.length && !stdin) return null; // a script file, like ./script.sh
  const texts = [...seg.heredocs, ...seg.herestrings];
  if (texts.length) return texts.reduce((best, text) => heavier(best, commandKind(text, depth + 1)), null);
  if (seg.stdinFile) return null;
  // A pipe hands the shell a program this reader cannot see.
  return seg.pipedIn ? 'build' : null;
}
// find -exec/-execdir/-ok/-okdir run the words up to `;` or `+`.
function findKind(args, depth) {
  let best = null;
  for (let i = 0; i < args.length; i++) {
    if (!/^-(?:exec|execdir|ok|okdir)$/.test(args[i])) continue;
    const start = i + 1;
    while (i + 1 < args.length && args[i + 1] !== ';' && args[i + 1] !== '+') i++;
    best = heavier(best, wordsKind(args.slice(start, i + 1), newSegment(), depth + 1));
  }
  return best;
}
function firstValue(args) {
  for (let i = 0; i < args.length; i++) {
    if (PM_VALUE_OPTIONS.has(args[i])) { i++; continue; }
    if (args[i] === '--' || args[i].startsWith('-')) continue;
    return i;
  }
  return -1;
}
// The first word after options (and their values) that names a program.
function pyRunnerTarget(args, from) {
  for (let i = from; i < args.length; i++) {
    if (PY_RUNNER_VALUE_OPTIONS.has(args[i])) { i++; continue; }
    if (args[i] === '--') return i + 1 < args.length ? i + 1 : -1;
    if (!args[i].startsWith('-')) return i;
  }
  return -1;
}
// `python -m MOD …` runs that module like a program; `-c CODE`, a script file
// or stdin (`python3 - <<EOF`) are Python code, never a shell command line.
function pythonKind(args, seg, depth) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-' || !arg.startsWith('-')) return null;
    if (arg.startsWith('--')) continue;
    for (let k = 1; k < arg.length; k++) {
      if (!'cmWX'.includes(arg[k])) continue;
      const value = k + 1 < arg.length ? arg.slice(k + 1) : args[++i];
      if (arg[k] === 'm') return value ? wordsKind([value, ...args.slice(i + 1)], seg, depth + 1) : null;
      if (arg[k] === 'c') return null;
      break;
    }
  }
  return null;
}
// F-1273 (revisão): `node -e/-p CODE` runs inline JavaScript. A one-liner is
// not a build (as 'build' it waited up to 300 s behind tsc/vitest); code that
// names a heavy module or child_process, or is known only at run time, stays
// finite work even with NODE_OPTIONS stripped and no preload to see it (F-877).
function inlineKind(code) {
  if (typeof code !== 'string' || code.includes(DYNAMIC)) return 'build';
  const literal = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
  let best = null;
  for (let match, count = 0; (match = literal.exec(code)); count++) {
    if (count >= 64 || /^(?:node:)?child_process$/.test(match[2])) return 'build';
    best = heavier(best, moduleKind(match[2]));
  }
  return best;
}
function scriptKind(script) {
  const name = String(script || '').toLowerCase();
  if (/^(?:typecheck|check-types|tsc)(?::|$)/.test(name)) return 'typescript';
  if (/^tests?(?::|$)/.test(name)) return 'tests';
  if (/^(?:build|check|verify|lint|publish)(?::|$)/.test(name)) return 'build';
  return null;
}
function wordsKind(words, seg, depth) {
  if (depth > MAX_DEPTH) return 'build';
  let at = 0;
  while (at < words.length && (ENV_ASSIGNMENT.test(words[at]) || KEYWORDS.has(words[at]))) at++;
  return at < words.length ? programKind(at ? words.slice(at) : words, seg, depth) : null;
}
// words[0] is the program; the rest are its arguments, one word each.
function programKind(words, seg, depth) {
  const at = 0;
  const name = toolName(words[at]);
  // A program named by $VAR or $(…) is known only at run time. Native tool
  // wrappers run `builtin eval -- "$snap"` (Grok), so metering it would queue
  // every command; the eval'd user command is classified from its own text.
  if (name.includes(DYNAMIC)) return null;
  const args = words.slice(at + 1);
  if (Object.prototype.hasOwnProperty.call(WRAPPERS, name)) return wrapperKind(name, args, seg, depth);
  if (name === 'eval') return commandKind((args[0] === '--' ? args.slice(1) : args).join(' '), depth + 1);
  if (SHELLS.has(name)) return shellKind(args, seg, depth);
  if (name === 'find') return findKind(args, depth);
  // npx / pnpx / bunx / npm exec / pnpm dlx run another program: classify that one.
  const verbAt = firstValue(args);
  const verb = verbAt >= 0 ? args[verbAt].toLowerCase() : '';
  if (PM_RUNNERS.has(name) || (PACKAGE_MANAGERS.has(name) && ['exec', 'dlx', 'x'].includes(verb))) {
    const rest = PM_RUNNERS.has(name) ? args : args.slice(verbAt + 1);
    for (let k = 0; k < rest.length; k++) {
      // `npx -c 'cmd'` / `npm exec --call 'cmd'` run a command line.
      if (rest[k] === '-c' || rest[k] === '--call') return commandKind(rest[k + 1] || '', depth + 1);
      if (rest[k].startsWith('--call=')) return commandKind(rest[k].slice(7), depth + 1);
      if (PM_VALUE_OPTIONS.has(rest[k])) { k++; continue; }
      if (rest[k] === '--' || !rest[k].startsWith('-')) break;
    }
    const target = firstValue(rest);
    if (target < 0) return null;
    // `vitest@3` runs the vitest bin.
    return wordsKind([rest[target].replace(/(?!^)@[^/]*$/, ''), ...rest.slice(target + 1)], seg, depth + 1);
  } else if (PACKAGE_MANAGERS.has(name)) {
    if (/^(?:test|tests|t)$/.test(verb)) return 'tests';
    if (/^(?:ci|install|i|add)$/.test(verb)) return 'install';
    let at = verbAt;
    if (verb === 'run' || verb === 'run-script') { const script = firstValue(args.slice(verbAt + 1)); if (script < 0) return null; at = verbAt + 1 + script; }
    else if (name === 'npm' || at < 0) return null;
    const script = args[at].toLowerCase();
    return name !== 'npm' && PM_BINS.has(script) ? wordsKind(args.slice(at), seg, depth + 1) : scriptKind(script);
  }
  if (/^python(?:\d+(?:\.\d+)*)?$/.test(name)) return pythonKind(args, seg, depth);
  // `poetry|uv|pipenv run CMD …` and `uvx CMD …` run CMD in the project's env.
  if (name === 'uvx' || ['poetry', 'uv', 'pipenv'].includes(name)) {
    let at = 0;
    if (name !== 'uvx') { const verbIndex = pyRunnerTarget(args, 0); if (verbIndex < 0 || args[verbIndex] !== 'run') return null; at = verbIndex + 1; }
    const target = pyRunnerTarget(args, at);
    return target < 0 ? null : wordsKind(args.slice(target), seg, depth + 1);
  }
  if (infoOnly(name, args)) return null;
  if (name === 'tsc' || name === 'tsgo' || name === '_tsc') return 'typescript';
  if (['vitest', 'jest', 'pytest', 'mocha'].includes(name)) return 'tests';
  if (['go', 'cargo', 'dotnet'].includes(name)) {
    const sub = (args.find((arg) => !arg.startsWith('-')) || '').toLowerCase();
    if (sub === 'test') return 'tests';
    return ['build', 'check', 'install', 'publish'].includes(sub) ? 'build' : null;
  }
  if (['make', 'cmake', 'ninja', 'gradle', 'gradlew', 'mvn'].includes(name)) return 'build';
  if (name === 'vite') return args.includes('build') ? 'build' : null; // the dev server is persistent
  if (name === 'esbuild') return args.some((arg) => /^--(?:serve|watch)(?:=|$)/.test(arg)) ? null : 'build';
  if (name === 'webpack' || name === 'rollup') return 'build';
  if (name === 'node') {
    const real = args.filter((arg) => arg !== '--');
    if (real.length > 0 && real.every((arg) => /^(?:-v|--version|-h|--help)$/.test(arg))) return null;
    const scriptAt = real.findIndex((arg) => !arg.startsWith('-'));
    const evalAt = real.slice(0, scriptAt < 0 ? real.length : scriptAt).findIndex((arg) => /^(?:-[ep]|-pe|--eval|--print)(?:=|$)/.test(arg));
    if (evalAt >= 0) { const eq = real[evalAt].indexOf('='); return inlineKind(eq < 0 ? real[evalAt + 1] : real[evalAt].slice(eq + 1)); }
    const script = scriptAt >= 0 ? real[scriptAt] : undefined;
    // Dev servers, watchers and MCP services are persistent, not finite work.
    if (script && isPersistent([words[at], script, ...real.slice(scriptAt + 1)])) return null;
    return (script && moduleKind(script)) || 'build';
  }
  return null;
}
function commandKind(command, depth = 0) {
  if (typeof command !== 'string') return null;
  if (command.length > 16384 || depth > MAX_DEPTH) return 'build';
  try {
    let best = null;
    for (const seg of shellSegments(command)) best = heavier(best, wordsKind(seg.words, seg, depth));
    return best;
  } catch {
    return 'build'; // unreadable (too deeply nested): keep it metered
  }
}
// F-1229: `cd <dir> && …` wrapped whole as one job asks for admission before
// its cd runs. The literal first-command target names where the work happens;
// Main still accepts it only as this repository's checkout/worktree.
function leadingCd(command) {
  try {
    const words = shellSegments(String(command))[0]?.words;
    const dir = words?.length === 2 && words[0] === 'cd' ? words[1] : '';
    return dir && !dir.includes(DYNAMIC) && !/^[~-]/.test(dir) ? dir : null;
  } catch { return null; }
}
// F-982 (second review): an exec/spawn argv never went through a shell. Joining
// it and re-reading the text as shell turned a `|` or newline inside one
// argument (`rg -e 'a|vitest'`, a commit message with "\nmake …") into another
// command. Each element is one word; only an explicit shell reads text.
function argvKind(argv) {
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((word) => typeof word === 'string')) return null;
  try { return programKind(argv, newSegment(), 0); } catch { return 'build'; }
}
function entryKind(argv) {
  if (isPersistent(argv)) return null;
  const entry = argv[1] || '';
  const name = launcherName(entry).replace(/\.(?:[cm]?js|exe)$/, '');
  if (/^(?:npm-cli|npx-cli|pnpm|yarn|bun)$/.test(name) || /[\\/]node_modules[\\/](?:npm|pnpm|yarn)[\\/]/i.test(entry)) {
    const values = [];
    const takesValue = new Set(['--workspace', '-w', '--prefix', '--dir', '-C', '--filter', '--cache', '--userconfig', '--globalconfig']);
    for (let i = 2; i < argv.length; i++) {
      const token = argv[i];
      if (takesValue.has(token)) { i++; continue; }
      if (token.startsWith('-')) continue;
      values.push(token);
    }
    const args = values.join(' ');
    if (/^(?:ci|install|add)(?:\s|$)/.test(args)) return 'install';
    if (/^(?:run\s+)?tests?(?:\s|$|:)/.test(args)) return 'tests';
    if (/^(?:run\s+)?(?:typecheck|tsc)(?:\s|$|:)/.test(args)) return 'typescript';
    if (/^run(?:-script)?(?:\s|$)/.test(args) && !/^run(?:-script)?\s+(?:dev|start)(?:\s|$)/.test(args)) return 'build';
    if (name === 'npx-cli' || values[0] === 'exec') return commandKind(args) || 'build';
    return null;
  }
  return moduleKind(entry) || commandKind(name);
}
// The Node launcher of an agent CLI (e.g. @openai/codex/bin/codex.js) execs its
// own package's native engine with the whole prompt in argv. That child IS the
// agent session, not finite work: classifying it by prompt text ("typecheck",
// "node", >16 KB) held the project's heavy slot for the session's lifetime.
function isAgentEngine(file, entry, self) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || !entry || !self || !path.isAbsolute(entry)) return false;
  try {
    const realEntry = fs.realpathSync(entry);
    if (fs.realpathSync(self) !== realEntry) return false;
    const root = packageInfo(realEntry)?.directory;
    const target = fs.realpathSync(file);
    return Boolean(root) && target.startsWith(root + path.sep) && fs.statSync(target).isFile();
  } catch { return false; }
}
module.exports = { moduleKind, entryKind, commandKind, argvKind, leadingCd, isPersistent, isDispatcher, isAgentEngine };
