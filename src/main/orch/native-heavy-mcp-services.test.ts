import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { afterAll, expect, it } from 'vitest';
const require = createRequire(import.meta.url);
const catalog = require('../../../resources/heavy-command/catalog.cjs') as {
  isPersistent(argv: string[]): boolean;
  entryKind(argv: string[]): string | null;
};
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-mcp-services-'));
function executable(name: string, metadata: Record<string, unknown>) {
  const dir = path.join(root, name.replaceAll('/', '-'));
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, bin: { server: 'bin/service.js' }, ...metadata }));
  const entry = path.join(dir, 'bin/service.js');
  fs.writeFileSync(entry, 'process.stdin.resume();');
  return entry;
}
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

it('recognizes a declared MCP registry binary as a persistent service', () => {
  const entry = executable('@playwright/mcp', { mcpName: 'io.github.microsoft/playwright-mcp' });
  expect(catalog.isPersistent([process.execPath, entry])).toBe(true);
  expect(catalog.entryKind([process.execPath, entry])).toBeNull();
});
it('recognizes an SDK-backed declared MCP binary, without exempting its build scripts', () => {
  const entry = executable('custom-mcp-service', { dependencies: { '@modelcontextprotocol/sdk': '1.0.0' } });
  expect(catalog.isPersistent([process.execPath, entry])).toBe(true);
  const build = path.join(path.dirname(entry), 'compile.js');
  fs.writeFileSync(build, 'console.log("finite build");');
  expect(catalog.isPersistent([process.execPath, build])).toBe(false);
});
it('exempts only the server bin of a multi-bin MCP package, never its build bin', () => {
  const dir = path.join(root, 'multi-bin-mcp');
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'acme-tools', dependencies: { '@modelcontextprotocol/sdk': '1.0.0' },
    bin: { 'acme-mcp': 'bin/stdio.js', 'acme-compile': 'bin/compile.js' } }));
  for (const file of ['stdio.js', 'compile.js']) fs.writeFileSync(path.join(dir, 'bin', file), '');
  expect(catalog.isPersistent([process.execPath, path.join(dir, 'bin/stdio.js')])).toBe(true);
  expect(catalog.isPersistent([process.execPath, path.join(dir, 'bin/compile.js')])).toBe(false);
});
it('keeps the legacy MCP remote proxy persistent even with its SDK bundled', () => {
  const entry = executable('mcp-remote', {});
  expect(catalog.isPersistent([process.execPath, entry])).toBe(true);
});
it('does not classify an arbitrary package binary as a persistent MCP service', () => {
  const entry = executable('ordinary-build-tool', {});
  expect(catalog.isPersistent([process.execPath, entry])).toBe(false);
});
it('treats npx and npm exec as dispatchers whose children retain instrumentation', () => {
  expect(catalog.isPersistent([process.execPath, '/npm/bin/npx-cli.js', '-y', '@playwright/mcp@latest'])).toBe(true);
  expect(catalog.isPersistent([process.execPath, '/npm/bin/npm-cli.js', 'exec', '--', 'tsc', '--noEmit'])).toBe(true);
  expect(catalog.entryKind([process.execPath, '/npm/bin/npm-cli.js', 'ci'])).toBe('install');
  expect(catalog.entryKind([process.execPath, '/npm/bin/npm-cli.js', 'run', 'build'])).toBe('build');
});
it('resolves npx/npm bin symlinks to the dispatcher, as Node keeps the link in argv[1]', () => {
  const bin = path.join(root, 'prefix/bin'), cli = path.join(root, 'prefix/lib/node_modules/npm/bin');
  fs.mkdirSync(bin, { recursive: true }); fs.mkdirSync(cli, { recursive: true });
  for (const name of ['npx', 'npm']) {
    fs.writeFileSync(path.join(cli, `${name}-cli.js`), '');
    fs.symlinkSync(path.join(cli, `${name}-cli.js`), path.join(bin, name));
  }
  // Native-HOME Devin startup: `node …/bin/npx -y mcp-remote <url>` held the only build permit.
  expect(catalog.isPersistent([process.execPath, path.join(bin, 'npx'), '-y', 'mcp-remote', 'https://example.invalid/mcp'])).toBe(true);
  expect(catalog.isPersistent([process.execPath, path.join(bin, 'npm'), 'exec', '--', 'tsc'])).toBe(true);
  expect(catalog.entryKind([process.execPath, path.join(bin, 'npm'), 'ci'])).toBe('install');
  expect(catalog.entryKind([process.execPath, path.join(bin, 'npm'), 'run', 'typecheck'])).toBe('typescript');
  // A program merely called npx is not npm's dispatcher.
  const impostor = path.join(root, 'other/npx');
  fs.mkdirSync(path.dirname(impostor), { recursive: true }); fs.writeFileSync(impostor, '');
  expect(catalog.isPersistent([process.execPath, impostor, '-y', 'anything'])).toBe(false);
});
it('starts the actual generated Nexus bridge without taking the finite command slot', async () => {
  const { ensureNexusMcpBridgeScript } = await import('./cli-mcp-session-minimax');
  const bridge = ensureNexusMcpBridgeScript(path.join(root, 'bridge-home'));
  const child = spawnSync(process.execPath, [bridge], {
    env: {
      PATH: process.env.PATH, HOME: root,
      NODE_OPTIONS: `--require ${JSON.stringify(path.join(process.cwd(), 'resources/heavy-command/preload.cjs'))}`,
      NEXUS_HEAVY_COMMAND_URL: 'http://127.0.0.1:1/hook/heavy-command',
      NEXUS_GATE_TOKEN: 'private-service-fixture',
      // An attempt to enter the command launcher must fail. A service needs
      // neither a command lease nor that launcher to answer MCP initialization.
      NEXUS_HEAVY_JOB_BASE: JSON.stringify({ file: '/usr/bin/perl', args: ['heavy-job'] }),
    },
    input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n',
    encoding: 'utf8', timeout: 5000,
  });
  expect(child.status, child.stderr).toBe(0);
  expect(JSON.parse(child.stdout.trim()).result.serverInfo.name).toBe('nexus');
});
it('does not exempt a file merely named like the Nexus bridge', () => {
  const file = path.join(root, 'not-nexus', 'nexus-mcp-bridge.cjs');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'console.log("finite work");');
  expect(catalog.isPersistent([process.execPath, file])).toBe(false);
});
it('still blocks compiler children of a package dispatcher when Main admission is unavailable', () => {
  const base = path.join(root, 'dispatcher');
  const launcher = path.join(base, 'node_modules/npm/bin/npx-cli.js');
  const compiler = path.join(base, 'node_modules/typescript/bin/tsc');
  const marker = path.join(base, 'compiler-ran');
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.mkdirSync(path.dirname(compiler), { recursive: true });
  fs.writeFileSync(compiler, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected')`);
  fs.writeFileSync(launcher, `
    const result = require('node:child_process').spawnSync(process.execPath, [${JSON.stringify(compiler)}], { encoding: 'utf8' });
    process.stdout.write(JSON.stringify({ childStatus: result.status }));
  `);
  const child = spawnSync(process.execPath, [launcher, 'private-command'], {
    env: { PATH: process.env.PATH, HOME: root,
      NODE_OPTIONS: `--require ${JSON.stringify(path.join(process.cwd(), 'resources/heavy-command/preload.cjs'))}`,
      NEXUS_HEAVY_COMMAND_URL: 'http://127.0.0.1:1/hook/heavy-command', NEXUS_GATE_TOKEN: 'private-dispatcher',
    }, encoding: 'utf8', timeout: 5000,
  });
  expect(child.status, child.stderr).toBe(0);
  expect(JSON.parse(child.stdout).childStatus).toBe(78);
  expect(fs.existsSync(marker)).toBe(false);
});
it('meters an unknown finite child of an exempt dispatcher even without the Darwin job base', () => {
  // Linux/Windows have no NEXUS_HEAVY_JOB_BASE fallback: `npx eslint .` must still queue.
  const base = path.join(root, 'dispatcher-unknown');
  const launcher = path.join(base, 'node_modules/npm/bin/npx-cli.js');
  const tool = path.join(base, 'node_modules/lint-tool/bin/lint.js');
  const marker = path.join(base, 'tool-ran'), grandchildMarker = path.join(base, 'grandchild-ran');
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.mkdirSync(path.dirname(tool), { recursive: true });
  fs.writeFileSync(path.join(base, 'node_modules/lint-tool/package.json'), JSON.stringify({ name: 'lint-tool', bin: { lint: 'bin/lint.js' } }));
  fs.writeFileSync(tool, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected')`);
  fs.writeFileSync(launcher, `
    const result = require('node:child_process').spawnSync(process.execPath, [${JSON.stringify(tool)}], { encoding: 'utf8' });
    process.stdout.write(JSON.stringify({ childStatus: result.status }));
  `);
  const env = { PATH: process.env.PATH, HOME: root,
    NODE_OPTIONS: `--require ${JSON.stringify(path.join(process.cwd(), 'resources/heavy-command/preload.cjs'))}`,
    NEXUS_HEAVY_COMMAND_URL: 'http://127.0.0.1:1/hook/heavy-command', NEXUS_GATE_TOKEN: 'private-dispatcher' };
  const child = spawnSync(process.execPath, [launcher, 'lint-tool'], { env, encoding: 'utf8', timeout: 5000 });
  expect(child.status, child.stderr).toBe(0);
  expect(JSON.parse(child.stdout).childStatus).toBe(78);
  expect(fs.existsSync(marker)).toBe(false);
  // The mark covers the dispatcher's direct target only: a persistent service's
  // own unknown helpers do not inherit it (no permit held for a service's life).
  const serviceLauncher = path.join(base, 'service/node_modules/npm/bin/npx-cli.js');
  const server = path.join(base, 'service/server.js'), helper = path.join(base, 'service/helper.js');
  fs.mkdirSync(path.dirname(serviceLauncher), { recursive: true });
  fs.writeFileSync(serviceLauncher, `process.exit(require('node:child_process').spawnSync(process.execPath, [${JSON.stringify(server)}]).status);`);
  fs.writeFileSync(server, `process.exit(require('node:child_process').spawnSync(process.execPath, [${JSON.stringify(helper)}]).status);`);
  fs.writeFileSync(helper, `require('node:fs').writeFileSync(${JSON.stringify(grandchildMarker)}, 'ran')`);
  const nested = spawnSync(process.execPath, [serviceLauncher, 'svc'], { env, encoding: 'utf8', timeout: 5000 });
  expect(nested.status, nested.stderr).toBe(0);
  expect(fs.existsSync(grandchildMarker)).toBe(true);
});
