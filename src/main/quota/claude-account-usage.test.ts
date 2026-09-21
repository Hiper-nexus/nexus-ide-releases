import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuotaWindow } from '../../shared/quota-types';

const mocks = vi.hoisted(() => ({
  getAccount: vi.fn(),
  getSecret: vi.fn<(key: string) => string | null>(),
  hasManagedClaudeAuth: vi.fn(() => false),
  managedClaudeAuthDirectory: vi.fn((id: string) => `/managed/${id}/auth`),
  materializeManagedClaudeAuth: vi.fn(),
  fetchClaudeCliUsageWindows: vi.fn(),
  claudeBlobIsExpiredUnhealable: vi.fn(() => false),
}));

vi.mock('../persistence/account-store', () => ({
  getAccount: mocks.getAccount,
}));

vi.mock('../persistence/secrets-store', () => ({
  getSecret: mocks.getSecret,
}));

vi.mock('../adapters/managed-claude-auth', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  hasManagedClaudeAuth: mocks.hasManagedClaudeAuth,
  managedClaudeAuthDirectory: mocks.managedClaudeAuthDirectory,
  materializeManagedClaudeAuth: mocks.materializeManagedClaudeAuth,
}));

vi.mock('./claude-oauth-usage', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchClaudeCliUsageWindows: mocks.fetchClaudeCliUsageWindows,
}));

vi.mock('./claude-oauth-refresh', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  claudeBlobIsExpiredUnhealable: mocks.claudeBlobIsExpiredUnhealable,
}));

import {
  CLAUDE_USAGE_CACHE_FRESH_MS,
  clearClaudeConfigSnapshotCache,
  discoverClaudeProfiles,
  fetchClaudeAccountUsageWindows,
  parseClaudeCachedUtilization,
  readClaudeConfigSnapshot,
} from './claude-account-usage';
import { CLAUDE_MANAGED_AUTH_ENV } from '../adapters/managed-claude-auth';

const NOW = Date.parse('2026-09-20T20:00:00Z');

const tempHomes: string[] = [];

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-claude-acct-'));
  tempHomes.push(home);
  return home;
}

function cliWindow(label: string, ratio: number): QuotaWindow {
  return {
    kind: 'weekly',
    label,
    usedRatio: ratio,
    source: 'provider-api',
    confidence: 'medium',
  };
}

function writeClaudeJson(
  file: string,
  data: Record<string, unknown>,
): void {
  fs.writeFileSync(file, JSON.stringify(data));
}

function usagePayload(percent: number, fetchedAtMs: number) {
  return {
    fetchedAtMs,
    accountUuid: 'uuid-1',
    utilization: {
      five_hour: { utilization: 1, resets_at: '2026-09-20T23:19:59Z' },
      seven_day: { utilization: percent, resets_at: '2026-09-23T03:59:59Z' },
      limits: [
        {
          kind: 'session',
          percent: 1,
          resets_at: '2026-09-20T23:19:59Z',
        },
        {
          kind: 'weekly_all',
          percent,
          resets_at: '2026-09-23T03:59:59Z',
        },
        {
          kind: 'weekly_scoped',
          percent: 47,
          resets_at: '2026-09-23T03:59:59Z',
          scope: { model: { display_name: 'Fable' } },
        },
      ],
    },
  };
}

beforeEach(() => {
  clearClaudeConfigSnapshotCache();
  mocks.getAccount.mockReset();
  mocks.getSecret.mockReset().mockReturnValue(null);
  mocks.hasManagedClaudeAuth.mockReset().mockReturnValue(false);
  mocks.managedClaudeAuthDirectory.mockReset().mockImplementation(
    (id: string) => `/managed/${id}/auth`,
  );
  mocks.materializeManagedClaudeAuth.mockReset();
  mocks.fetchClaudeCliUsageWindows.mockReset().mockResolvedValue(null);
  mocks.claudeBlobIsExpiredUnhealable.mockReset().mockReturnValue(false);
});

