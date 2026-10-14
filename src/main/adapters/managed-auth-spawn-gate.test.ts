import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_SPAWN_GATE_SKEW_MS,
  AUTH_SPAWN_GATE_TIMEOUT_MS,
  authBlobIsFreshForSpawn,
  grokSpawnUsesOAuth,
  resetManagedAuthSpawnGateForTests,
  resolveRotatingAuthFile,
  rotatingAuthLockPath,
  ROTATING_REFRESH_SPAWN_ADAPTERS,
  waitForRotatingAuthSpawnGate,
} from './managed-auth-spawn-gate';

function jwtExp(expSec: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: expSec })).toString(
    'base64url',
  );
  return `eyJhbGciOiJSUzI1NiJ9.${payload}.sig`;
}

function blob(opts: { expSec?: number; lastRefresh?: string }): string {
  return JSON.stringify({
    ...(opts.lastRefresh ? { last_refresh: opts.lastRefresh } : {}),
    tokens: {
      access_token: jwtExp(opts.expSec ?? Math.floor(Date.now() / 1000) + 3600),
      refresh_token: 'rt-1',
    },
  });
}

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-codex-auth-gate-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  resetManagedAuthSpawnGateForTests();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('authBlobIsFreshForSpawn', () => {
  it('coordinates native and managed copies of one Grok refresh family', async () => {
    const home = tempDir();
    const nativeFile = path.join(home, 'native.json');
    const managedFile = path.join(home, 'managed.json');
    let now = 1_790_000_000_000;
    const grok = (exp: number, refresh = 'same-refresh') => JSON.stringify({ issuer: {
      user_id: 'grok-a', key: jwtExp(exp), refresh_token: refresh,
    } });
    const stale = grok(now / 1000 - 60);
    fs.writeFileSync(nativeFile, stale); fs.writeFileSync(managedFile, stale);
    expect(await waitForRotatingAuthSpawnGate({ authFile: nativeFile, now: () => now })).toBe('leader');
    const fresh = grok(now / 1000 + 7200, 'rotated-refresh');
    const follower = waitForRotatingAuthSpawnGate({ authFile: managedFile, now: () => now, sleep: async () => {
      now += 50; fs.writeFileSync(nativeFile, fresh);
    } });
    expect(await follower).toBe('follower-fresh');
    expect(fs.readFileSync(managedFile, 'utf8')).toBe(fresh);
    expect(fs.existsSync(rotatingAuthLockPath(managedFile))).toBe(false);
  });

  it('recognizes the nested Grok OAuth expiry and gates its shared auth file', () => {
    const now = Date.now();
    const grok = JSON.stringify({ issuer: { key: jwtExp(Math.floor(now / 1000) + 3600), user_id: 'grok-a' } });
    expect(authBlobIsFreshForSpawn(grok, now)).toBe(true);
    expect(ROTATING_REFRESH_SPAWN_ADAPTERS.has('grok')).toBe(true);
    expect(resolveRotatingAuthFile('grok', { GROK_HOME: '/managed/grok' })).toBe('/managed/grok/auth.json');
  });

  it('treats a JWT more than skew away as fresh', () => {
    const now = 1_700_000_000_000;
    const expSec = Math.floor((now + AUTH_SPAWN_GATE_SKEW_MS + 60_000) / 1000);
    expect(authBlobIsFreshForSpawn(blob({ expSec }), now)).toBe(true);
  });

  it('treats a JWT inside the skew window as stale so spawns serialize', () => {
    const now = 1_700_000_000_000;
    const expSec = Math.floor((now + AUTH_SPAWN_GATE_SKEW_MS - 1_000) / 1000);
    expect(authBlobIsFreshForSpawn(blob({ expSec }), now)).toBe(false);
  });

  it('reuses a token rotated in the last minute even if exp is unreadable', () => {
    const now = Date.parse('2026-09-16T16:00:00.000Z');
    const raw = JSON.stringify({
      last_refresh: '2026-09-16T15:59:30.000Z',
      tokens: { access_token: 'not-a-jwt', refresh_token: 'rt' },
    });
    expect(authBlobIsFreshForSpawn(raw, now)).toBe(true);
  });
});

