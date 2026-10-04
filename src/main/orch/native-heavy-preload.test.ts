import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { appendHeavyCommandPreload, heavyCommandShellEnvironment, stripInheritedHeavyCommandEnvironment } from './native-heavy-preload';
it('preserves existing NODE_OPTIONS and quotes resource paths with spaces', () => {
 expect(appendHeavyCommandPreload('--max-old-space-size=256', '/tmp/Application Support/preload.cjs')).toBe('--max-old-space-size=256 --require "/tmp/Application Support/preload.cjs"');
});
it('does not intercept outside-mission operator Node processes', () => {
 const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: appendHeavyCommandPreload('--max-old-space-size=256', path.join(process.cwd(), 'resources/heavy-command/preload.cjs')) };
 delete env.NEXUS_MISSION_ID; delete env.NEXUS_HEAVY_COMMAND_URL;
 const result = spawnSync(process.execPath, ['-e', 'console.log("operator-unmodified")'], { env, encoding: 'utf8' });
 expect(result.status).toBe(0); expect(result.stdout.trim()).toBe('operator-unmodified'); expect(result.stderr).toBe('');
});
it('worker threads inherit the scoped preload but never request a second compiler lease', () => {
 const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: appendHeavyCommandPreload('--max-old-space-size=256', path.join(process.cwd(), 'resources/heavy-command/preload.cjs')), NEXUS_MISSION_ID: 'finite', NEXUS_GATE_TOKEN: 'finite', NEXUS_HEAVY_COMMAND_URL: 'http://127.0.0.1:1/hook/heavy-command' };
 const result = spawnSync(process.execPath, ['-e', 'const {Worker}=require("node:worker_threads");new Worker("require(\\"node:worker_threads\\").parentPort.postMessage(\\"thread-ok\\")",{eval:true}).on("message",console.log)'], { env, encoding: 'utf8' });
 expect(result.status).toBe(0); expect(result.stdout.trim()).toBe('thread-ok'); expect(result.stderr).toBe('');
});


it.each([
 ['vitest/vitest.mjs', 'tests'], ['jest/bin/jest.js', 'tests'], ['vite/bin/renamed.cjs', 'build'],
 ['esbuild/bin/esbuild', 'build'], ['webpack/bin/webpack.js', 'build'], ['rollup/dist/bin/rollup', 'build'],
 ['npm/bin/npm-cli.js', 'install'],
])('blocks %s before its program loads when admission is unavailable', (entry, kind) => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-preexec-'));
 const file = path.join(root, 'node_modules', entry); fs.mkdirSync(path.dirname(file), { recursive: true });
 const marker = path.join(root, 'loaded'); fs.writeFileSync(file, file.endsWith('.mjs') ? `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'loaded')` : `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'loaded')`);
 const env = { ...process.env, NODE_OPTIONS: appendHeavyCommandPreload(undefined, path.join(process.cwd(), 'resources/heavy-command/preload.cjs')),
   NEXUS_GATE_TOKEN: 'finite', NEXUS_HEAVY_COMMAND_URL: 'http://127.0.0.1:1/hook/heavy-command' };
 const result = spawnSync(process.execPath, [file, ...(kind === 'install' ? ['install'] : [])], { env, encoding: 'utf8' });
 try { expect(result.status).toBe(78); expect(fs.existsSync(marker)).toBe(false); }
 finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 10_000);

it('blocks an internal TypeScript require before compiler work even under node eval', () => {
 const env = { ...process.env, NODE_OPTIONS: appendHeavyCommandPreload(undefined, path.join(process.cwd(), 'resources/heavy-command/preload.cjs')),
   NEXUS_GATE_TOKEN: 'finite', NEXUS_HEAVY_COMMAND_URL: 'http://127.0.0.1:1/hook/heavy-command' };
 const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(process.cwd(), 'node_modules/typescript'))});console.log('compiler-loaded')`], { env, encoding: 'utf8' });
 expect(result.status).toBe(78); expect(result.stdout).not.toContain('compiler-loaded');
}, 10_000);

it('rejects a remote helper URL before sending its bearer token', async () => {
 let requests = 0; const server = http.createServer((_req, res) => { requests++; res.end('{}'); });
 await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
 const { port } = server.address() as { port: number };
 const env = { ...process.env, NEXUS_HEAVY_COMMAND_URL: `http://localhost:${port}/hook/heavy-command`, NEXUS_GATE_TOKEN: 'finite-secret' };
 try {
   const result = await new Promise<number | null>((resolve) => { const child = spawn(process.execPath, [path.join(process.cwd(), 'resources/heavy-command/request.cjs'), String(process.pid), 'build'], { env, stdio: 'ignore' }); child.once('close', resolve); });
   expect(result).toBe(78); expect(requests).toBe(0);
 } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