afterEach(() => {
  for (const home of tempHomes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

describe('parseClaudeCachedUtilization', () => {
  it('parses the CLI-written limits array into labeled windows', () => {
    const windows = parseClaudeCachedUtilization(
      usagePayload(73, NOW).utilization,
      NOW,
    );
    expect(windows.find((w) => w.label === '5 Horas')?.usedRatio).toBe(0.01);
    expect(windows.find((w) => w.label === 'Semanal')?.usedRatio).toBe(0.73);
    expect(
      windows.find((w) => w.label === 'Semanal (Fable)')?.usedRatio,
    ).toBe(0.47);
  });

  it('falls back to raw five_hour/seven_day buckets when limits is absent', () => {
    const windows = parseClaudeCachedUtilization(
      {
        five_hour: { utilization: 10, resets_at: '2026-09-20T23:19:59Z' },
        seven_day: { utilization: 30 },
      },
      NOW,
    );
    expect(windows.find((w) => w.label === '5 Horas')?.usedRatio).toBe(0.1);
    expect(windows.find((w) => w.label === 'Semanal')?.usedRatio).toBe(0.3);
  });

  it('returns [] for malformed payloads instead of inventing numbers', () => {
    expect(parseClaudeCachedUtilization(null, NOW)).toEqual([]);
    expect(parseClaudeCachedUtilization('x', NOW)).toEqual([]);
    expect(parseClaudeCachedUtilization({ limits: 'no' }, NOW)).toEqual([]);
  });
});

describe('discoverClaudeProfiles', () => {
  it('always lists the default profile, sorted extras after it', () => {
    const home = makeHome();
    fs.mkdirSync(path.join(home, '.claude'));
    writeClaudeJson(path.join(home, '.claude.json'), {});
    // Perfil nomeado com marker + credencial de arquivo = conta real.
    const work = path.join(home, '.claude-work');
    fs.mkdirSync(path.join(work, 'sessions'), { recursive: true });
    writeClaudeJson(path.join(work, '.credentials.json'), {
      claudeAiOauth: { accessToken: 't' },
    });
    // Plugin dir com os mesmos markers mas SEM credencial → não é conta.
    const mem = path.join(home, '.claude-mem');
    fs.mkdirSync(path.join(mem, 'sessions'), { recursive: true });
    writeClaudeJson(path.join(mem, 'settings.json'), {});

    const profiles = discoverClaudeProfiles(home);
    expect(profiles.map((p) => p.slug)).toEqual([null, 'work']);
    expect(profiles[0]!.accountFile).toBe(path.join(home, '.claude.json'));
    expect(profiles[1]!.accountFile).toBe(
      path.join(work, '.claude.json'),
    );
  });

  it('ignores non-directories and marker-less .claude-* dirs', () => {
    const home = makeHome();
    fs.mkdirSync(path.join(home, '.claude'));
    writeClaudeJson(path.join(home, '.claude.json.bak'), {});
    fs.mkdirSync(path.join(home, '.claude-empty'));
    expect(discoverClaudeProfiles(home).map((p) => p.slug)).toEqual([null]);
  });
});

describe('readClaudeConfigSnapshot', () => {
  it('reads oauthAccount + cachedUsageUtilization, gated by mtime', () => {
    const home = makeHome();
    const file = path.join(home, '.claude.json');
    writeClaudeJson(file, {
      oauthAccount: {
        emailAddress: 'user@x.com',
        organizationUuid: 'org-1',
      },
      cachedUsageUtilization: usagePayload(50, NOW),
    });
    const snap = readClaudeConfigSnapshot(file);
    expect(snap?.email).toBe('user@x.com');
    expect(snap?.organizationUuid).toBe('org-1');
    expect(snap?.usageFetchedAtMs).toBe(NOW);
    // Segunda leitura usa o cache (mtime igual) — alterar a var não muda nada.
    expect(readClaudeConfigSnapshot(file)).toEqual(snap);
  });

  it('returns null for missing file and clears the cache', () => {
    const home = makeHome();
    const file = path.join(home, '.claude.json');
    writeClaudeJson(file, { oauthAccount: { emailAddress: 'a@b.c' } });
    expect(readClaudeConfigSnapshot(file)?.email).toBe('a@b.c');
    fs.rmSync(file);
    expect(readClaudeConfigSnapshot(file)).toBeNull();
  });
});

describe('fetchClaudeAccountUsageWindows', () => {
  it('returns null for non-claude or missing accounts', async () => {
    mocks.getAccount.mockReturnValue({ adapterId: 'kimi' });
    expect(await fetchClaudeAccountUsageWindows('x', { now: NOW })).toBeNull();
    mocks.getAccount.mockReturnValue(null);
    expect(await fetchClaudeAccountUsageWindows('x', { now: NOW })).toBeNull();
  });

  it('managed account → scoped CLI run, no vault/profile fallback needed', async () => {
    mocks.getAccount.mockReturnValue({
      adapterId: 'claude',
      email: 'a@b.c',
    });
    mocks.hasManagedClaudeAuth.mockReturnValue(true);
    mocks.fetchClaudeCliUsageWindows.mockResolvedValue([
      cliWindow('Semanal', 0.5),
    ]);

    const w = await fetchClaudeAccountUsageWindows('acct-1', { now: NOW });
    expect(w?.[0]?.usedRatio).toBe(0.5);
    const call = mocks.fetchClaudeCliUsageWindows.mock.calls[0]![0] as {
      env: Record<string, string>;
    };
    expect(call.env[CLAUDE_MANAGED_AUTH_ENV]).toBe('/managed/acct-1/auth');
    expect(mocks.materializeManagedClaudeAuth).not.toHaveBeenCalled();
  });

  it('email-matched default profile serves the CLI-written cache without spawning', async () => {
    const home = makeHome();
    fs.mkdirSync(path.join(home, '.claude'));
    writeClaudeJson(path.join(home, '.claude.json'), {
      oauthAccount: { emailAddress: 'User@X.com' },
      cachedUsageUtilization: usagePayload(73, NOW - 60_000),
    });
    mocks.getAccount.mockReturnValue({
      adapterId: 'claude',
      email: 'user@x.com',
    });

    const w = await fetchClaudeAccountUsageWindows('acct-1', {
      now: NOW,
      home,
    });
    expect(w?.find((x) => x.label === 'Semanal')?.usedRatio).toBe(0.73);
    expect(mocks.fetchClaudeCliUsageWindows).not.toHaveBeenCalled();
    expect(mocks.materializeManagedClaudeAuth).not.toHaveBeenCalled();
  });

  it('stale profile cache falls through to a native CLI run (no env)', async () => {
    const home = makeHome();
    fs.mkdirSync(path.join(home, '.claude'));
    writeClaudeJson(path.join(home, '.claude.json'), {
      oauthAccount: { emailAddress: 'user@x.com' },
      cachedUsageUtilization: usagePayload(
        73,
        NOW - CLAUDE_USAGE_CACHE_FRESH_MS - 1,
      ),
    });
    mocks.getAccount.mockReturnValue({
      adapterId: 'claude',
      email: 'user@x.com',
    });
    mocks.fetchClaudeCliUsageWindows.mockResolvedValue([
      cliWindow('Semanal', 0.8),
    ]);

    const w = await fetchClaudeAccountUsageWindows('acct-1', {
      now: NOW,
      home,
    });
    expect(w?.[0]?.usedRatio).toBe(0.8);
    expect(mocks.fetchClaudeCliUsageWindows).toHaveBeenCalledWith(
      expect.objectContaining({ env: undefined }),
    );
    expect(mocks.materializeManagedClaudeAuth).not.toHaveBeenCalled();
  });

  it('named profile match runs the CLI with CLAUDE_CONFIG_DIR', async () => {
    const home = makeHome();
    fs.mkdirSync(path.join(home, '.claude'));
    writeClaudeJson(path.join(home, '.claude.json'), {
      oauthAccount: { emailAddress: 'other@x.com' },
    });
    const work = path.join(home, '.claude-work');
    fs.mkdirSync(path.join(work, 'sessions'), { recursive: true });
    writeClaudeJson(path.join(work, '.credentials.json'), {
      claudeAiOauth: { accessToken: 't' },
    });
    writeClaudeJson(path.join(work, '.claude.json'), {
      oauthAccount: { emailAddress: 'work@x.com' },
    });
    mocks.getAccount.mockReturnValue({
      adapterId: 'claude',
      email: 'work@x.com',
    });
    mocks.fetchClaudeCliUsageWindows.mockResolvedValue([
      cliWindow('Semanal', 0.2),
    ]);

    const w = await fetchClaudeAccountUsageWindows('acct-1', {
      now: NOW,
      home,
    });
    expect(w?.[0]?.usedRatio).toBe(0.2);
    const call = mocks.fetchClaudeCliUsageWindows.mock.calls[0]![0] as {
      env: Record<string, string>;
    };
    expect(call.env.CLAUDE_CONFIG_DIR).toBe(work);
  });

  it('vault-only account materializes managed auth then probes scoped CLI', async () => {
    const home = makeHome();
    fs.mkdirSync(path.join(home, '.claude'));
    writeClaudeJson(path.join(home, '.claude.json'), {
      oauthAccount: { emailAddress: 'someone-else@x.com' },
    });
    mocks.getAccount.mockReturnValue({
      adapterId: 'claude',
      email: 'vault-only@x.com',
    });
    mocks.getSecret.mockReturnValue(
      JSON.stringify({ claudeAiOauth: { accessToken: 'vt' } }),
    );
    mocks.materializeManagedClaudeAuth.mockReturnValue({
      directory: '/managed/acct-1/auth',
      blob: 'slim',
      env: {},
    });
    mocks.fetchClaudeCliUsageWindows.mockResolvedValue([
      cliWindow('Semanal', 0.4),
    ]);

    const w = await fetchClaudeAccountUsageWindows('acct-1', {
      now: NOW,
      home,
    });
    expect(w?.[0]?.usedRatio).toBe(0.4);
    expect(mocks.materializeManagedClaudeAuth).toHaveBeenCalledWith(
      'acct-1',
      expect.any(String),
    );
    const call = mocks.fetchClaudeCliUsageWindows.mock.calls[0]![0] as {
      env: Record<string, string>;
    };
    expect(call.env[CLAUDE_MANAGED_AUTH_ENV]).toBe('/managed/acct-1/auth');
  });

  it('expired-unhealable vault blob is never materialized', async () => {
    const home = makeHome();
    fs.mkdirSync(path.join(home, '.claude'));
    writeClaudeJson(path.join(home, '.claude.json'), {});
    mocks.getAccount.mockReturnValue({ adapterId: 'claude' });
    mocks.getSecret.mockReturnValue(
      JSON.stringify({ claudeAiOauth: { accessToken: 'vt' } }),
    );
    mocks.claudeBlobIsExpiredUnhealable.mockReturnValue(true);

    expect(
      await fetchClaudeAccountUsageWindows('acct-1', { now: NOW, home }),
    ).toBeNull();
    expect(mocks.materializeManagedClaudeAuth).not.toHaveBeenCalled();
  });

  it('no profile match and no vault blob → honest null, no CLI spawn', async () => {
    const home = makeHome();
    fs.mkdirSync(path.join(home, '.claude'));
    writeClaudeJson(path.join(home, '.claude.json'), {});
    mocks.getAccount.mockReturnValue({ adapterId: 'claude' });

    expect(
      await fetchClaudeAccountUsageWindows('acct-1', { now: NOW, home }),
    ).toBeNull();
    expect(mocks.fetchClaudeCliUsageWindows).not.toHaveBeenCalled();
    expect(mocks.materializeManagedClaudeAuth).not.toHaveBeenCalled();
  });

  it('matched profile whose CLI fails can still use the same account vault blob', async () => {
    const home = makeHome();
    fs.mkdirSync(path.join(home, '.claude'));
    writeClaudeJson(path.join(home, '.claude.json'), {
      oauthAccount: { emailAddress: 'user@x.com' },
    });
    mocks.getAccount.mockReturnValue({
      adapterId: 'claude',
      email: 'user@x.com',
    });
    mocks.getSecret.mockReturnValue(
      JSON.stringify({ claudeAiOauth: { accessToken: 'vt' } }),
    );
    mocks.fetchClaudeCliUsageWindows.mockResolvedValue(null);
    mocks.materializeManagedClaudeAuth.mockReturnValue({
      directory: '/managed/acct-1/auth',
      blob: 'slim',
      env: {},
    });

    expect(
      await fetchClaudeAccountUsageWindows('acct-1', { now: NOW, home }),
    ).toBeNull();
    // O blob é DA MESMA conta (mesmo e-mail) — materializar é atribuível.
    expect(mocks.materializeManagedClaudeAuth).toHaveBeenCalledWith(
      'acct-1',
      expect.any(String),
    );
  });
});
