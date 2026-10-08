import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), gate: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('../adapters/managed-auth-spawn-gate', async (importOriginal) => ({
  ...(await importOriginal<object>()), waitForRotatingAuthSpawnGate: mocks.gate,
}));
vi.mock('../path-resolver', () => ({ resolveCliBinary: () => ({ binPath: '/cli/codex' }) }));

import { fetchCodexCliUsage, parseCodexCliRateLimits, probeCodexCliUsage } from './codex-cli-usage';

const NOW = 1_790_000_000_000;
const auth = (subject = 'account-a', fresh = false) => JSON.stringify({
  tokens: { account_id: subject, access_token: `x.${Buffer.from(JSON.stringify({
    exp: NOW / 1000 + (fresh ? 7200 : -3600),
  })).toString('base64url')}.x`, refresh_token: 'private-refresh' },
});
const usage = { accountId: 'account-a', rateLimits: {
  primary: { usedPercent: 8, windowDurationMins: 300, resetsAt: NOW / 1000 + 3600 },
  secondary: { usedPercent: 60, windowDurationMins: 10080, resetsAt: NOW / 1000 + 86400 },
} };
let home: string;
let authFile: string;
let requests: Array<{ id?: number; method: string; params?: Record<string, unknown> }>;

function fakeServer(onRequest?: (request: typeof requests[number]) => unknown) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough; stdin: Writable; kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.kill = vi.fn(() => { queueMicrotask(() => child.emit('close', 0)); return true; });
  child.stdin = new Writable({ write(chunk, _encoding, callback) {
    const request = JSON.parse(chunk.toString()) as typeof requests[number];
    requests.push(request);
    queueMicrotask(() => {
      const override = onRequest?.(request);
      if (override === false || !request.id) return;
      const result = override ?? (request.method === 'account/rateLimits/read' ? usage
        : request.method === 'account/read' ? { account: { type: 'chatgpt' } } : {});
      const error = typeof result === 'object' && result !== null && '$error' in result ? result.$error : undefined;
      child.stdout.write(`${JSON.stringify(error ? { id: request.id, error } : { id: request.id, result })}\n`);
    });
    callback();
  } });
  mocks.spawn.mockReturnValue(child);
  return child;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.gate.mockResolvedValue('leader');
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-codex-quota-test-'));
  authFile = path.join(home, 'auth.json');
  fs.writeFileSync(authFile, auth());
  requests = [];
});
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

describe('parseCodexCliRateLimits', () => {
  it('normalizes both API windows without inventing missing usage', () => {
    expect(parseCodexCliRateLimits(usage, NOW)).toMatchObject([
      { kind: 'hours', usedRatio: 0.08, resetsAt: NOW + 3600_000 },
      { kind: 'weekly', usedRatio: 0.6 },
    ]);
    expect(parseCodexCliRateLimits({ rateLimits: { primary: { usedPercent: null } } }, NOW)).toEqual([]);
  });
});