describe('F-1485: sessão do Grok vencida além da renovação', () => {
  const DAY = 24 * 3600_000;
  function grokSession(mintedAtMs: number): string {
    const iat = Math.floor(mintedAtMs / 1000);
    const payload = Buffer.from(JSON.stringify({ iat, exp: iat + 6 * 3600 })).toString('base64url');
    return JSON.stringify({ 'https://auth.x.ai::acct-sintetica': {
      user_id: 'grok-sintetico',
      key: `eyJhbGciOiJSUzI1NiJ9.${payload}.sig`,
      refresh_token: 'rt-sintetico',
      create_time: new Date(mintedAtMs).toISOString(),
      expires_at: new Date(mintedAtMs + 6 * 3600_000).toISOString(),
    } });
  }

  it('worker: recusa na hora com o caminho do login, sem abrir pane que fica preso no código do navegador', async () => {
    const authFile = path.join(tempDir(), 'auth.json');
    const now = Date.parse('2026-10-13T23:20:00Z');
    fs.writeFileSync(authFile, grokSession(Date.parse('2026-09-30T22:30:58Z')));
    await expect(
      waitForRotatingAuthSpawnGate({ authFile, now: () => now, refuseExpiredGrokSession: true }),
    ).rejects.toThrow(/grok login/);
    expect(fs.existsSync(rotatingAuthLockPath(authFile))).toBe(false);
  });

  it('dentro dos 7 dias o token vencido segue renovável: o primeiro pane lidera a renovação', async () => {
    const authFile = path.join(tempDir(), 'auth.json');
    const now = Date.parse('2026-10-13T23:20:00Z');
    fs.writeFileSync(authFile, grokSession(now - 2 * DAY));
    expect(await waitForRotatingAuthSpawnGate({ authFile, now: () => now, refuseExpiredGrokSession: true })).toBe('leader');
  });

  it('pane do operador passa mesmo vencido: é onde ele aprova o login no navegador', async () => {
    const authFile = path.join(tempDir(), 'auth.json');
    const now = Date.parse('2026-10-13T23:20:00Z');
    fs.writeFileSync(authFile, grokSession(now - 13 * DAY));
    expect(await waitForRotatingAuthSpawnGate({ authFile, now: () => now })).toBe('leader');
  });

  it('só sessão OAuth entra na trava: API key/token injetado não depende do OAuth', () => {
    expect(grokSpawnUsesOAuth({ GROK_HOME: '/managed/grok-a' })).toBe(true);
    expect(grokSpawnUsesOAuth({})).toBe(true);
    expect(grokSpawnUsesOAuth({ XAI_API_KEY: 'xai-sintetica' })).toBe(false);
    expect(grokSpawnUsesOAuth({ XAI_API_KEY: '  ' })).toBe(true);
  });

  it('access token ainda válido nunca é recusado', async () => {
    const authFile = path.join(tempDir(), 'auth.json');
    const now = Date.parse('2026-10-13T23:20:00Z');
    fs.writeFileSync(authFile, grokSession(now - 60_000));
    expect(await waitForRotatingAuthSpawnGate({ authFile, now: () => now, refuseExpiredGrokSession: true })).toBe('fresh');
  });
});

describe('resolveRotatingAuthFile', () => {
  it('gates supported rotating providers and points at the shared auth.json (managed or native)', () => {
    expect(ROTATING_REFRESH_SPAWN_ADAPTERS.has('codex')).toBe(true);
    expect(ROTATING_REFRESH_SPAWN_ADAPTERS.has('claude')).toBe(false);
    const home = tempDir();
    expect(resolveRotatingAuthFile('codex', undefined, home)).toBe(
      path.join(home, '.codex', 'auth.json'),
    );
    expect(resolveRotatingAuthFile('codex', { CODEX_HOME: path.join(home, '.nexus', 'managed-accounts', 'codex', 'acct-1', 'home') }, home)).toBe(
      path.join(
        home,
        '.nexus',
        'managed-accounts',
        'codex',
        'acct-1',
        'home',
        'auth.json',
      ),
    );
    expect(resolveRotatingAuthFile('kimi', { KIMI_CODE_HOME: home }, home)).toBeNull();
  });
});

