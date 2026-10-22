import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), gate: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('../adapters/managed-auth-spawn-gate', async (load) => ({ ...await load<object>(), waitForRotatingAuthSpawnGate: mocks.gate }));
vi.mock('../path-resolver', () => ({ resolveCliBinary: () => ({ binPath: '/cli/grok' }) }));
import { probeGrokCliUsage } from './grok-cli-usage';

let home: string;
let file: string;
let methods: string[];
const auth = (subject = 'grok-a', fresh = false) => JSON.stringify({ issuer: {
  user_id: subject, refresh_token: 'fixture-refresh', key: `x.${Buffer.from(JSON.stringify({ exp: Date.now() / 1000 + (fresh ? 7200 : -3600) })).toString('base64url')}.x`,
} });
function server(error?: { message: string }) {
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stdin: Writable; kill: ReturnType<typeof vi.fn> };
  child.stdout = new PassThrough();
  child.kill = vi.fn(() => { queueMicrotask(() => child.emit('close', 0)); return true; });
  child.stdin = new Writable({ write(chunk, _encoding, done) {
    const r = JSON.parse(chunk.toString()); methods.push(r.method);
    queueMicrotask(() => {
      if (r.method === 'authenticate' && !error) fs.writeFileSync(file, auth('grok-a', true));
      child.stdout.write(JSON.stringify({ id: r.id, ...(r.method === 'authenticate' && error ? { error } : {
        result: r.method === 'initialize' ? { authMethods: [{ id: 'cached_token' }] } : {},
      }) }) + '\n');
    }); done();
  } }); mocks.spawn.mockReturnValue(child); return child;
}
const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ config: { creditUsagePercent: 6 } }), text: async () => '' });
beforeEach(() => { vi.clearAllMocks(); mocks.gate.mockResolvedValue('leader'); methods = []; home = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-auth-test-')); file = path.join(home, 'auth.json'); fs.writeFileSync(file, auth()); });
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));
it('renews only cached auth, reads quota, and coalesces concurrent requests without prompts', async () => {
  const child = server();
  const options = { authFile: file, expectedAuthBlob: auth(), fetchImpl };
  const results = await Promise.all([probeGrokCliUsage(options), probeGrokCliUsage(options)]);
  expect(results.map(r => r.windows?.[0].usedRatio)).toEqual([0.06, 0.06]);
  expect(methods).toEqual(['initialize', 'authenticate']);
  expect(mocks.spawn).toHaveBeenCalledTimes(1);
  expect(child.kill).toHaveBeenCalled();
});
it('refuses another account before spawning', async () => {
  server();
  expect((await probeGrokCliUsage({ authFile: file, expectedAuthBlob: auth('grok-b'), fetchImpl })).windows).toBeNull();
  expect(methods).toEqual([]);
});
it('rejects identity replacement while waiting for renewal', async () => {
  server(); mocks.gate.mockImplementation(async () => { fs.writeFileSync(file, auth('grok-b')); });
  expect((await probeGrokCliUsage({ authFile: file, expectedAuthBlob: auth(), fetchImpl })).windows).toBeNull();
  expect(methods).toEqual([]);
});
it.each([
  ['invalid_grant', 'auth-expired'],
  ['token_revoked', 'auth-expired'],
  ['refresh_token_reused', 'auth-expired'],
  ['refresh_token_expired', 'auth-expired'],
  ['refresh_token_invalidated', 'auth-expired'],
  ['network unavailable', 'unavailable'],
])('distinguishes renewal failure %s', async (message, hint) => {
  server({ message });
  expect((await probeGrokCliUsage({ authFile: file, expectedAuthBlob: auth(), fetchImpl })).hint).toBe(hint);
});
it('reuses a session renewed by a pane without another CLI auth call', async () => {
  server(); mocks.gate.mockImplementation(async () => { fs.writeFileSync(file, auth('grok-a', true)); });
  expect((await probeGrokCliUsage({ authFile: file, expectedAuthBlob: auth(), fetchImpl })).windows?.[0].usedRatio).toBe(0.06);
  expect(methods).toEqual([]);
});
