import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { appendHeavyCommandPreload, heavyCommandShellEnvironment, stripInheritedHeavyCommandEnvironment, selectGrokHeavyShell } from './native-heavy-preload';
it('preserves existing NODE_OPTIONS and quotes resource paths with spaces', () => {
 expect(appendHeavyCommandPreload('--max-old-space-size=256', '/tmp/Application Support/preload.cjs')).toBe('--max-old-space-size=256 --require "/tmp/Application Support/preload.cjs"');
});
it.runIf(fs.existsSync('/Users/cleofaspereirarocha/.npm-global/lib/node_modules/@minimax-ai/code/chunks/chunk-S6GSNWAM.js'))('recognizes only the measured MiniMax IPC guardian and leaves heavy evals admitted', () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-sdk-control-'));
 const entry = path.join(root, 'cli.js'); fs.writeFileSync(entry, ''); fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@minimax-ai/code', version: '0.5.5' }));
 const sdk = fs.readFileSync('/Users/cleofaspereirarocha/.npm-global/lib/node_modules/@minimax-ai/code/chunks/chunk-S6GSNWAM.js', 'utf8');
 const source = /ej=String\.raw`([\s\S]*?)`/.exec(sdk)![1];
 const control = createRequire(import.meta.url)(path.join(process.cwd(), 'resources/heavy-command/sdk-control.cjs'));
 const args = ['--input-type=module', '--eval', source, String(process.pid), '3000', 'finite-sdk-lease'];
 const options = { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true, env: {} };
 try {
  expect(control(process.execPath, args, options, entry)).toBe(true); expect(options.env).toEqual({});
  expect(control(process.execPath, [...args.slice(0, 2), source + '\nawait import("typescript");', ...args.slice(3)], options, entry)).toBe(false);
  expect(control(process.execPath, args, { ...options, stdio: ['ignore', 'ignore', 'ignore'] }, entry)).toBe(false);
  expect(control(process.execPath, args, options, undefined)).toBe(false);
  expect(control(process.execPath, args, { ...options, env: { NODE_OPTIONS: '--require ./finite-private.cjs' } }, entry)).toBe(false);
  expect(control(process.execPath, args, { ...options, env: { DYLD_INSERT_LIBRARIES: '/own/foreign.dylib' } }, entry)).toBe(false);
  expect(control(process.execPath, args, { ...options, env: undefined }, entry)).toBe(false);
  expect(control(process.execPath, args, { ...options, env: { ELECTRON_RUN_AS_NODE: '1' } }, entry)).toBe(Boolean(process.versions.electron));
  expect(control(process.execPath, args, { ...options, shell: true }, entry)).toBe(false);
  expect(control(process.execPath, args, { ...options, shell: '/bin/sh' }, entry)).toBe(false);
  expect(control(process.execPath, args, { ...options, shell: false }, entry)).toBe(true);
  expect(control(path.join(root, 'node'), args, options, entry)).toBe(false);
  expect(control('node', args, options, entry)).toBe(false);
  expect(control(process.execPath, args, { ...options, argv0: 'foreign' }, entry)).toBe(false);
  expect(control(process.execPath, args, { ...options, windowsHide: 'foreign' }, entry)).toBe(false);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'unrelated', version: '0.5.5' })); expect(control(process.execPath, args, options, entry)).toBe(false);
 } finally { fs.rmSync(root, { recursive: true, force: true }); }
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
 const result = spawnSync(process.execPath, [file, ...(kind === 'install' ? ['install'] : entry.startsWith('vite/') ? ['build'] : [])], { env, encoding: 'utf8' });
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

