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
function commandKind(command) {
  if (typeof command !== 'string') return null;
  if (command.length > 16384) return 'build';
  const evaluation = /(?:^|[\s/\\'\";&|])node(?:\.exe)?[\s'\"][^;&|]*?[\s'\"](?:-e|--eval|-p|--print)(?:[\s'\"=]|$)/i.test(command);
  if (!evaluation && /(?:^|[\s/\\'\";&|])vite(?:\.[cm]?js)?(?=$|[\s'\";&|])/i.test(command) && !/\bvite(?:\.[cm]?js)?[\s'\"]+build\b/i.test(command)) return null;
  if (!evaluation && /(?:^|[\s/\\'\";&|])esbuild(?=$|[\s'\";&|])/i.test(command) && /--(?:serve|watch)(?:=|\s|$)/.test(command)) return null;
  if (/\bnode(?:\.exe)?[\s'\"][^;&|]*?(?:^|[\s/\\'\"])(?:server|dev|serve)\.[cm]?js(?=$|[\s'\";&|])/i.test(command)) return null;
  if (/(?:^|[\s/\\'";&|])(?:tsc(?:\.[cm]?js)?|tsgo|typecheck)(?=$|[\s'";&|:])/i.test(command)) return 'typescript';
  if (/(?:^|[\s/\\'";&|])(?:vitest|jest|pytest|mocha)(?=$|[\s'";&|])/i.test(command) || /\b(?:npm|pnpm|yarn|bun|go|cargo|dotnet)\s+(?:run\s+)?tests?(?=$|[\s'";&|:])/i.test(command)) return 'tests';
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:ci|install|add)(?=$|[\s'";&|])/i.test(command)) return 'install';
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|check|verify|lint)(?=$|[\s'";&|:])/i.test(command) || /\b(?:cargo|go|dotnet)\s+(?:build|check|install|publish)(?=$|[\s'";&|])/i.test(command) || /(?:^|[\s/\\'";&|])(?:vite|esbuild|webpack|rollup|make|cmake|ninja|gradle|mvn)(?=$|[\s'";&|])/i.test(command)) return 'build';
  if (/(?:^|[\s/\\'\";&|])node(?:\.exe)?(?=$|[\s'\";&|])/i.test(command)) return 'build';
  return null;
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
module.exports = { moduleKind, entryKind, commandKind, isPersistent, isDispatcher, isAgentEngine };
