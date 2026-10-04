import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { expect, it } from 'vitest';
import { NativeHeavyCommands } from './native-heavy-command';
import { HeavyCommandPermitPool } from './heavy-command-permit';
import { OwnedCommandProcesses } from '../pty/owned-command-process';
import type { AgentGateContext } from './gate';
import { appendHeavyCommandPreload } from './native-heavy-preload';

it('two actual native Node tsc descendants from the AI operator hand serialize without a mission', async () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-native-tsc-'));
 fs.writeFileSync(path.join(root, 'fixture.ts'), Array.from({ length: 4000 }, (_, i) => `interface Value${i} { name: string; value: number }`).join('\n'));
 const scope = { version: 1 as const, installationId: 'finite', projectId: 'native-tsc', checkoutId: 'main', rootRealPath: root, identitySource: 'manifest' as const };
 const ctx = { token: 'finite-native-token', sessionId: 'finite-session', role: 'user', scope } as AgentGateContext;
 const pool = new HeavyCommandPermitPool({ memory: () => ({ freeMB: 16_384, swapUsedMB: 0 }), limits: () => ({ minFreeMB: 512, maxSwapUsedMB: 0 }), refreshMemory: async () => {}, pollMs: 10 });
 const rootIdentity = {}; const processProof = new OwnedCommandProcesses((id) => id === ctx.sessionId ? { pid: process.pid, identity: rootIdentity } : null);
 const transitions: Array<{ kind: 'grant' | 'release'; at: number }> = [];
 const native = new NativeHeavyCommands({ current: () => true, claim: (id, pid) => processProof.claim(id, pid), probe: (id, claim) => processProof.probe(id, claim),
  acquire: async (request) => { const permit = await pool.acquire(request); transitions.push({ kind: 'grant', at: performance.now() }); return { id: permit.id, release: () => { transitions.push({ kind: 'release', at: performance.now() }); permit.release(); } }; } });
 const server = http.createServer((req, res) => {
  let body = ''; req.on('data', (data) => { body += data; }); req.on('end', () => {
   if (req.headers.authorization !== `Bearer ${ctx.token}`) { res.writeHead(401); res.end(); return; }
   void native.admit(ctx, JSON.parse(body)).then((result) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result)); });
  });
 });
 await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); const address = server.address() as { port: number };
 const preload = path.join(process.cwd(), 'resources/heavy-command/preload.cjs');
 const options = appendHeavyCommandPreload('--max-old-space-size=256', preload);
 expect(options).toContain('--max-old-space-size=256');
 const env = { ...process.env, NODE_OPTIONS: options, NEXUS_HEAVY_COMMAND_URL: `http://127.0.0.1:${address.port}/hook/heavy-command`, NEXUS_GATE_TOKEN: ctx.token };
 const tsc = path.join(process.cwd(), 'node_modules/typescript/bin/tsc');
 const run = () => new Promise<{ code: number | null; stderr: string }>((resolve) => {
  const child = spawn(process.execPath, [tsc, '--noEmit', '--skipLibCheck', '--lib', 'ES2020', 'fixture.ts'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', (data) => { stderr += data; }); child.once('close', (code) => resolve({ code, stderr }));
 });
 try {
  const result = await Promise.all([run(), run()]); expect(result.map((r) => r.stderr)).toEqual(['', '']); expect(result.map((r) => r.code)).toEqual([0, 0]);
  await native.drain(); expect(transitions.map((v) => v.kind)).toEqual(['grant', 'release', 'grant', 'release']); expect(pool.snapshot().active).toBe(0);
 } finally { pool.close(); await new Promise<void>((resolve) => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); }
}, 30_000);