it('Main canonicalizes scoped shell resources and strips them from human shells', () => {
 const directory = path.join(process.cwd(), 'resources/heavy-command');
 const scoped = heavyCommandShellEnvironment({ PATH: path.dirname(process.execPath), HOME: '/finite/operator', BASH_ENV: '/finite/original-env', ZDOTDIR: '/finite/original-zdot' }, path.join(directory, 'preload.cjs'));
 expect(scoped.NEXUS_HEAVY_BASH_ENV).toBe(path.join(directory, 'shell.bash'));
 expect(scoped.BASH_ENV).toBe(path.join(directory, 'shell.bash'));
 expect(scoped.NEXUS_HEAVY_NODE).toBe(fs.realpathSync(process.execPath));
 expect(scoped.NEXUS_HEAVY_ORIG_BASH_ENV).toBe('/finite/original-env');
 const human: Record<string, string> = { ...scoped, NEXUS_HEAVY_COMMAND_URL: 'http://127.0.0.1:1/hook/heavy-command', NEXUS_HEAVY_LEASE: 'forged' };
 stripInheritedHeavyCommandEnvironment(human);
 expect(human.BASH_ENV).toBeUndefined(); expect(human.ZDOTDIR).toBe('/finite/original-zdot');
 expect(Object.keys(human).some((key) => key.startsWith('NEXUS_HEAVY_'))).toBe(false);
});


it('a scoped Node agent cannot strip NODE_OPTIONS from a TypeScript child before exec', () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-stripped-child-'));
 const file = path.join(root, 'node_modules/typescript/bin/renamed.cjs'); fs.mkdirSync(path.dirname(file), { recursive: true });
 const marker = path.join(root, 'loaded'); fs.writeFileSync(file, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'loaded')`);
 const env = { ...process.env, NODE_OPTIONS: appendHeavyCommandPreload(undefined, path.join(process.cwd(), 'resources/heavy-command/preload.cjs')),
   NEXUS_GATE_TOKEN: 'finite', NEXUS_HEAVY_COMMAND_URL: 'http://127.0.0.1:1/hook/heavy-command' };
 const script = `const child=require('node:child_process').spawnSync(process.execPath,[${JSON.stringify(file)}],{env:{...process.env,NODE_OPTIONS:''},encoding:'utf8'});console.log('child-status='+child.status)`;
 const result = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8' });
 try { expect(result.status).toBe(0); expect(result.stdout.trim()).toBe('child-status=78'); expect(fs.existsSync(marker)).toBe(false); }
 finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 10_000);


it('the Main-proved Node AI entry can boot with compiler dependencies while its command child remains admitted', () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-agent-root-'));
 const entry = path.join(root, 'finite-ai.cjs');
 const typescript = path.join(process.cwd(), 'node_modules/typescript');
 fs.writeFileSync(entry, `require(${JSON.stringify(typescript)});console.log('ai-booted');const child=require('node:child_process').spawnSync(process.execPath,['-e',${JSON.stringify(`require(${JSON.stringify(typescript)});console.log('command-loaded')`)}],{encoding:'utf8'});console.log('command-status='+child.status)`);
 const env = { ...process.env, NODE_OPTIONS: appendHeavyCommandPreload(undefined, path.join(process.cwd(), 'resources/heavy-command/preload.cjs')),
   NEXUS_HEAVY_AGENT_ENTRY: entry, NEXUS_GATE_TOKEN: 'finite', NEXUS_HEAVY_COMMAND_URL: 'http://127.0.0.1:1/hook/heavy-command' };
 try { const result = spawnSync(process.execPath, [entry], { env, encoding: 'utf8' });
   expect(result.status).toBe(0); expect(result.stdout.trim()).toBe('ai-booted\ncommand-status=78'); }
 finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 10_000);


it('a copied and renamed standalone TypeScript compiler is admitted before its code loads', () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-renamed-compiler-'));
 const entry = path.join(root, 'renamed.cjs'); fs.copyFileSync(path.join(process.cwd(), 'node_modules/typescript/lib/_tsc.js'), entry);
 const env = { ...process.env, NODE_OPTIONS: appendHeavyCommandPreload(undefined, path.join(process.cwd(), 'resources/heavy-command/preload.cjs')),
   NEXUS_GATE_TOKEN: 'finite', NEXUS_HEAVY_COMMAND_URL: 'http://127.0.0.1:1/hook/heavy-command' };
 try { const result = spawnSync(process.execPath, [entry, '--version'], { env, encoding: 'utf8' }); expect(result.status).toBe(78); expect(result.stdout).toBe(''); }
 finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 10_000);
