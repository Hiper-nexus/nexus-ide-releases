import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { expect, it } from 'vitest';
import { heavyExecutorIsLive, NativeHeavyCommands } from './native-heavy-command';
import { HeavyCommandPermitPool } from './heavy-command-permit';
import { OwnedCommandProcesses } from '../pty/owned-command-process';
import type { AgentGateContext } from './gate';
import { appendHeavyCommandPreload } from './native-heavy-preload';

/** Exit 0, and the lane did not refuse. Seatbelt or npm noise is not a refusal.
 * The expect message keeps a short preview: the gate stores only the first line.
 */
function expectAdmittedQuiet(result: Array<{ code: number | null; stderr: string }>): void {
  const preview = result.map((row) => JSON.stringify(row.stderr.slice(0, 160))).join(' ');
  expect(result.map((row) => row.code), preview).toEqual([0, 0]);
  for (const row of result) {
    expect(row.stderr, JSON.stringify(row.stderr.slice(0, 220))).not.toMatch(/nexus-heavy|\[Nexus\]|taskpolicy/i);
  }
}

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
  const result = await Promise.all([run(), run()]); expectAdmittedQuiet(result);
  await native.drain();
  expect(transitions.filter((v) => v.kind === 'grant')).toHaveLength(2);
  expect(transitions.filter((v) => v.kind === 'release')).toHaveLength(2);
  expect(pool.snapshot().active).toBe(0);
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

it('F-983/F-997: writers isolados do MESMO checkout testam ao mesmo tempo — a fila é a worktree, não o checkout do token', async () => {
 const scope = { version: 1 as const, installationId: 'finite', projectId: 'writers', checkoutId: 'main', rootRealPath: '/checkout', identitySource: 'manifest' as const };
 const writer = (id: string) => ({ token: id, sessionId: id, missionId: 'finite', role: 'worker', scope, executionScope: { ...scope, rootRealPath: `/worktrees/${id}` } }) as AgentGateContext;
 const pool = new HeavyCommandPermitPool({ memory: () => ({ freeMB: 64_000, swapUsedMB: 0 }), limits: () => ({ minFreeMB: 512, maxSwapUsedMB: 0 }), refreshMemory: async () => {}, pollMs: 10, waitMs: 200, maxActive: 4 });
 let state: 'live' | 'gone' = 'live';
 const native = new NativeHeavyCommands({ current: () => true, claim: async () => 'owned', probe: async () => state, acquire: (request) => pool.acquire(request) });
 const [first, second] = await Promise.all([native.admit(writer('w1'), { pid: 101, kind: 'tests' }), native.admit(writer('w2'), { pid: 102, kind: 'tests' })]);
 expect(first.allow).toBe(true); expect(second.allow).toBe(true);
 const sameTree = await native.admit({ ...writer('w1'), token: 'w1b', sessionId: 'w1b' }, { pid: 103, kind: 'tests' });
 expect(sameTree.allow).toBe(true);
 expect(pool.snapshot().active).toBe(3);
 // Build on that worktree stays exclusive while a reader holds the lane.
 expect(await native.admit({ ...writer('w1'), token: 'w1c', sessionId: 'w1c' }, { pid: 104, kind: 'build' })).toMatchObject({ allow: false, reason: 'heavy_command_wait_timeout' });
 state = 'gone'; await native.drain(); expect(pool.snapshot().active).toBe(0); pool.close();
});

it('treats ESRCH as a dead executor and EPERM as still alive', async () => {
 expect(heavyExecutorIsLive(process.pid)).toBe(true);
 const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
 const pid = child.pid!;
 await new Promise<void>((resolve) => child.once('exit', () => resolve()));
 expect(heavyExecutorIsLive(pid)).toBe(false);
});