it('RAM-denied native admission does not release an unrelated active compiler and waiting cancellation is explicit', async () => {
 const scope = { version: 1 as const, installationId: 'finite', projectId: 'ram', checkoutId: 'main', rootRealPath: '/tmp', identitySource: 'manifest' as const };
 const ctx = { token: 'finite', sessionId: 'finite', missionId: 'finite', role: 'worker', scope } as AgentGateContext;
 let memory = 100; const pool = new HeavyCommandPermitPool({ memory: () => ({ freeMB: memory, swapUsedMB: 0 }), limits: () => ({ minFreeMB: 512, maxSwapUsedMB: 0 }), refreshMemory: async () => {}, pollMs: 10 });
 let state: 'live' | 'gone' | 'unknown' = 'live';
 const native = new NativeHeavyCommands({ current: () => true, claim: async () => 'owned', probe: async () => state, acquire: (request) => pool.acquire(request) });
 const controller = new AbortController(); const denied = native.admit(ctx, { pid: 123, kind: 'typescript' }, controller.signal);
 await new Promise((resolve) => setTimeout(resolve, 30)); expect(pool.snapshot()).toMatchObject({ active: 0, waiting: 1 });
 controller.abort(); expect(await denied).toMatchObject({ allow: false }); expect(pool.snapshot().active).toBe(0);
 memory = 8192; const active = await native.admit(ctx, { pid: 123, kind: 'typescript' }); expect(active.allow).toBe(true);
 native.stopAdmission(); expect(pool.snapshot().active).toBe(1); state = 'unknown'; await new Promise((resolve) => setTimeout(resolve, 300)); expect(pool.snapshot().active).toBe(1);
 state = 'gone'; await native.drain(); expect(pool.snapshot().active).toBe(0); pool.close();
});

it('refuses unknown PID ownership and outside-mission callers before taking any RAM reservation', async () => {
 const native = new NativeHeavyCommands({ current: () => true, claim: async () => null, probe: async () => 'unknown', acquire: async () => { throw new Error('must not acquire'); } });
 const ctx = { token: 'finite', role: 'user', scope: {} } as AgentGateContext;
 expect(await native.admit(ctx, { pid: 123, kind: 'typescript' })).toMatchObject({ allow: false });
 expect(await native.admit({ ...ctx, role: 'worker', missionId: 'finite', sessionId: 'finite' }, { pid: 123, kind: 'typescript' })).toMatchObject({ allow: false, reason: 'heavy_command_process_ownership_unproved' });
});

it('a removed session never releases a still-live or unknown compiler claim', async () => {
 const ctx = { token: 'finite', sessionId: 'finite', missionId: 'finite', role: 'worker', scope: { installationId: 'finite', projectId: 'finite' } } as AgentGateContext;
 let state: 'live' | 'unknown' | 'gone' = 'live'; let released = false; let sessionPresent = true;
 const native = new NativeHeavyCommands({ current: () => sessionPresent, claim: async () => 'owned', probe: async () => state,
   acquire: async () => ({ id: 'finite', release: () => { released = true; } }) });
 expect((await native.admit(ctx, { pid: 123, kind: 'typescript' })).allow).toBe(true); sessionPresent = false;
 await new Promise((resolve) => setTimeout(resolve, 300)); expect(released).toBe(false);
 state = 'unknown'; await new Promise((resolve) => setTimeout(resolve, 300)); expect(released).toBe(false);
 state = 'gone'; await native.drain(); expect(released).toBe(true);
});


it.each(['user', 'worker'])('admits physical AI %s panes without requiring a mission', async (role) => {
 const ctx = { token: 'finite', sessionId: 'finite', role, scope: { installationId: 'finite', projectId: 'finite' } } as AgentGateContext;
 let state: 'live' | 'gone' = 'live';
 const native = new NativeHeavyCommands({ current: () => true, claim: async () => 'physical-ai', probe: async () => state,
   acquire: async () => ({ id: 'finite', release() {} }) });
 expect(await native.admit(ctx, { pid: 123, kind: 'tests' })).toMatchObject({ allow: true });
 state = 'gone'; await native.drain();
});

