import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AUTH_SPAWN_GATE_SKEW_MS,
  AUTH_SPAWN_GATE_TIMEOUT_MS,
  authBlobIsFreshForSpawn,
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
  return `hdr.${payload}.sig`;
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

describe('resolveRotatingAuthFile', () => {
  it('only gates Codex and points at the shared auth.json (managed or native)', () => {
    expect(ROTATING_REFRESH_SPAWN_ADAPTERS.has('codex')).toBe(true);
    expect(ROTATING_REFRESH_SPAWN_ADAPTERS.has('claude')).toBe(false);
    const home = tempDir();
    expect(resolveRotatingAuthFile('codex', undefined, home)).toBe(
      path.join(home, '.codex', 'auth.json'),
    );
    expect(resolveRotatingAuthFile('codex', 'acct-1', home)).toBe(
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
    expect(resolveRotatingAuthFile('kimi', 'acct-1', home)).toBeNull();
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
    for (let i = 0; i < 20 && sleeps.length === 0; i += 1) {
      await Promise.resolve();
    }
    expect(sleeps.length).toBeGreaterThan(0);
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

  it('times out instead of blocking the pane forever', async () => {
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
    expect(await follower).toBe('timeout');
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