it('frees the root slot when the admitted executor exits while its authority cohort is still live', async () => {
 const scope = { version: 1 as const, installationId: 'finite', projectId: 'cohort', checkoutId: 'main', rootRealPath: '/repo', identitySource: 'manifest' as const };
 const ctx = { token: 'finite', sessionId: 'finite', missionId: 'finite', role: 'worker', scope } as AgentGateContext;
 const other = { ...ctx, token: 'other', sessionId: 'other' } as AgentGateContext;
 const pool = new HeavyCommandPermitPool({ memory: () => ({ freeMB: 16_384, swapUsedMB: 0 }), limits: () => ({ minFreeMB: 512, maxSwapUsedMB: 0 }), refreshMemory: async () => {}, pollMs: 10, waitMs: 2_000, maxActive: 4 });
 const alive = new Set([50]);
 let authority: 'live' | 'gone' = 'live';
 const native = new NativeHeavyCommands({ current: () => true, claim: async () => 'authority', probe: async () => authority,
  executorLive: (pid) => alive.has(pid), acquire: (request) => pool.acquire(request) });
 const held = await native.admit(ctx, { pid: 50, kind: 'build' });
 expect(held.allow).toBe(true);
 expect(pool.snapshot().active).toBe(1);
 const next = native.admit(other, { pid: 51, kind: 'tests' });
 await new Promise((resolve) => setTimeout(resolve, 40));
 expect(pool.snapshot()).toMatchObject({ active: 1, waiting: 1 });
 alive.delete(50); alive.add(51);
 const admitted = await next;
 expect(admitted.allow).toBe(true);
 expect(pool.snapshot().active).toBe(1);
 authority = 'gone'; await native.drain(); pool.close();
});

it('refuses unknown PID ownership and outside-mission callers before taking any RAM reservation', async () => {
 const native = new NativeHeavyCommands({ current: () => true, claim: async () => null, probe: async () => 'unknown', acquire: async () => { throw new Error('must not acquire'); } });
 const ctx = { token: 'finite', role: 'user', scope: {} } as AgentGateContext;
 expect(await native.admit(ctx, { pid: 123, kind: 'typescript' })).toMatchObject({ allow: false });
 expect(await native.admit({ ...ctx, role: 'worker', missionId: 'finite', sessionId: 'finite' }, { pid: 123, kind: 'typescript' })).toMatchObject({ allow: false, reason: 'heavy_command_process_ownership_unproved' });
});