it('two actual npm script parents borrow their child TypeScript lease without self-deadlock', async () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-native-tsc-'));
 fs.writeFileSync(path.join(root, 'fixture.ts'), Array.from({ length: 4000 }, (_, i) => `interface Value${i} { name: string; value: number }`).join('\n'));
 const scope = { version: 1 as const, installationId: 'finite', projectId: 'native-tsc', checkoutId: 'main', rootRealPath: root, identitySource: 'manifest' as const };
 const ctx = { token: 'finite-native-token', sessionId: 'finite-session', role: 'user', scope } as AgentGateContext;
 const pool = new HeavyCommandPermitPool({ memory: () => ({ freeMB: 16_384, swapUsedMB: 0 }), limits: () => ({ minFreeMB: 512, maxSwapUsedMB: 0 }), refreshMemory: async () => {}, pollMs: 10 });
 const rootIdentity = {}; const processProof = new OwnedCommandProcesses((id) => id === ctx.sessionId ? { pid: process.pid, identity: rootIdentity } : null);
 const transitions: Array<{ kind: 'grant' | 'release'; at: number }> = [];
 const native = new NativeHeavyCommands({ current: () => true, claim: (id, pid) => processProof.claim(id, pid), probe: (id, claim) => processProof.probe(id, claim), borrow: (id, claim, pid) => processProof.borrow(id, claim, pid),
  acquire: async (request) => { const permit = await pool.acquire(request); transitions.push({ kind: 'grant', at: performance.now() }); return { id: permit.id, release: () => { transitions.push({ kind: 'release', at: performance.now() }); permit.release(); } }; } });
 const server = http.createServer((req, res) => {
  let body = ''; req.on('data', (data) => { body += data; }); req.on('end', () => {
   if (req.headers.authorization !== `Bearer ${ctx.token}`) { res.writeHead(401); res.end(); return; }
   void native.admit(ctx, JSON.parse(body)).then((result) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result)); });
  });
 });
 await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); const address = server.address() as { port: number };
 const preload = path.join(process.cwd(), 'resources/heavy-command/preload.cjs');
 const options = appendHeavyCommandPreload('--max-old-space-size=256', preload);
 expect(options).toContain('--max-old-space-size=256');
 const env = { ...process.env, NODE_OPTIONS: options, NEXUS_HEAVY_COMMAND_URL: `http://127.0.0.1:${address.port}/hook/heavy-command`, NEXUS_GATE_TOKEN: ctx.token };
 const tsc = path.join(process.cwd(), 'node_modules/typescript/bin/tsc');
 fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { typecheck: `node ${JSON.stringify(tsc)} --noEmit --skipLibCheck --lib ES2020 fixture.ts` } }));
 const npm = path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
 const run = () => new Promise<{ code: number | null; stderr: string }>((resolve) => {
  const child = spawn(process.execPath, [npm, 'run', 'typecheck'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', (data) => { stderr += data; }); child.once('close', (code) => resolve({ code, stderr }));
 });
 try {
  const result = await Promise.all([run(), run()]); expect(result.map((r) => r.stderr)).toEqual(['', '']); expect(result.map((r) => r.code)).toEqual([0, 0]);
  await native.drain(); expect(transitions.map((v) => v.kind)).toEqual(['grant', 'release', 'grant', 'release']); expect(pool.snapshot().active).toBe(0);
 } finally { pool.close(); await new Promise<void>((resolve) => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); }
}, 30_000);