describe('fetchCodexCliUsage', () => {
  it('uses only account RPCs and serializes CLI renewal for the exact durable auth file', async () => {
    const child = fakeServer();
    const windows = await fetchCodexCliUsage({ authFile, expectedAuthBlob: auth(), now: NOW });
    expect(windows).toHaveLength(2);
    expect(mocks.gate).toHaveBeenCalledWith({ authFile });
    expect(mocks.spawn).toHaveBeenCalledWith('/cli/codex', expect.arrayContaining([
      'app-server', 'cli_auth_credentials_store="file"',
    ]), expect.objectContaining({ env: expect.objectContaining({ CODEX_HOME: home }), shell: false }));
    // F-964 (PRV-03): o mesmo processo também lista os modelos da conta.
    expect(requests.map(r => r.method)).toEqual([
      'initialize', 'initialized', 'account/read', 'account/rateLimits/read', 'model/list',
    ]);
    expect(requests.find(r => r.method === 'account/read')?.params).toEqual({ refreshToken: true });
    expect(child.kill).toHaveBeenCalled();
  });

  it('does not request renewal when another pane already refreshed the shared credential', async () => {
    mocks.gate.mockImplementation(async () => { fs.writeFileSync(authFile, auth('account-a', true)); return 'follower-fresh'; });
    fakeServer();
    await fetchCodexCliUsage({ authFile, expectedAuthBlob: auth(), now: NOW });
    expect(requests.find(r => r.method === 'account/read')?.params).toEqual({ refreshToken: false });
  });

  it('refuses mismatched, missing, or unidentifiable account credentials before spawning', async () => {
    fakeServer();
    expect(await fetchCodexCliUsage({ authFile, expectedAuthBlob: auth('account-b'), now: NOW })).toBeNull();
    fs.writeFileSync(authFile, JSON.stringify({ tokens: { access_token: 'opaque' } }));
    expect(await fetchCodexCliUsage({ authFile, expectedAuthBlob: fs.readFileSync(authFile, 'utf8'), now: NOW })).toBeNull();
    fs.rmSync(authFile);
    expect(await fetchCodexCliUsage({ authFile, expectedAuthBlob: auth(), now: NOW })).toBeNull();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('fails closed if identity changes while waiting for the shared renewal gate', async () => {
    mocks.gate.mockImplementation(async () => { fs.writeFileSync(authFile, auth('account-b')); });
    fakeServer();
    expect(await fetchCodexCliUsage({ authFile, expectedAuthBlob: auth(), now: NOW })).toBeNull();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('rejects a different account in the provider response or renewed file', async () => {
    fakeServer(r => r.method === 'account/rateLimits/read' ? { ...usage, accountId: 'account-b' } : undefined);
    expect(await fetchCodexCliUsage({ authFile, expectedAuthBlob: auth(), now: NOW })).toBeNull();
    fakeServer(r => {
      if (r.method === 'account/rateLimits/read') fs.writeFileSync(authFile, auth('account-b'));
    });
    expect(await fetchCodexCliUsage({ authFile, expectedAuthBlob: auth(), now: NOW })).toBeNull();
  });

  it('kills a stalled CLI within the bound and handles unavailable binaries without secrets', async () => {
    const child = fakeServer(() => false);
    expect(await fetchCodexCliUsage({ authFile, expectedAuthBlob: auth(), now: NOW, timeoutMs: 10 })).toBeNull();
    expect(child.kill).toHaveBeenCalled();
    mocks.spawn.mockImplementation(() => { throw new Error('private-token-error'); });
    expect(await fetchCodexCliUsage({ authFile, expectedAuthBlob: auth(), now: NOW })).toBeNull();
  });

  it('rejects API-key mode and prevents inherited keys from replacing the saved login', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'ambient-key');
    vi.stubEnv('CODEX_API_KEY', 'other-key');
    try {
      fakeServer(r => r.method === 'account/read' ? { account: { type: 'apiKey' } } : undefined);
      expect(await fetchCodexCliUsage({ authFile, expectedAuthBlob: auth(), now: NOW })).toBeNull();
      const env = mocks.spawn.mock.calls[0][2].env;
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.CODEX_API_KEY).toBeUndefined();
      expect(requests.some(r => r.method === 'account/rateLimits/read')).toBe(false);
    } finally { vi.unstubAllEnvs(); }
  });

  it('stops on protocol errors and bounds untrusted stdout', async () => {
    let child = fakeServer(() => false);
    let result = fetchCodexCliUsage({ authFile, expectedAuthBlob: auth(), now: NOW });
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());
    child.stdout.write(`${JSON.stringify({ id: 1, error: { message: 'private-error' } })}\n`);
    expect(await result).toBeNull();
    child = fakeServer(() => false);
    result = fetchCodexCliUsage({ authFile, expectedAuthBlob: auth(), now: NOW });
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(2));
    child.stdout.write('x'.repeat(256 * 1024 + 1));
    expect(await result).toBeNull();
    expect(child.kill).toHaveBeenCalled();
  });

  it('reports revoked login distinctly when account/read hides refresh failure but usage rejects it', async () => {
    fakeServer(r => r.method === 'account/rateLimits/read'
      ? { $error: { code: -32603, message: '401 Unauthorized: token_revoked' } } : undefined);
    expect(await probeCodexCliUsage({ authFile, expectedAuthBlob: auth(), now: NOW }))
      .toEqual({ windows: null, failure: 'auth-expired' });
    fakeServer(r => r.method === 'account/rateLimits/read'
      ? { $error: { code: -32603, message: '503 temporarily unavailable' } } : undefined);
    expect(await probeCodexCliUsage({ authFile, expectedAuthBlob: auth(), now: NOW }))
      .toEqual({ windows: null, failure: 'unavailable' });
  });

  it('reports expired login when CLI clears the account after a failed renewal', async () => {
    fakeServer(r => r.method === 'account/read' ? { account: null, requiresOpenaiAuth: true } : undefined);
    expect(await probeCodexCliUsage({ authFile, expectedAuthBlob: auth(), now: NOW }))
      .toEqual({ windows: null, failure: 'auth-expired' });
  });
});

describe('F-964 (PRV-03) — model/list no mesmo app-server da cota', () => {
  const model = (id: string, extra: Record<string, unknown> = {}) => ({
    id, model: id, displayName: id, description: '', hidden: false, isDefault: false,
    defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '' }], ...extra,
  });

  it('um spawn: cota + listagem paginada (2 páginas, 1 hidden) do CODEX_HOME da conta', async () => {
    fakeServer((request) => {
      if (request.method !== 'model/list') return undefined;
      return request.params?.cursor === 'p2'
        ? { data: [model('x-luna')], nextCursor: null }
        : { data: [model('x-sol', { isDefault: true }), model('x-hidden', { hidden: true })], nextCursor: 'p2' };
    });
    const probe = await probeCodexCliUsage({ authFile, expectedAuthBlob: auth(), now: NOW });
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(mocks.spawn.mock.calls[0][2].env.CODEX_HOME).toBe(home);
    expect(probe.windows).toHaveLength(2);
    expect(probe.models?.ids).toEqual(['x-sol', 'x-luna']);
    expect(probe.models?.hidden).toEqual(['x-hidden']);
    expect(probe.models?.defaultModel).toBe('x-sol');
    expect(requests.filter(r => r.method === 'model/list').map(r => r.params)).toEqual([{}, { cursor: 'p2' }]);
  });

  it('listagem que falha não custa a cota', async () => {
    fakeServer((request) => request.method === 'model/list'
      ? { $error: { code: -32601, message: 'method not found' } } : undefined);
    const probe = await probeCodexCliUsage({ authFile, expectedAuthBlob: auth(), now: NOW });
    expect(probe.windows).toHaveLength(2);
    expect(probe.models).toBeUndefined();
  });

  it('listagem que não responde também não custa a cota (folga curta)', async () => {
    fakeServer((request) => (request.method === 'model/list' ? false : undefined));
    const started = Date.now();
    const probe = await probeCodexCliUsage({ authFile, expectedAuthBlob: auth(), now: NOW });
    expect(probe.windows).toHaveLength(2);
    expect(probe.models).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