it('passes the admitted pid and label to the pool so a ghost lease can expire and be named', async () => {
 const scope = { version: 1 as const, installationId: 'finite', projectId: 'wire', checkoutId: 'main', rootRealPath: '/repo', identitySource: 'manifest' as const };
 const ctx = { token: 'finite', sessionId: 'pty-wire', missionId: 'finite', role: 'worker', scope } as AgentGateContext;
 const seen: Array<{ kind: string; executorPid?: number; sessionId?: string; label?: string }> = [];
 const pool = new HeavyCommandPermitPool({ memory: () => ({ freeMB: 16_384, swapUsedMB: 0 }), limits: () => ({ minFreeMB: 512, maxSwapUsedMB: 0 }), refreshMemory: async () => {}, pollMs: 10 });
 let state: 'live' | 'gone' = 'live';
 const native = new NativeHeavyCommands({ current: () => true, claim: async () => 'owned', probe: async () => state,
  acquire: async (request) => { seen.push({ kind: request.kind, executorPid: request.executorPid, sessionId: request.sessionId, label: request.label }); return pool.acquire(request); } });
 const admitted = await native.admit(ctx, { pid: 4242, kind: 'build', label: 'node check-migrations.js' });
 expect(admitted.allow).toBe(true);
 expect(seen[0]).toMatchObject({ kind: 'build', executorPid: 4242, sessionId: 'pty-wire', label: 'node check-migrations.js' });
 state = 'gone'; await native.drain(); pool.close();
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
  const result = await Promise.all([run(), run()]); expectAdmittedQuiet(result);
  await native.drain();
  expect(transitions.filter((v) => v.kind === 'grant')).toHaveLength(2);
  expect(transitions.filter((v) => v.kind === 'release')).toHaveLength(2);
  expect(pool.snapshot().active).toBe(0);
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
  const result = await Promise.all([run(), run()]); expectAdmittedQuiet(result);
  await native.drain();
  expect(transitions.filter((v) => v.kind === 'grant')).toHaveLength(2);
  expect(transitions.filter((v) => v.kind === 'release')).toHaveLength(2);
  expect(pool.snapshot().active).toBe(0);
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
  const result = await Promise.all([run(), run()]); expectAdmittedQuiet(result);
  await native.drain();
  expect(transitions.filter((v) => v.kind === 'grant')).toHaveLength(2);
  expect(transitions.filter((v) => v.kind === 'release')).toHaveLength(2);
  expect(pool.snapshot().active).toBe(0);
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
  const result = await Promise.all([run(), run()]); expectAdmittedQuiet(result);
  await native.drain();
  expect(transitions.map((v) => v.kind)).toEqual(['grant', 'release', 'grant', 'release']);
  expect(pool.snapshot().active).toBe(0);
 } finally { pool.close(); await new Promise<void>((resolve) => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); }
}, 30_000);
it.runIf(process.platform === 'darwin')('two actual native Node tsc descendants share the root in the real offline Seatbelt via only the curl loopback grant', async () => {
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
  const result = await Promise.all([run(), run()]); expectAdmittedQuiet(result);
  await native.drain();
  expect(transitions.filter((v) => v.kind === 'grant')).toHaveLength(2);
  expect(transitions.filter((v) => v.kind === 'release')).toHaveLength(2);
  expect(pool.snapshot().active).toBe(0);
 } finally { pool.close(); await new Promise<void>((resolve) => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); }
}, 30_000);


it('stopAdmission fences the result after a pending final ownership probe', async () => {
 const ctx = { token: 'finite', sessionId: 'finite', role: 'user', scope: {} } as AgentGateContext;
 let observerDone!: (value: 'gone') => void, finalDone!: (value: 'live') => void;
 const observer = new Promise<'gone'>((resolve) => observerDone = resolve), final = new Promise<'live'>((resolve) => finalDone = resolve);
 let probes = 0;
 const native = new NativeHeavyCommands({ current: () => true, claim: async () => 'finite', acquire: async () => ({ id: 'finite', release() {} }), probe: () => ++probes === 1 ? observer : final });
 const result = native.admit(ctx, { pid: 20, kind: 'build' });
 while (probes < 2) await new Promise((resolve) => setImmediate(resolve));
 native.stopAdmission(); finalDone('live');
 try { expect(await result).toMatchObject({ allow: false }); }
 finally { observerDone('gone'); await native.drain(); }
});

it('stopAdmission fences a pending physical nested borrow', async () => {
 const ctx = { token: 'finite', sessionId: 'finite', role: 'user', scope: {} } as AgentGateContext;
 let state: 'live' | 'gone' = 'live', finish!: (value: boolean) => void;
 const borrowed = new Promise<boolean>((resolve) => finish = resolve);
 const native = new NativeHeavyCommands({ current: () => true, claim: async () => 'finite', acquire: async () => ({ id: 'finite', release() {} }), probe: async () => state, borrow: () => borrowed });
 expect((await native.admit(ctx, { pid: 20, kind: 'build' })).allow).toBe(true);
 const result = native.admit(ctx, { pid: 30, kind: 'tests', leaseId: 'finite' });
 native.stopAdmission(); finish(true);
 try { expect(await result).toMatchObject({ allow: false }); }
 finally { state = 'gone'; await native.drain(); }
});