it('absolute Bash execution with stripped NODE_OPTIONS is admitted before actual TypeScript starts', async () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-native-tsc-'));
 fs.writeFileSync(path.join(root, 'fixture.ts'), Array.from({ length: 4000 }, (_, i) => `interface Value${i} { name: string; value: number }`).join('\n'));
 const scope = { version: 1 as const, installationId: 'finite', projectId: 'native-tsc', checkoutId: 'main', rootRealPath: root, identitySource: 'manifest' as const };
 const ctx = { token: 'finite-native-token', sessionId: 'finite-session', role: 'user', scope } as AgentGateContext;
 const pool = new HeavyCommandPermitPool({ memory: () => ({ freeMB: 16_384, swapUsedMB: 0 }), limits: () => ({ minFreeMB: 512, maxSwapUsedMB: 0 }), refreshMemory: async () => {}, pollMs: 10 });
 const rootIdentity = {}; const processProof = new OwnedCommandProcesses((id) => id === ctx.sessionId ? { pid: process.pid, identity: rootIdentity } : null);
 const transitions: Array<{ kind: 'grant' | 'release'; at: number }> = [];
 const native = new NativeHeavyCommands({ current: () => true, claim: (id, pid) => processProof.claim(id, pid), probe: (id, claim) => processProof.probe(id, claim), borrow: (id, claim, pid) => processProof.borrow(id, claim, pid),
  acquire: async (request) => { const permit = await pool.acquire(request); transitions.push({ kind: 'grant', at: performance.now() }); return { id: permit.id, release: () => { transitions.push({ kind: 'release', at: performance.now() }); permit.release(); } }; } });
 const server = http.createServer((req, res) => {
  let body = ''; req.on('data', (data) => { body += data; }); req.on('end', () => {
   if (req.headers.authorization !== `Bearer ${ctx.token}`) { res.writeHead(401); res.end(); return; }
   void native.admit(ctx, JSON.parse(body)).then((result) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result)); });
  });
 });
 await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); const address = server.address() as { port: number };
 const preload = path.join(process.cwd(), 'resources/heavy-command/preload.cjs');
 const options = appendHeavyCommandPreload('--max-old-space-size=256', preload);
 expect(options).toContain('--max-old-space-size=256');
 const env = { ...process.env, NODE_OPTIONS: options, NEXUS_HEAVY_COMMAND_URL: `http://127.0.0.1:${address.port}/hook/heavy-command`, NEXUS_GATE_TOKEN: ctx.token, BASH_ENV: path.join(process.cwd(), 'resources/heavy-command/shell.bash'), NEXUS_HEAVY_NODE: process.execPath, NEXUS_HEAVY_DIR: path.join(process.cwd(), 'resources/heavy-command') };
 const tsc = path.join(process.cwd(), 'node_modules/typescript/bin/tsc');
 const run = () => new Promise<{ code: number | null; stderr: string }>((resolve) => {
  const child = spawn('/bin/bash', ['-c', `NODE_OPTIONS= ${JSON.stringify(process.execPath)} ${JSON.stringify(tsc)} --noEmit --skipLibCheck --lib ES2020 fixture.ts`], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', (data) => { stderr += data; }); child.once('close', (code) => resolve({ code, stderr }));
 });
 try {
  const result = await Promise.all([run(), run()]); expect(result.map((r) => r.stderr)).toEqual(['', '']); expect(result.map((r) => r.code)).toEqual([0, 0]);
  await native.drain(); expect(transitions.map((v) => v.kind)).toEqual(['grant', 'release', 'grant', 'release']); expect(pool.snapshot().active).toBe(0);
 } finally { pool.close(); await new Promise<void>((resolve) => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); }
}, 30_000);

