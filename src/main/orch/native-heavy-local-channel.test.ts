import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fork, spawn } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() }, utilityProcess: { fork: () => { throw new Error('production utility process must use explicit Node test port'); } } }));
import { createNativeHeavyLocalChannel, type HeavyLocalChannelPorts, type NativeHeavyLocalChannel } from './native-heavy-local-channel';
import type { AgentGateContext } from './gate';

function nodeTestPort(tamper = false): HeavyLocalChannelPorts['spawn'] {
  return (entry, cwd) => {
    const child = fork(entry, [], { cwd, execPath: process.execPath, execArgv: [], env: { PATH: '/usr/bin:/bin', LANG: 'C' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    return { on: (event, callback) => child.on(event, callback), kill: () => child.kill(), postMessage: message => {
      const value = message as { type: string; raw?: string };
      if (tamper && value.type === 'response') { const reply = JSON.parse(value.raw!); reply.result = { allow: true, leaseId: 'forged' }; value.raw = JSON.stringify(reply); }
      child.send(message as Parameters<typeof child.send>[0]);
    } };
  };
}
async function request(channel: NativeHeavyLocalChannel) {
  const child = spawn(process.execPath, [path.join(process.cwd(), 'resources/heavy-command/request.cjs'), String(process.pid), 'build'], {
    env: { ...channel.env, NEXUS_HEAVY_COMMAND_URL: 'http://127.0.0.1:1234/hook/heavy-command', NEXUS_GATE_TOKEN: 'finite-scoped', NEXUS_HEAVY_CURL: '/usr/bin/curl' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', error = ''; child.stdout.on('data', part => output += part); child.stderr.on('data', part => error += part);
  return { code: await new Promise<number | null>(resolve => child.once('close', resolve)), output, error };
}
const ctx = { token: 'finite-scoped', sessionId: 'finite-session', role: 'user' } as AgentGateContext;
async function rawRequest(channel: NativeHeavyLocalChannel, packet: unknown) {
 const child = spawn('/usr/bin/curl', ['--disable', '--silent', '--max-time', '0.3', '--unix-socket', 'heavy.sock', '--data-binary', JSON.stringify(packet), 'http://127.0.0.1/hook/heavy-command'], { cwd: channel.env.NEXUS_HEAVY_CHANNEL_DIR, env: {}, stdio: ['ignore', 'pipe', 'ignore'] });
 let output = ''; child.stdout.on('data', part => output += part); await new Promise(resolve => child.once('close', resolve)); return output;
}
function packet(channel: NativeHeavyLocalChannel, id = randomUUID()) {
 const issuedAt = Date.now(), body = { pid: process.pid, kind: 'build' };
 const mac = createHmac('sha256', Buffer.from(channel.env.NEXUS_HEAVY_CHANNEL_KEY, 'hex')).update(JSON.stringify([id, issuedAt, body])).digest('hex'); return { id, issuedAt, body, mac };
}
it.runIf(process.platform === 'darwin')('a real Unix channel authenticates a Main reply with a long private path and exact context', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexus-heavy-local-')); let calls = 0;
  const channel = await createNativeHeavyLocalChannel(ctx, root, { spawn: nodeTestPort(), current: value => value === ctx, admit: async (value, body) => {
    expect(value).toBe(ctx); expect(body).toMatchObject({ pid: process.pid, kind: 'build' }); calls++; return { allow: true, leaseId: 'finite-lease' };
  } });
  try { expect(await request(channel)).toEqual({ code: 0, output: 'finite-lease', error: '' }); expect(calls).toBe(1); }
  finally { await channel.dispose(); await fsp.rmdir(root); }
});
it.runIf(process.platform === 'darwin')('a tampered allow/lease reply never starts work', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexus-heavy-local-'));
  const channel = await createNativeHeavyLocalChannel(ctx, root, { spawn: nodeTestPort(true), current: () => true, admit: async () => ({ allow: false }) });
  try { expect((await request(channel)).code).toBe(78); }
  finally { await channel.dispose(); await fsp.rmdir(root); }
});
it.runIf(process.platform === 'darwin')('a late admission after context change receives only a signed denial', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexus-heavy-local-')); let current = true;
  const channel = await createNativeHeavyLocalChannel(ctx, root, { spawn: nodeTestPort(), current: () => current, admit: async () => { current = false; return { allow: true, leaseId: 'late-lease' }; } });
  try { expect((await request(channel)).code).toBe(78); }
  finally { await channel.dispose(); await fsp.rmdir(root); }
});
it.runIf(process.platform === 'darwin')('transport exit preserves a foreign replacement socket pathname and cleanup failure retries', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexus-heavy-local-'));
  const channel = await createNativeHeavyLocalChannel(ctx, root, { spawn: nodeTestPort(), current: () => true, admit: async () => ({ allow: false }) });
  const directory = channel.env.NEXUS_HEAVY_CHANNEL_DIR, socket = path.join(directory, 'heavy.sock'), moved = path.join(root, 'moved.sock');
  fs.renameSync(socket, moved); fs.writeFileSync(socket, 'foreign-fixture');
  await expect(channel.dispose()).rejects.toThrow('socket_changed'); expect(fs.readFileSync(socket, 'utf8')).toBe('foreign-fixture');
  fs.unlinkSync(socket); await channel.dispose(); fs.unlinkSync(moved); await fsp.rmdir(root);
});
it.runIf(process.platform === 'darwin')('replay and wrong request MAC never call Main admission twice', async () => {
 const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexus-heavy-local-')); let calls = 0;
 const channel = await createNativeHeavyLocalChannel(ctx, root, { spawn: nodeTestPort(), current: () => true, admit: async () => { calls++; return { allow: false }; } });
 try {
  const value = packet(channel); expect(JSON.parse(await rawRequest(channel, value)).result.allow).toBe(false);
  await rawRequest(channel, value); await rawRequest(channel, { ...packet(channel), mac: '0'.repeat(64) }); expect(calls).toBe(1);
 } finally { await channel.dispose(); await fsp.rmdir(root); }
});
it.runIf(process.platform === 'darwin')('disconnect aborts admission and dispose waits its observed completion before removing the channel', async () => {
 const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexus-heavy-local-')); let entered!: () => void, finish!: () => void, notifyAbort!: () => void, aborted = false;
 const started = new Promise<void>(resolve => entered = resolve);
 const observedAbort = new Promise<void>(resolve => notifyAbort = resolve);
 const channel = await createNativeHeavyLocalChannel(ctx, root, { spawn: nodeTestPort(), current: () => true, admit: async (_ctx, _body, signal) => { signal.addEventListener('abort', () => { aborted = true; notifyAbort(); }); entered(); await new Promise<void>(resolve => finish = resolve); return { allow: true, leaseId: 'late' }; } });
 try {
  const request = rawRequest(channel, packet(channel)); await started; await request; await observedAbort; expect(aborted).toBe(true);
  let done = false; const closing = channel.dispose().then(() => done = true); await Promise.resolve(); expect(done).toBe(false); expect(fs.existsSync(channel.env.NEXUS_HEAVY_CHANNEL_DIR)).toBe(true);
  finish(); await closing;
 } finally { finish?.(); await channel.dispose(); await fsp.rmdir(root); }
});