it('nested borrow refuses a flight physically released during its pending proof', async () => {
 const ctx = { token: 'finite', sessionId: 'finite', role: 'user', scope: {} } as AgentGateContext;
 let completeObserver!: (value: 'gone') => void, finishBorrow!: (value: boolean) => void;
 const observer = new Promise<'gone'>((resolve) => completeObserver = resolve);
 const borrowed = new Promise<boolean>((resolve) => finishBorrow = resolve);
 let probes = 0, releases = 0;
 const native = new NativeHeavyCommands({ current: () => true, claim: async () => 'finite', acquire: async () => ({ id: 'finite', release() { releases++; } }), probe: () => ++probes === 1 ? observer : Promise.resolve('live'), borrow: () => borrowed });
 expect((await native.admit(ctx, { pid: 20, kind: 'build' })).allow).toBe(true);
 const result = native.admit(ctx, { pid: 30, kind: 'tests', leaseId: 'finite' });
 completeObserver('gone'); await new Promise((resolve) => setImmediate(resolve));
 expect(releases).toBe(1); finishBorrow(true);
 expect(await result).toMatchObject({ allow: false }); await native.drain();
});

it('final admission refuses an older live snapshot after its concurrent observer released the flight', async () => {
 const ctx = { token: 'finite', sessionId: 'finite', role: 'user', scope: {} } as AgentGateContext;
 let completeObserver!: (value: 'gone') => void, finishFinal!: (value: 'live') => void;
 const observer = new Promise<'gone'>((resolve) => completeObserver = resolve), final = new Promise<'live'>((resolve) => finishFinal = resolve);
 let probes = 0, releases = 0;
 const native = new NativeHeavyCommands({ current: () => true, claim: async () => 'finite', acquire: async () => ({ id: 'finite', release() { releases++; } }), probe: () => ++probes === 1 ? observer : final });
 const result = native.admit(ctx, { pid: 20, kind: 'build' });
 while (probes < 2) await new Promise((resolve) => setImmediate(resolve));
 completeObserver('gone'); await new Promise((resolve) => setImmediate(resolve));
 expect(releases).toBe(1); finishFinal('live');
 expect(await result).toMatchObject({ allow: false }); await native.drain();
});

it('drain stops an owned native authority and refuses success after that authority was lost', async () => {
 const ctx = { token: 'finite', sessionId: 'finite', role: 'user', scope: {} } as AgentGateContext;
 let state: 'live' | 'gone' | 'unknown' = 'live', released = false, stops = 0;
 const native = new NativeHeavyCommands({ current: () => true, claim: async () => 'owned', probe: async () => state,
  acquire: async () => ({ id: 'finite', release() { released = true; } }), stop: async () => { stops++; if (state === 'unknown') throw new Error('native_heavy_authority_exit_unproved'); state = 'gone'; } });
 expect((await native.admit(ctx, { pid: 20, kind: 'build' })).allow).toBe(true);
 state = 'unknown'; await expect(native.drain()).rejects.toThrow('unproved'); expect(released).toBe(false);
 state = 'live'; await native.drain(); expect(stops).toBe(2); expect(released).toBe(true);
});

