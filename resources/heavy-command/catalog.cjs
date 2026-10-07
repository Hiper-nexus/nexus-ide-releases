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
// F-956: classify the program each simple command runs, the way the shell
// reads it. Matching tool names anywhere in the text queued `type node`,
// `which node`, `node -v`, grep patterns, commit messages and heredoc bodies
// ("…must not make them…") behind the project's build slot for up to 300 s.
const KIND_ORDER = ['typescript', 'tests', 'install', 'build'];
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
// Shell keywords and wrappers precede the program that actually runs.
const COMMAND_PREFIXES = new Set(['time', 'exec', 'command', 'nohup', 'env', 'caffeinate', 'nice', 'sudo',
  'if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{']);
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const PM_VALUE_OPTIONS = new Set(['--workspace', '-w', '--prefix', '--dir', '-C', '--filter', '--cache', '--userconfig', '--globalconfig', '--package', '-p']);
function stripHeredocBodies(command) {
  return command.replace(/<<-?[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, '\n');
}
/** Unquoted-operator split into simple commands; quotes are removed from words. */
function shellSegments(command) {
  const segments = []; let words = []; let word = ''; let inWord = false; let quote = '';
  const endWord = () => { if (inWord) words.push(word); word = ''; inWord = false; };
  const endSegment = () => { endWord(); if (words.length) segments.push(words); words = []; };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = '';
      else if (ch === '\\' && quote === '"' && i + 1 < command.length) word += command[++i];
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; inWord = true; continue; }
    if (ch === '\\' && i + 1 < command.length) { const next = command[++i]; if (next !== '\n') { word += next; inWord = true; } continue; }
    if (ch === '#' && !inWord) { while (i + 1 < command.length && command[i + 1] !== '\n') i++; continue; }
    if (ch === '\n') { endSegment(); continue; }
    if (/\s/.test(ch)) { endWord(); continue; }
    if (';&|()`'.includes(ch)) { endSegment(); continue; }
    if (ch === '$' && command[i + 1] === '(') { endSegment(); i++; continue; }
    word += ch; inWord = true;
  }
  endSegment();
  return segments;
}
const toolName = (word) => path.basename(String(word || '').replace(/\\/g, '/')).toLowerCase().replace(/\.(?:cmd|bat|exe|[cm]?js)$/, '');
function programIndex(words, start = 0) {
  let i = start;
  while (i < words.length) {
    const name = toolName(words[i]);
    if (ENV_ASSIGNMENT.test(words[i]) || COMMAND_PREFIXES.has(name)) { i++; while (i < words.length && words[i].startsWith('-')) i++; continue; }
    if (name === 'timeout' || name === 'gtimeout') { i++; while (i < words.length && words[i].startsWith('-')) i++; i++; continue; }
    return i;
  }
  return i;
}
function firstValue(args) {
  for (let i = 0; i < args.length; i++) {
    if (PM_VALUE_OPTIONS.has(args[i])) { i++; continue; }
    if (args[i] === '--' || args[i].startsWith('-')) continue;
    return i;
  }
  return -1;
}
function scriptKind(script) {
  const name = String(script || '').toLowerCase();
  if (/^(?:typecheck|check-types|tsc)(?::|$)/.test(name)) return 'typescript';
  if (/^tests?(?::|$)/.test(name)) return 'tests';
  if (/^(?:build|check|verify|lint|publish)(?::|$)/.test(name)) return 'build';
  return null;
}
function segmentKind(words) {
  let at = programIndex(words);
  if (at >= words.length) return null;
  let name = toolName(words[at]);
  let args = words.slice(at + 1);
  // npx / bunx / npm exec / pnpm dlx run another program: classify that one.
  const verbAt = firstValue(args);
  const verb = verbAt >= 0 ? args[verbAt].toLowerCase() : '';
  if (name === 'npx' || name === 'bunx' || (PACKAGE_MANAGERS.has(name) && ['exec', 'dlx', 'x'].includes(verb))) {
    const rest = name === 'npx' || name === 'bunx' ? args : args.slice(verbAt + 1);
    const target = firstValue(rest);
    if (target < 0) return null;
    name = toolName(rest[target]); args = rest.slice(target + 1);
  } else if (PACKAGE_MANAGERS.has(name)) {
    if (/^(?:test|tests|t)$/.test(verb)) return 'tests';
    if (/^(?:ci|install|i|add)$/.test(verb)) return 'install';
    if (verb === 'run' || verb === 'run-script') { const script = firstValue(args.slice(verbAt + 1)); return script < 0 ? null : scriptKind(args.slice(verbAt + 1)[script]); }
    return name === 'npm' ? null : scriptKind(verb);
  }
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
    const script = scriptAt >= 0 ? real[scriptAt] : undefined;
    // Dev servers, watchers and MCP services are persistent, not finite work.
    if (script && isPersistent([words[at], script, ...real.slice(scriptAt + 1)])) return null;
    return (script && moduleKind(script)) || 'build';
  }
  // `sh -c "…"` runs a whole command line: classify that line.
  if (['sh', 'bash', 'zsh', 'dash'].includes(name)) {
    const flagAt = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
    if (flagAt >= 0 && flagAt + 1 < args.length) return commandKind(args[flagAt + 1]);
  }
  return null;
}
function commandKind(command) {
  if (typeof command !== 'string') return null;
  if (command.length > 16384) return 'build';
  let best = null;
  for (const words of shellSegments(stripHeredocBodies(command))) {
    const kind = segmentKind(words);
    if (kind && (best === null || KIND_ORDER.indexOf(kind) < KIND_ORDER.indexOf(best))) best = kind;
  }
  return best;
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
module.exports = { moduleKind, entryKind, commandKind, isPersistent, isDispatcher };