describe('waitForRotatingAuthSpawnGate', () => {
  it('lets every pane through when the access token is still fresh', async () => {
    const dir = tempDir();
    const authFile = path.join(dir, 'auth.json');
    const now = 1_700_000_000_000;
    fs.writeFileSync(
      authFile,
      blob({ expSec: Math.floor((now + 3_600_000) / 1000) }),
    );
    const roles = await Promise.all([
      waitForRotatingAuthSpawnGate({ authFile, now: () => now }),
      waitForRotatingAuthSpawnGate({ authFile, now: () => now }),
      waitForRotatingAuthSpawnGate({ authFile, now: () => now }),
    ]);
    expect(roles).toEqual(['fresh', 'fresh', 'fresh']);
    expect(fs.existsSync(rotatingAuthLockPath(authFile))).toBe(false);
  });

  it('serializes stale-token spawns: followers reuse the rewritten token', async () => {
    const dir = tempDir();
    const authFile = path.join(dir, 'auth.json');
    let now = 1_700_000_000_000;
    const staleExp = Math.floor((now + 30_000) / 1000);
    fs.writeFileSync(authFile, blob({ expSec: staleExp }));

    const sleeps: Array<() => void> = [];
    const sleep = () =>
      new Promise<void>((resolve) => {
        sleeps.push(resolve);
      });

    const leader = waitForRotatingAuthSpawnGate({
      authFile,
      now: () => now,
      sleep,
      timeoutMs: 5_000,
      pollMs: 10,
    });
    expect(await leader).toBe('leader');
    expect(fs.existsSync(rotatingAuthLockPath(authFile))).toBe(true);

    const follower = waitForRotatingAuthSpawnGate({
      authFile,
      now: () => now,
      sleep,
      timeoutMs: 5_000,
      pollMs: 10,
    });
    // Follower is waiting on the lock. Rotate the shared auth.json like Codex
    // would after a successful refresh.
    await vi.waitFor(() => expect(sleeps.length).toBeGreaterThan(0));
    fs.writeFileSync(
      authFile,
      blob({
        expSec: Math.floor((now + 3_600_000) / 1000),
        lastRefresh: new Date(now).toISOString(),
      }),
    );
    now += 20;
    sleeps.splice(0).forEach((resume) => resume());
    expect(await follower).toBe('follower-fresh');
  });

  it('gives independent managed accounts distinct refresh locks', async () => {
    const home = tempDir();
    const now = 1_700_000_000_000;
    const authFiles = ['account-a', 'account-b'].map((account) => {
      const providerHome = path.join(home, account);
      fs.mkdirSync(providerHome);
      const authFile = resolveRotatingAuthFile('codex', { CODEX_HOME: providerHome }, home)!;
      fs.writeFileSync(authFile, blob({ expSec: Math.floor(now / 1000) }));
      return authFile;
    });
    expect(await Promise.all(authFiles.map((authFile) =>
      waitForRotatingAuthSpawnGate({ authFile, now: () => now }),
    ))).toEqual(['leader', 'leader']);
    expect(authFiles[0]).not.toBe(authFiles[1]);
    for (const authFile of authFiles) expect(fs.existsSync(rotatingAuthLockPath(authFile))).toBe(true);
  });

  it('rejects timed-out followers rather than spawning with the stale refresh token', async () => {
    const dir = tempDir();
    const authFile = path.join(dir, 'auth.json');
    let now = 1_700_000_000_000;
    fs.writeFileSync(
      authFile,
      blob({ expSec: Math.floor((now + 1_000) / 1000) }),
    );
    expect(
      await waitForRotatingAuthSpawnGate({
        authFile,
        now: () => now,
        timeoutMs: 40,
        pollMs: 10,
      }),
    ).toBe('leader');

    const follower = waitForRotatingAuthSpawnGate({
      authFile,
      now: () => now,
      sleep: async () => {
        now += 20;
      },
      timeoutMs: 40,
      pollMs: 10,
    });
    await expect(follower).rejects.toThrow(/renovação.*login.*tente/i);
  });

  it('does not promote a waiting follower when its deadline outlasts the leader lock', async () => {
    const authFile = path.join(tempDir(), 'auth.json');
    let now = 1_700_000_000_000;
    fs.writeFileSync(authFile, blob({ expSec: Math.floor(now / 1000) }));
    expect(await waitForRotatingAuthSpawnGate({ authFile, now: () => now, timeoutMs: 40 })).toBe('leader');
    await expect(waitForRotatingAuthSpawnGate({
      authFile, now: () => now, timeoutMs: 40,
      sleep: async () => { now += 50; },
    })).rejects.toThrow(/renovação.*login.*tente/i);
  });

  it('steals a stale lock left by a crashed leader', async () => {
    const dir = tempDir();
    const authFile = path.join(dir, 'auth.json');
    const now = 1_700_000_000_000;
    fs.writeFileSync(
      authFile,
      blob({ expSec: Math.floor((now + 1_000) / 1000) }),
    );
    fs.writeFileSync(
      rotatingAuthLockPath(authFile),
      JSON.stringify({ pid: 1, at: now - AUTH_SPAWN_GATE_TIMEOUT_MS - 1 }),
    );
    expect(
      await waitForRotatingAuthSpawnGate({
        authFile,
        now: () => now,
        timeoutMs: AUTH_SPAWN_GATE_TIMEOUT_MS,
      }),
    ).toBe('leader');
  });
});