it('F-1434: toda recusa traz a frase do motivo, e só culpa a RAM quando a RAM faltou', async () => {
 const scope = { version: 1 as const, installationId: 'finite', projectId: 'f1434', checkoutId: 'main', rootRealPath: '/f1434', identitySource: 'manifest' as const };
 const ctx = { token: 'f1434', sessionId: 'f1434', role: 'user', scope } as AgentGateContext;
 const limits = () => ({ minFreeMB: 512, maxSwapUsedMB: 0 });
 const owned = (acquire: ConstructorParameters<typeof NativeHeavyCommands>[0]['acquire']) =>
  new NativeHeavyCommands({ current: () => true, claim: async () => 'owned', probe: async () => 'gone', acquire });
 const ownership = await new NativeHeavyCommands({ current: () => true, claim: async () => null, probe: async () => 'gone', acquire: () => Promise.reject(new Error('unreachable')) })
  .admit(ctx, { pid: 4242, kind: 'tests' });
 expect(ownership).toMatchObject({ allow: false, reason: 'heavy_command_process_ownership_unproved' });
 expect(ownership.message).toBe("nexus-heavy: could not prove that pid 4242 runs inside this agent terminal's process tree");
 const closedPool = new HeavyCommandPermitPool({ memory: () => ({ freeMB: 65_536, swapUsedMB: 0 }), limits, refreshMemory: async () => {} }); closedPool.close();
 const closed = owned((request) => closedPool.acquire(request));
 expect(await closed.admit(ctx, { pid: 4243, kind: 'tests' })).toMatchObject({ allow: false, reason: 'heavy_command_admission_denied', message: 'nexus-heavy: Nexus is shutting down and no longer admits heavy commands' });
 expect(await closed.admit(ctx, { pid: -1, kind: 'tests' })).toMatchObject({ allow: false, message: 'nexus-heavy: malformed admission request' });
 const lowRam = new HeavyCommandPermitPool({ memory: () => ({ freeMB: 1024, swapUsedMB: 0 }), limits, refreshMemory: async () => {}, pollMs: 5, waitMs: 30 });
 const ram = await owned((request) => lowRam.acquire(request)).admit(ctx, { pid: 4244, kind: 'tests' });
 expect(ram).toMatchObject({ allow: false, reason: 'heavy_command_wait_timeout' });
 expect(ram.message).toContain('(free RAM 1.0 GB below the 2.5 GB reserve)');
 const busy = new HeavyCommandPermitPool({ memory: () => ({ freeMB: 65_536, swapUsedMB: 0 }), limits, refreshMemory: async () => {}, pollMs: 5, waitMs: 30, maxActive: 1 });
 const held = await busy.acquire({ scope: { ...scope, rootRealPath: '/elsewhere' }, kind: 'tests' });
 const machine = await owned((request) => busy.acquire(request)).admit(ctx, { pid: 4245, kind: 'tests' });
 expect(machine.message).toContain('(machine limit of 1 parallel heavy jobs)');
 for (const result of [ownership, machine]) expect(result.message).not.toMatch(/RAM/);
 held.release(); lowRam.close(); busy.close();
});

it('says it is waiting on memory pressure only when the shrunk cap is what blocks the job', async () => {
 const scope = { version: 1 as const, installationId: 'finite', projectId: 'pressure', checkoutId: 'main', rootRealPath: '/pressure', identitySource: 'manifest' as const };
 const ctx = { token: 'pressure', sessionId: 'pressure', role: 'user', scope } as AgentGateContext;
 const limits = () => ({ minFreeMB: 512, maxSwapUsedMB: 0 });
 const pool = new HeavyCommandPermitPool({ memory: () => ({ freeMB: 65_536, swapUsedMB: 0 }), limits, refreshMemory: async () => {},
  pollMs: 5, waitMs: 40, maxActive: 5, pressure: () => 2 });
 const native = new NativeHeavyCommands({ current: () => true, claim: async () => 'owned', probe: async () => 'gone', acquire: (request) => pool.acquire(request) });
 const held = await Promise.all(['/other-a', '/other-b'].map((root) => pool.acquire({ scope: { ...scope, rootRealPath: root }, kind: 'tests' })));
 const blocked = await native.admit(ctx, { pid: 4246, kind: 'tests' });
 expect(blocked.message).toContain('esperando: pressão de memória');
 expect(blocked.message).not.toContain('machine 2/5');
 for (const permit of held) permit.release();
 const sameRoot = await pool.acquire({ scope, kind: 'build', sessionId: 'pressure-holder' });
 const queued = await native.admit(ctx, { pid: 4247, kind: 'tests' });
 expect(queued.message).toContain('exclusive build or install on this root');
 expect(queued.message).toContain('session pressure-holder build');
 expect(queued.message).not.toContain('one job per root');
 expect(queued.message).not.toContain('esperando: pressão de memória');
 sameRoot.release(); pool.close();
});
