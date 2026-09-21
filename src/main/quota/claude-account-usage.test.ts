import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuotaWindow } from '../../shared/quota-types';

const mocks = vi.hoisted(() => ({
  getAccount: vi.fn(),
  getSecret: vi.fn<(key: string) => string | null>(),
  setSecret: vi.fn(),
  hasManagedClaudeAuth: vi.fn(() => false),
  managedClaudeAuthHasCredential: vi.fn(() => false),
  managedClaudeAuthDirectory: vi.fn((id: string) => `/managed/${id}/auth`),
  materializeManagedClaudeAuth: vi.fn(),
  readManagedClaudeAuth: vi.fn(() => null),
  probeClaudeCliUsage: vi.fn(),
  claudeBlobIsExpiredUnhealable: vi.fn(() => false),
  claudeBlobNeedsRefresh: vi.fn<
    (blob: string, now: number) => { refreshToken: string } | null
  >(() => null),
  refreshClaudeOauthBlobDetailed: vi.fn(),
}));

vi.mock('../persistence/account-store', () => ({
  getAccount: mocks.getAccount,
}));

vi.mock('../persistence/secrets-store', () => ({
  getSecret: mocks.getSecret,
  setSecret: mocks.setSecret,
}));

vi.mock('../adapters/managed-claude-auth', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  hasManagedClaudeAuth: mocks.hasManagedClaudeAuth,
  managedClaudeAuthHasCredential: mocks.managedClaudeAuthHasCredential,
  managedClaudeAuthDirectory: mocks.managedClaudeAuthDirectory,
  materializeManagedClaudeAuth: mocks.materializeManagedClaudeAuth,
  readManagedClaudeAuth: mocks.readManagedClaudeAuth,
}));

vi.mock('./claude-oauth-usage', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  probeClaudeCliUsage: mocks.probeClaudeCliUsage,
}));

vi.mock('./claude-oauth-refresh', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  claudeBlobIsExpiredUnhealable: mocks.claudeBlobIsExpiredUnhealable,
  claudeBlobNeedsRefresh: mocks.claudeBlobNeedsRefresh,
  refreshClaudeOauthBlobDetailed: mocks.refreshClaudeOauthBlobDetailed,
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
  mocks.managedClaudeAuthHasCredential.mockReset().mockReturnValue(false);
  mocks.managedClaudeAuthDirectory.mockReset().mockImplementation(
    (id: string) => `/managed/${id}/auth`,
  );
  mocks.materializeManagedClaudeAuth.mockReset();
  mocks.readManagedClaudeAuth.mockReset().mockReturnValue(null);
  mocks.setSecret.mockReset();
  mocks.probeClaudeCliUsage.mockReset().mockResolvedValue({
    windows: null,
    failure: 'unavailable',
  });
  mocks.claudeBlobIsExpiredUnhealable.mockReset().mockReturnValue(false);
  mocks.claudeBlobNeedsRefresh.mockReset().mockReturnValue(null);
  mocks.refreshClaudeOauthBlobDetailed.mockReset().mockResolvedValue({
    outcome: 'error',
  });
});