it('absolute zsh execution with stripped NODE_OPTIONS is admitted before actual TypeScript starts', async () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-native-tsc-'));
 fs.writeFileSync(path.join(root, 'fixture.ts'), Array.from({ length: 4000 }, (_, i) => `interface Value${i} { name: string; value: number }`).join('\n'));
 const scope = { version: 1 as const, installationId: 'finite', projectId: 'native-tsc', checkoutId: 'main', rootRealPath: root, identitySource: 'manifest' as const };
 const ctx = { token: 'finite-native-token', sessionId: 'finite-session', role: 'user', scope } as AgentGateContext;
 const pool = new HeavyCommandPermitPool({ memory: () => ({ freeMB: 16_384, swapUsedMB: 0 }), limits: () => ({ minFreeMB: 512, maxSwapUsedMB: 0 }), refreshMemory: async () => {}, pollMs: 10 });
 const rootIdentity = {}; const processProof = new OwnedCommandProcesses((id) => id === ctx.sessionId ? { pid: process.pid, identity: rootIdentity } : null);
 const transitions: Array<{ kind: 'grant' | 'release'; at: number }> = [];
 const native = new NativeHeavyCommands({ current: () => true, claim: (id, pid) => processProof.claim(id, pid), probe: (id, claim) => processProof.probe(id, claim), borrow: (id, claim, pid) => processProof.borrow(id, claim, pid),
  acquire: async (request) => { const permit = await pool.acquire(request); transitions.push({ kind: 'grant', at: performance.now() }); return { id: permit.id, release: () => { transitions.push({ kind: 'release', at: performance.now() }); permit.release(); } }; } });
 const server = http.createServer((req, res) => {
  let body = ''; req.on('data', (data) => { body += data; }); req.on('end', () => {
   if (req.headers.authorization !== `Bearer ${ctx.token}`) { res.writeHead(401); res.end(); return; }
   void native.admit(ctx, JSON.parse(body)).then((result) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result)); });
  });
 });
 await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); const address = server.address() as { port: number };
 const preload = path.join(process.cwd(), 'resources/heavy-command/preload.cjs');
 const options = appendHeavyCommandPreload('--max-old-space-size=256', preload);
 expect(options).toContain('--max-old-space-size=256');
 const env = { ...process.env, NODE_OPTIONS: options, NEXUS_HEAVY_COMMAND_URL: `http://127.0.0.1:${address.port}/hook/heavy-command`, NEXUS_GATE_TOKEN: ctx.token, ZDOTDIR: path.join(process.cwd(), 'resources/heavy-command'), NEXUS_HEAVY_NODE: process.execPath, NEXUS_HEAVY_DIR: path.join(process.cwd(), 'resources/heavy-command') };
 const tsc = path.join(process.cwd(), 'node_modules/typescript/bin/tsc');
 const run = () => new Promise<{ code: number | null; stderr: string }>((resolve) => {
  const child = spawn('/bin/zsh', ['-c', `NODE_OPTIONS= ${JSON.stringify(process.execPath)} ${JSON.stringify(tsc)} --noEmit --skipLibCheck --lib ES2020 fixture.ts`], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', (data) => { stderr += data; }); child.once('close', (code) => resolve({ code, stderr }));
 });
 try {
  const result = await Promise.all([run(), run()]); expect(result.map((r) => r.stderr)).toEqual(['', '']); expect(result.map((r) => r.code)).toEqual([0, 0]);
  await native.drain(); expect(transitions.map((v) => v.kind)).toEqual(['grant', 'release', 'grant', 'release']); expect(pool.snapshot().active).toBe(0);
 } finally { pool.close(); await new Promise<void>((resolve) => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); }
}, 30_000);
it('actual absolute make commands serialize through non-Node shell preexec', async () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-native-tsc-'));
 fs.writeFileSync(path.join(root, 'fixture.ts'), Array.from({ length: 4000 }, (_, i) => `interface Value${i} { name: string; value: number }`).join('\n'));
 const scope = { version: 1 as const, installationId: 'finite', projectId: 'native-tsc', checkoutId: 'main', rootRealPath: root, identitySource: 'manifest' as const };
 const ctx = { token: 'finite-native-token', sessionId: 'finite-session', role: 'user', scope } as AgentGateContext;
 const pool = new HeavyCommandPermitPool({ memory: () => ({ freeMB: 16_384, swapUsedMB: 0 }), limits: () => ({ minFreeMB: 512, maxSwapUsedMB: 0 }), refreshMemory: async () => {}, pollMs: 10 });
 const rootIdentity = {}; const processProof = new OwnedCommandProcesses((id) => id === ctx.sessionId ? { pid: process.pid, identity: rootIdentity } : null);
 const transitions: Array<{ kind: 'grant' | 'release'; at: number }> = [];
 const native = new NativeHeavyCommands({ current: () => true, claim: (id, pid) => processProof.claim(id, pid), probe: (id, claim) => processProof.probe(id, claim), borrow: (id, claim, pid) => processProof.borrow(id, claim, pid),
  acquire: async (request) => { const permit = await pool.acquire(request); transitions.push({ kind: 'grant', at: performance.now() }); return { id: permit.id, release: () => { transitions.push({ kind: 'release', at: performance.now() }); permit.release(); } }; } });
 const server = http.createServer((req, res) => {
  let body = ''; req.on('data', (data) => { body += data; }); req.on('end', () => {
   if (req.headers.authorization !== `Bearer ${ctx.token}`) { res.writeHead(401); res.end(); return; }
   void native.admit(ctx, JSON.parse(body)).then((result) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result)); });
  });
 });
 await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); const address = server.address() as { port: number };
 const preload = path.join(process.cwd(), 'resources/heavy-command/preload.cjs');
 const options = appendHeavyCommandPreload('--max-old-space-size=256', preload);
 expect(options).toContain('--max-old-space-size=256');
 const env = { ...process.env, NODE_OPTIONS: options, NEXUS_HEAVY_COMMAND_URL: `http://127.0.0.1:${address.port}/hook/heavy-command`, NEXUS_GATE_TOKEN: ctx.token, ZDOTDIR: path.join(process.cwd(), 'resources/heavy-command'), NEXUS_HEAVY_NODE: process.execPath, NEXUS_HEAVY_DIR: path.join(process.cwd(), 'resources/heavy-command') };
 fs.writeFileSync(path.join(root, 'Makefile'), 'all:\n\t@/usr/bin/true\n');
 const run = () => new Promise<{ code: number | null; stderr: string }>((resolve) => {
  const child = spawn('/bin/zsh', ['-c', 'NODE_OPTIONS= /usr/bin/make -f Makefile'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', (data) => { stderr += data; }); child.once('close', (code) => resolve({ code, stderr }));
 });
 try {
  const result = await Promise.all([run(), run()]); expect(result.map((r) => r.stderr)).toEqual(['', '']); expect(result.map((r) => r.code)).toEqual([0, 0]);
  await native.drain(); expect(transitions.map((v) => v.kind)).toEqual(['grant', 'release', 'grant', 'release']); expect(pool.snapshot().active).toBe(0);
 } finally { pool.close(); await new Promise<void>((resolve) => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); }
}, 30_000);
it.runIf(process.platform === 'darwin')('two actual native Node tsc descendants serialize in the real offline Seatbelt via only the curl loopback grant', async () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-native-tsc-'));
 fs.writeFileSync(path.join(root, 'fixture.ts'), Array.from({ length: 4000 }, (_, i) => `interface Value${i} { name: string; value: number }`).join('\n'));
 const scope = { version: 1 as const, installationId: 'finite', projectId: 'native-tsc', checkoutId: 'main', rootRealPath: root, identitySource: 'manifest' as const };
 const ctx = { token: 'finite-native-token', sessionId: 'finite-session', role: 'user', scope } as AgentGateContext;
 const pool = new HeavyCommandPermitPool({ memory: () => ({ freeMB: 16_384, swapUsedMB: 0 }), limits: () => ({ minFreeMB: 512, maxSwapUsedMB: 0 }), refreshMemory: async () => {}, pollMs: 10 });
 const rootIdentity = {}; const processProof = new OwnedCommandProcesses((id) => id === ctx.sessionId ? { pid: process.pid, identity: rootIdentity } : null);
 const transitions: Array<{ kind: 'grant' | 'release'; at: number }> = [];
 const native = new NativeHeavyCommands({ current: () => true, claim: (id, pid) => processProof.claim(id, pid), probe: (id, claim) => processProof.probe(id, claim),
  acquire: async (request) => { const permit = await pool.acquire(request); transitions.push({ kind: 'grant', at: performance.now() }); return { id: permit.id, release: () => { transitions.push({ kind: 'release', at: performance.now() }); permit.release(); } }; } });
 const server = http.createServer((req, res) => {
  let body = ''; req.on('data', (data) => { body += data; }); req.on('end', () => {
   if (req.headers.authorization !== `Bearer ${ctx.token}`) { res.writeHead(401); res.end(); return; }
   void native.admit(ctx, JSON.parse(body)).then((result) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result)); });
  });
 });
 await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); const address = server.address() as { port: number };
 const preload = path.join(process.cwd(), 'resources/heavy-command/preload.cjs');
 const options = appendHeavyCommandPreload('--max-old-space-size=256', preload);
 expect(options).toContain('--max-old-space-size=256');
 const env = { ...process.env, NODE_OPTIONS: options, NEXUS_HEAVY_COMMAND_URL: `http://127.0.0.1:${address.port}/hook/heavy-command`, NEXUS_GATE_TOKEN: ctx.token, NEXUS_HEAVY_CURL: '/usr/bin/curl' };
 const tsc = path.join(process.cwd(), 'node_modules/typescript/bin/tsc');
 const run = () => new Promise<{ code: number | null; stderr: string }>((resolve) => {
  const child = spawn('/usr/bin/sandbox-exec', ['-p', `(version 1)(allow default)(deny network*)(with-filter (process-path "/usr/bin/curl") (allow network-outbound (remote tcp "localhost:${address.port}")))`, process.execPath, tsc, '--noEmit', '--skipLibCheck', '--lib', 'ES2020', 'fixture.ts'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', (data) => { stderr += data; }); child.once('close', (code) => resolve({ code, stderr }));
 });
 try {
  const result = await Promise.all([run(), run()]); expect(result.map((r) => r.stderr)).toEqual(['', '']); expect(result.map((r) => r.code)).toEqual([0, 0]);
  await native.drain(); expect(transitions.map((v) => v.kind)).toEqual(['grant', 'release', 'grant', 'release']); expect(pool.snapshot().active).toBe(0);
 } finally { pool.close(); await new Promise<void>((resolve) => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); }
}, 30_000);