it.runIf(process.platform === 'darwin')('routes admission through the inherited loopback proxy even when NO_PROXY includes Main', async () => {
 let targetRequests = 0, proxyRequests = 0;
 const target = http.createServer((_req, res) => { targetRequests++; res.end(JSON.stringify({ allow: true, leaseId: 'finite-lease' })); });
 await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
 const targetPort = (target.address() as { port: number }).port;
 const proxy = http.createServer((req, res) => {
  proxyRequests++;
  expect(req.headers['proxy-authorization']).toBe('Basic ' + Buffer.from('finite:private-proxy').toString('base64'));
  expect(req.headers.authorization).toBe('Bearer finite-private');
  expect(req.url).toBe(`http://127.0.0.1:${targetPort}/hook/heavy-command`);
  const forwarded = http.request(req.url!, { method: req.method, headers: { authorization: req.headers.authorization } }, (response) => response.pipe(res));
  req.pipe(forwarded);
 });
 await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
 const proxyPort = (proxy.address() as { port: number }).port;
 try {
  const child = spawn(process.execPath, [path.join(process.cwd(), 'resources/heavy-command/request.cjs'), String(process.pid), 'build'], {
   env: { NEXUS_HEAVY_CURL: '/usr/bin/curl', NEXUS_HEAVY_COMMAND_URL: `http://127.0.0.1:${targetPort}/hook/heavy-command`, NEXUS_GATE_TOKEN: 'finite-private', HTTP_PROXY: `http://finite:private-proxy@localhost:${proxyPort}`, NO_PROXY: 'localhost,127.0.0.1,::1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', error = ''; child.stdout.on('data', (part) => output += part); child.stderr.on('data', (part) => error += part);
  expect(await new Promise<number | null>((resolve) => child.once('close', resolve))).toBe(0);
  expect(output).toBe('finite-lease'); expect(error).toBe(''); expect(proxyRequests).toBe(1); expect(targetRequests).toBe(1);
 } finally { await Promise.all([new Promise<void>((resolve) => target.close(() => resolve())), new Promise<void>((resolve) => proxy.close(() => resolve()))]); }
});

it.runIf(process.platform === 'darwin').each(['http://example.invalid:80', 'https://127.0.0.1:8443', 'http://127.0.0.1:3128/?remote=1', 'http://finite:%0A@127.0.0.1:3128'])('rejects unsafe inherited proxy %s before bearer or direct-loopback egress', async (proxy) => {
 let requests = 0; const target = http.createServer((_req, res) => { requests++; res.end('{}'); });
 await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
 const { port } = target.address() as { port: number };
 try {
  const child = spawn(process.execPath, [path.join(process.cwd(), 'resources/heavy-command/request.cjs'), String(process.pid), 'build'], { env: { NEXUS_HEAVY_CURL: '/usr/bin/curl', NEXUS_HEAVY_COMMAND_URL: `http://127.0.0.1:${port}/hook/heavy-command`, NEXUS_GATE_TOKEN: 'finite-private', http_proxy: proxy }, stdio: 'ignore' });
  expect(await new Promise<number | null>((resolve) => child.once('close', resolve))).toBe(78); expect(requests).toBe(0);
 } finally { await new Promise<void>((resolve) => target.close(() => resolve())); }
});

it.runIf(process.platform === 'darwin')('does not fall back to a direct admission when the inherited proxy denies credentials', async () => {
 let targetRequests = 0, proxyRequests = 0;
 const target = http.createServer((_req, res) => { targetRequests++; res.end(JSON.stringify({ allow: true, leaseId: 'finite-lease' })); });
 const proxy = http.createServer((_req, res) => { proxyRequests++; res.writeHead(407); res.end('{}'); });
 await Promise.all([new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve)), new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))]);
 try {
  const child = spawn(process.execPath, [path.join(process.cwd(), 'resources/heavy-command/request.cjs'), String(process.pid), 'build'], { env: { NEXUS_HEAVY_CURL: '/usr/bin/curl', NEXUS_HEAVY_COMMAND_URL: `http://127.0.0.1:${(target.address() as { port: number }).port}/hook/heavy-command`, NEXUS_GATE_TOKEN: 'finite-private', http_proxy: `http://invalid:credential@127.0.0.1:${(proxy.address() as { port: number }).port}`, no_proxy: '*' }, stdio: 'ignore' });
  expect(await new Promise<number | null>((resolve) => child.once('close', resolve))).toBe(78); expect(proxyRequests).toBe(1); expect(targetRequests).toBe(0);
 } finally { await Promise.all([new Promise<void>((resolve) => target.close(() => resolve())), new Promise<void>((resolve) => proxy.close(() => resolve()))]); }
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


it('scoped promisified execFile preserves Node22 Promise.child for SDK cancellation', () => {
 const env = { ...process.env, NODE_OPTIONS: appendHeavyCommandPreload(undefined, path.join(process.cwd(), 'resources/heavy-command/preload.cjs')),
   NEXUS_GATE_TOKEN: 'finite', NEXUS_HEAVY_COMMAND_URL: 'http://127.0.0.1:1/hook/heavy-command' };
 const script = `const {promisify}=require('node:util');const cp=require('node:child_process');const pending=promisify(cp.execFile)(process.execPath,['-e','setTimeout(()=>{},10000)']);pending.catch(()=>{});console.log(Boolean(pending.child&&typeof pending.child.kill==='function'));if(pending.child)pending.child.kill();else setTimeout(()=>process.exit(0),50)`;
 const result = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8', timeout: 3000 });
 expect(result.status).toBe(0); expect(result.stdout.trim()).toBe('true');
});

it('real Vite serve, esbuild serve and node server processes do not reserve the finite heavy slot', async () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-heavy-dev-'));
 fs.writeFileSync(path.join(root, 'server.js'), "console.log('finite-server-ready');setInterval(()=>{},1000)");
 fs.writeFileSync(path.join(root, 'fixture.js'), "console.log('finite-browser');");
 let requests = 0; const server = http.createServer((req, res) => { req.resume(); req.on('end', () => { requests++; res.end(JSON.stringify({ allow: true, leaseId: 'finite-development-lease' })); }); });
 await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); const { port } = server.address() as { port: number };
 const resources = path.join(process.cwd(), 'resources/heavy-command');
 const env = { ...process.env, BASH_ENV: path.join(resources, 'shell.bash'), NODE_OPTIONS: appendHeavyCommandPreload(undefined, path.join(resources, 'preload.cjs')),
  NEXUS_HEAVY_NODE: process.execPath, NEXUS_HEAVY_DIR: resources, NEXUS_GATE_TOKEN: 'finite-development', NEXUS_HEAVY_COMMAND_URL: `http://127.0.0.1:${port}/hook/heavy-command` };
 const commands = [
  `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(process.cwd(), 'node_modules/vite/bin/vite.js'))} --host 127.0.0.1 --port 0`,
  `${JSON.stringify(path.join(process.cwd(), 'node_modules/esbuild/bin/esbuild'))} fixture.js --bundle --outfile=out.js --serve=127.0.0.1:0`,
  `${JSON.stringify(process.execPath)} server.js`,
 ];
 try {
  for (const command of commands) {
   let output = ''; const child = spawn('/bin/bash', ['-c', command], { cwd: root, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
   const done = new Promise<void>((resolve) => child.once('close', () => resolve()));
   child.stdout.on('data', (part) => output += part); child.stderr.on('data', (part) => output += part);
   try {
    const deadline = Date.now() + 10_000;
    while (!/(?:Local:|127\.0\.0\.1:|finite-server-ready)/.test(output) && child.exitCode === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(output).toMatch(/(?:Local:|127\.0\.0\.1:|finite-server-ready)/); expect(child.exitCode).toBeNull();
   } finally { try { process.kill(-child.pid!, 'SIGTERM'); } catch {} await done; }
  }
  expect(requests).toBe(0);
 } finally { await new Promise<void>((resolve) => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); }
}, 40_000);

it('a Node eval requiring Vite with stripped NODE_OPTIONS is finite work before the program executes', () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-heavy-eval-'));
 const resources = path.join(process.cwd(), 'resources/heavy-command'), marker = path.join(root, 'started');
 const program = `require(${JSON.stringify(path.join(process.cwd(), 'node_modules/vite'))});require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`;
 const env = { ...process.env, BASH_ENV: path.join(resources, 'shell.bash'), NEXUS_HEAVY_NODE: process.execPath, NEXUS_HEAVY_DIR: resources,
  NEXUS_GATE_TOKEN: 'finite-eval', NEXUS_HEAVY_COMMAND_URL: 'http://127.0.0.1:1/hook/heavy-command' };
 try { const result = spawnSync('/bin/bash', ['-c', `NODE_OPTIONS= ${JSON.stringify(process.execPath)} -e ${JSON.stringify(program)}`], { env, encoding: 'utf8' });
  expect(result.status).toBe(78); expect(fs.existsSync(marker)).toBe(false); }
 finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 10_000);

// F-251: compinit defaults its dump to ZDOTDIR. User startup must never
// observe the signed bundle as its writable configuration directory.
it.runIf(process.platform === 'darwin')('keeps real zsh completion and startup writes out of the signed resources', () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-zdot-seal-'));
 const resources = path.join(root, 'signed resources'), home = path.join(root, 'user home');
 fs.cpSync(path.join(process.cwd(), 'resources/heavy-command'), resources, { recursive: true });
 fs.mkdirSync(home);
 const before = fs.readdirSync(resources).sort();
 for (const stage of ['zshenv', 'zprofile', 'zshrc', 'zlogin', 'zlogout']) {
  fs.writeFileSync(path.join(home, '.' + stage), `print -r -- ready > "$ZDOTDIR/${stage}.marker"\n` +
   (stage === 'zshrc' ? 'autoload -Uz compinit; compinit -u\n' : ''));
 }
 try {
  const result = spawnSync('/bin/zsh', ['-lic', '[[ "$ZDOTDIR" == "$NEXUS_HEAVY_DIR" ]] && print hook-path-preserved'], {
   env: { PATH: '/usr/bin:/bin', HOME: home, ZDOTDIR: resources, NEXUS_HEAVY_DIR: resources, NEXUS_HEAVY_ORIG_ZDOTDIR: home }, encoding: 'utf8', timeout: 15_000,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('hook-path-preserved');
  expect(fs.readdirSync(resources).sort()).toEqual(before);
  expect(fs.existsSync(path.join(home, '.zcompdump'))).toBe(true);
  for (const stage of ['zshenv', 'zprofile', 'zshrc', 'zlogin', 'zlogout']) expect(fs.existsSync(path.join(home, stage + '.marker'))).toBe(true);
 } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it.runIf(process.platform === 'darwin')('preserves a user zshenv redirect for later startup files and nested shells', () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-zdot-redirect-'));
 const resources = path.join(root, 'signed resources'), home = path.join(root, 'home'), config = path.join(home, '.config/zsh');
 fs.cpSync(path.join(process.cwd(), 'resources/heavy-command'), resources, { recursive: true });
 fs.mkdirSync(config, { recursive: true });
 fs.writeFileSync(path.join(home, '.zshenv'), 'export ZDOTDIR="$HOME/.config/zsh"\n');
 fs.writeFileSync(path.join(config, '.zshrc'), 'print -r -- loaded >> "$ZDOTDIR/loaded"\nreturn 0\n');
 try {
  const result = spawnSync('/bin/zsh', ['-ic', '/bin/zsh -ic true'], {
   env: { PATH: '/usr/bin:/bin', HOME: home, ZDOTDIR: resources, NEXUS_HEAVY_DIR: resources, NEXUS_HEAVY_ORIG_ZDOTDIR: home }, encoding: 'utf8', timeout: 10_000,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(fs.existsSync(path.join(config, 'loaded'))).toBe(true);
  expect(fs.readFileSync(path.join(config, 'loaded'), 'utf8')).toBe('loaded\nloaded\n');
  expect(fs.existsSync(path.join(resources, 'loaded'))).toBe(false);
 } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// F-988 (revisão): NEXUS_HEAVY_HELPER=1 era autoisenção genérica — qualquer
// lançador podia definir a variável e pular a admissão. A flag só isenta um
// entrypoint exato e confiável, provado pelo caminho real do script.
function scopedHeavyEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
 const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: appendHeavyCommandPreload(undefined, path.join(process.cwd(), 'resources/heavy-command/preload.cjs')),
   NEXUS_GATE_TOKEN: 'finite', NEXUS_HEAVY_COMMAND_URL: 'http://127.0.0.1:1/hook/heavy-command', ...extra };
 for (const key of ['NEXUS_HEAVY_HELPER', 'NEXUS_HEAVY_LEASE', 'NEXUS_HEAVY_JOB_BASE', 'NEXUS_HEAVY_DISPATCHED', 'NEXUS_HEAVY_AGENT_ENTRY']) if (!(key in extra)) delete env[key];
 return env;
}

it('NEXUS_HEAVY_HELPER=1 sozinho não isenta um entrypoint pesado (nem filho que herdou a flag)', () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-helper-flag-'));
 const entry = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'); fs.mkdirSync(path.dirname(entry), { recursive: true });
 const marker = path.join(root, 'compiled');
 fs.writeFileSync(entry, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x'); console.log('compiled')`);
 try {
  const plain = spawnSync(process.execPath, [entry], { env: scopedHeavyEnv(), encoding: 'utf8', timeout: 10_000 });
  expect(plain.status).toBe(78);
  const flagged = spawnSync(process.execPath, [entry], { env: scopedHeavyEnv({ NEXUS_HEAVY_HELPER: '1' }), encoding: 'utf8', timeout: 10_000 });
  expect(flagged.status).toBe(78);
  expect(flagged.stdout).not.toContain('compiled');
  expect(fs.existsSync(marker)).toBe(false);
 } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 20_000);

it.skipIf(process.platform !== 'darwin' || !fs.existsSync('/usr/bin/perl'))('a flag isenta só o cliente nx idêntico ao recurso e os helpers do heavy-command', () => {
 // Base de job que recusa tudo: quem não for isento sai 78 antes de rodar.
 const jobBase = JSON.stringify({ file: '/usr/bin/perl', args: ['-e', 'exit 78', 'heavy-job'] });
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-helper-exact-'));
 const client = path.join(root, 'bin', 'nx-shim.cjs'); fs.mkdirSync(path.dirname(client), { recursive: true });
 const source = fs.readFileSync(path.join(process.cwd(), 'resources/mission-shims/nx-shim.cjs'));
 fs.writeFileSync(client, source);
 const tampered = path.join(root, 'other', 'nx-shim.cjs'); fs.mkdirSync(path.dirname(tampered), { recursive: true });
 fs.writeFileSync(tampered, Buffer.concat([source, Buffer.from('\n// alterado\n')]));
 const extra = path.join(root, 'extra.cjs'); const marker = path.join(root, 'extra-ran');
 fs.writeFileSync(extra, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`);
 const run = (args: string[], extraEnv: NodeJS.ProcessEnv) => spawnSync(process.execPath, args, { env: scopedHeavyEnv({ NEXUS_HEAVY_JOB_BASE: jobBase, ...extraEnv }), encoding: 'utf8', timeout: 10_000 });
 try {
  const exempt = run([client, 'mail', '--help'], { NEXUS_HEAVY_HELPER: '1' });
  expect(exempt.status, exempt.stderr).toBe(0);
  expect(exempt.stdout).toMatch(/uso: nx-mail send/);
  expect(run([client, 'mail', '--help'], {}).status).toBe(78);
  expect(run([tampered, 'mail', '--help'], { NEXUS_HEAVY_HELPER: '1' }).status).toBe(78);
  const withExtra = run([client, 'mail', '--help'], { NEXUS_HEAVY_HELPER: '1',
    NODE_OPTIONS: `${appendHeavyCommandPreload(undefined, path.join(process.cwd(), 'resources/heavy-command/preload.cjs'))} --require ${JSON.stringify(extra)}` });
  expect(withExtra.status).toBe(78);
  expect(fs.existsSync(marker)).toBe(false);
  const classify = path.join(process.cwd(), 'resources/heavy-command/classify.cjs');
  const helper = run([classify, 'npx vitest run'], { NEXUS_HEAVY_HELPER: '1' });
  expect(helper.status, helper.stderr).toBe(0);
  expect(helper.stdout).toBe('tests');
  expect(run([classify, 'npx vitest run'], {}).status).toBe(78);
 } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 30_000);

// F-988 (segunda revisão): a isenção lia o NODE_OPTIONS com regex, não como o
// Node. `"--require" /x/evil.cjs` (aspas que o Node remove) passava pela regex,
// a isenção valia e o módulo extra rodava sem admissão.
it.skipIf(process.platform === 'win32' || !fs.existsSync('/usr/bin/perl'))('a isenção tokeniza o NODE_OPTIONS como o Node: pré-carregamento extra entre aspas não passa', () => {
 const jobBase = JSON.stringify({ file: '/usr/bin/perl', args: ['-e', 'exit 78', 'heavy-job'] });
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-helper-tokens-'));
 const client = path.join(root, 'bin', 'nx-shim.cjs'); fs.mkdirSync(path.dirname(client), { recursive: true });
 fs.writeFileSync(client, fs.readFileSync(path.join(process.cwd(), 'resources/mission-shims/nx-shim.cjs')));
 const extra = path.join(root, 'extra.cjs'); const marker = path.join(root, 'extra-ran');
 fs.writeFileSync(extra, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`);
 const own = appendHeavyCommandPreload(undefined, path.join(process.cwd(), 'resources/heavy-command/preload.cjs'));
 const run = (nodeOptions: string) => spawnSync(process.execPath, [client, 'mail', '--help'], { env: scopedHeavyEnv({ NEXUS_HEAVY_JOB_BASE: jobBase, NEXUS_HEAVY_HELPER: '1', NODE_OPTIONS: nodeOptions }), encoding: 'utf8', timeout: 10_000 });
 try {
  expect(run(own).status).toBe(0);
  for (const sneaky of [`"--require" ${extra}`, `--re"quire" ${extra}`, `"-r" "${extra}"`, `--re"quire=${extra}"`, `--im"port" ${extra}`]) {
   const result = run(`${own} ${sneaky}`);
   expect(result.status, sneaky).toBe(78);
   expect(fs.existsSync(marker), sneaky).toBe(false);
  }
 } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 30_000);

it('Main refuses a missing or substituted bundled Grok transport resource', () => {
 const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-grok-resource-')));
 const directory = path.join(root, 'heavy-command');
 fs.cpSync(path.join(process.cwd(), 'resources/heavy-command'), directory, { recursive: true });
 const bridge = path.join(directory, 'grok-transport.cjs');
 try {
  expect(heavyCommandShellEnvironment({ PATH: path.dirname(process.execPath), HOME: root }, path.join(directory, 'preload.cjs')).NEXUS_HEAVY_DIR).toBe(directory);
  fs.unlinkSync(bridge);
  expect(() => heavyCommandShellEnvironment({ PATH: path.dirname(process.execPath), HOME: root }, path.join(directory, 'preload.cjs'))).toThrow();
  fs.symlinkSync(path.join(process.cwd(), 'resources/heavy-command/grok-transport.cjs'), bridge);
  expect(() => heavyCommandShellEnvironment({ PATH: path.dirname(process.execPath), HOME: root }, path.join(directory, 'preload.cjs'))).toThrow('heavy_command_resource_identity_invalid');
 } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// Adapter identity comes from the Main; replay and human shells have none.
it.each([
  ['grok', 'darwin', true, '/bin/bash'], ['grok', 'darwin', false, '/finite/custom-bash'],
  ['grok', 'linux', true, '/finite/custom-bash'], ['grok', 'win32', true, '/finite/custom-bash'],
  ['custom-grok', 'darwin', true, '/finite/custom-bash'], ['kimi', 'darwin', true, '/finite/custom-bash'],
  [undefined, 'darwin', true, '/finite/custom-bash'],
] as const)('F-1101: shell selection scopes adapter=%s platform=%s heavy=%s', (adapterId, platform, scoped, want) => {
  const unchanged = { HOME: '/finite/home', PATH: '/finite/bin:/bin', SHELL: '/bin/zsh', NEXUS_HEAVY_ORIG_BASH_ENV: '/finite/original.bash', NEXUS_HEAVY_ORIG_ZDOTDIR: '/finite/zprofile' };
  const env: NodeJS.ProcessEnv = { ...unchanged, GROK_SHELL: '/finite/custom-bash', ...(scoped ? { NEXUS_HEAVY_COMMAND_URL: 'http://127.0.0.1:1/hook/heavy-command', NEXUS_HEAVY_BASH_ENV: '/finite/scoped.bash' } : {}) };
  selectGrokHeavyShell(env, adapterId, platform);
  expect(env.GROK_SHELL).toBe(want); expect(env).toMatchObject(unchanged);
  expect(env.NEXUS_GATE_TOKEN).toBeUndefined(); expect(env.NEXUS_HEAVY_JOB_BASE).toBeUndefined();
});