/** Atalho: configura a sonda CLI para devolver estas janelas. */
function cliReturns(windows: QuotaWindow[] | null): void {
  mocks.probeClaudeCliUsage.mockResolvedValue({ windows });
}

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
  it('returns no-credential for non-claude or missing accounts', async () => {
    mocks.getAccount.mockReturnValue({ adapterId: 'kimi' });
    expect(
      (await fetchClaudeAccountUsageWindows('x', { now: NOW })).hint,
    ).toBe('no-credential');
    mocks.getAccount.mockReturnValue(null);
    expect(
      (await fetchClaudeAccountUsageWindows('x', { now: NOW })).hint,
    ).toBe('no-credential');
  });

  it('managed account → scoped CLI run, no vault/profile fallback needed', async () => {
    mocks.getAccount.mockReturnValue({
      adapterId: 'claude',
      email: 'a@b.c',
    });
    mocks.hasManagedClaudeAuth.mockReturnValue(true);
    mocks.managedClaudeAuthHasCredential.mockReturnValue(true);
    cliReturns([cliWindow('Semanal', 0.5)]);

    const r = await fetchClaudeAccountUsageWindows('acct-1', { now: NOW });
    expect(r.windows?.[0]?.usedRatio).toBe(0.5);
    const call = mocks.probeClaudeCliUsage.mock.calls[0]![0] as {
      env: Record<string, string>;
    };
    expect(call.env[CLAUDE_MANAGED_AUTH_ENV]).toBe('/managed/acct-1/auth');
    expect(mocks.materializeManagedClaudeAuth).not.toHaveBeenCalled();
  });

  it('empty managed scope never runs the scoped CLI (cross-account leak)', async () => {
    // Campo 21/09: o diretório existia mas estava vazio. O `claude` caía na
    // credencial NATIVA e esta linha herdava o consumo de OUTRA conta.
    mocks.getAccount.mockReturnValue({ adapterId: 'claude', email: 'a@b.c' });
    mocks.hasManagedClaudeAuth.mockReturnValue(true);
    mocks.managedClaudeAuthHasCredential.mockReturnValue(false);
    cliReturns([cliWindow('Semanal', 0.73)]);

    const r = await fetchClaudeAccountUsageWindows('acct-empty', { now: NOW });

    expect(mocks.probeClaudeCliUsage).not.toHaveBeenCalled();
    expect(r.windows).toBeNull();
    // Escopo sem credencial é conta sem sessão: a UI pede login, não paciência.
    expect(r.hint).toBe('no-credential');
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

    const r = await fetchClaudeAccountUsageWindows('acct-1', {
      now: NOW,
      home,
    });
    expect(r.windows?.find((x) => x.label === 'Semanal')?.usedRatio).toBe(0.73);
    expect(mocks.probeClaudeCliUsage).not.toHaveBeenCalled();
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
    cliReturns([cliWindow('Semanal', 0.8)]);

    const r = await fetchClaudeAccountUsageWindows('acct-1', {
      now: NOW,
      home,
    });
    expect(r.windows?.[0]?.usedRatio).toBe(0.8);
    expect(mocks.probeClaudeCliUsage).toHaveBeenCalledWith(
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
    cliReturns([cliWindow('Semanal', 0.2)]);

    const r = await fetchClaudeAccountUsageWindows('acct-1', {
      now: NOW,
      home,
    });
    expect(r.windows?.[0]?.usedRatio).toBe(0.2);
    const call = mocks.probeClaudeCliUsage.mock.calls[0]![0] as {
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
    cliReturns([cliWindow('Semanal', 0.4)]);

    const r = await fetchClaudeAccountUsageWindows('acct-1', {
      now: NOW,
      home,
    });
    expect(r.windows?.[0]?.usedRatio).toBe(0.4);
    expect(mocks.materializeManagedClaudeAuth).toHaveBeenCalledWith(
      'acct-1',
      expect.any(String),
    );
    const call = mocks.probeClaudeCliUsage.mock.calls[0]![0] as {
      env: Record<string, string>;
    };
    expect(call.env[CLAUDE_MANAGED_AUTH_ENV]).toBe('/managed/acct-1/auth');
  });

  it('expired-unhealable vault blob → auth-expired, nunca materializa', async () => {
    const home = makeHome();
    fs.mkdirSync(path.join(home, '.claude'));
    writeClaudeJson(path.join(home, '.claude.json'), {});
    mocks.getAccount.mockReturnValue({ adapterId: 'claude' });
    mocks.getSecret.mockReturnValue(
      JSON.stringify({ claudeAiOauth: { accessToken: 'vt' } }),
    );
    mocks.claudeBlobIsExpiredUnhealable.mockReturnValue(true);

    const r = await fetchClaudeAccountUsageWindows('acct-1', {
      now: NOW,
      home,
    });
    expect(r.windows).toBeNull();
    expect(r.hint).toBe('auth-expired');
    expect(mocks.materializeManagedClaudeAuth).not.toHaveBeenCalled();
  });

  it('no profile match and no vault blob → no-credential, no CLI spawn', async () => {
    const home = makeHome();
    fs.mkdirSync(path.join(home, '.claude'));
    writeClaudeJson(path.join(home, '.claude.json'), {});
    mocks.getAccount.mockReturnValue({ adapterId: 'claude' });

    const r = await fetchClaudeAccountUsageWindows('acct-1', {
      now: NOW,
      home,
    });
    expect(r.windows).toBeNull();
    expect(r.hint).toBe('no-credential');
    expect(mocks.probeClaudeCliUsage).not.toHaveBeenCalled();
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
    mocks.probeClaudeCliUsage.mockResolvedValue({
      windows: null,
      failure: 'unavailable',
    });
    mocks.materializeManagedClaudeAuth.mockReturnValue({
      directory: '/managed/acct-1/auth',
      blob: 'slim',
      env: {},
    });

    const r = await fetchClaudeAccountUsageWindows('acct-1', {
      now: NOW,
      home,
    });
    expect(r.windows).toBeNull();
    // O blob é DA MESMA conta (mesmo e-mail) — materializar é atribuível.
    expect(mocks.materializeManagedClaudeAuth).toHaveBeenCalledWith(
      'acct-1',
      expect.any(String),
    );
  });

  it('dead grant: refresh inválido na cura do vault → auth-expired', async () => {
    const home = makeHome();
    fs.mkdirSync(path.join(home, '.claude'));
    writeClaudeJson(path.join(home, '.claude.json'), {});
    mocks.getAccount.mockReturnValue({ adapterId: 'claude' });
    mocks.getSecret.mockReturnValue(
      JSON.stringify({
        claudeAiOauth: { accessToken: 'vt', refreshToken: 'rt' },
      }),
    );
    mocks.probeClaudeCliUsage.mockResolvedValue({
      windows: null,
      failure: 'unavailable',
    });
    mocks.materializeManagedClaudeAuth.mockReturnValue({
      directory: '/managed/acct-1/auth',
      blob: 'slim',
      env: {},
    });
    mocks.claudeBlobNeedsRefresh.mockReturnValue({ refreshToken: 'rt' });
    mocks.refreshClaudeOauthBlobDetailed.mockResolvedValue({
      outcome: 'invalid-grant',
    });

    const r = await fetchClaudeAccountUsageWindows('acct-1', {
      now: NOW,
      home,
    });
    expect(r.windows).toBeNull();
    expect(r.hint).toBe('auth-expired');
  });

  it('cura: refresh válido grava escopo+vault e a sonda retorna janelas', async () => {
    const home = makeHome();
    fs.mkdirSync(path.join(home, '.claude'));
    writeClaudeJson(path.join(home, '.claude.json'), {});
    mocks.getAccount.mockReturnValue({ adapterId: 'claude' });
    const blob = JSON.stringify({
      claudeAiOauth: { accessToken: 'vt', refreshToken: 'rt' },
    });
    mocks.getSecret.mockReturnValue(blob);
    mocks.materializeManagedClaudeAuth.mockReturnValue({
      directory: '/managed/acct-1/auth',
      blob: 'slim',
      env: {},
    });
    mocks.probeClaudeCliUsage
      .mockResolvedValueOnce({ windows: null, failure: 'unavailable' })
      .mockResolvedValueOnce({ windows: [cliWindow('Semanal', 0.3)] });
    mocks.claudeBlobNeedsRefresh.mockReturnValue({ refreshToken: 'rt' });
    mocks.refreshClaudeOauthBlobDetailed.mockResolvedValue({
      outcome: 'refreshed',
      blob: 'fresh-blob',
    });

    const r = await fetchClaudeAccountUsageWindows('acct-1', {
      now: NOW,
      home,
    });
    expect(r.windows?.[0]?.usedRatio).toBe(0.3);
    // O blob renovado volta ao escopo gerenciado e ao vault (linhagem coerente).
    expect(mocks.materializeManagedClaudeAuth).toHaveBeenLastCalledWith(
      'acct-1',
      'fresh-blob',
    );
    expect(mocks.setSecret).toHaveBeenCalledWith('acctcred:acct-1', 'fresh-blob');
  });
});
