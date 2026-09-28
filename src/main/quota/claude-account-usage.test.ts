import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuotaWindow } from '../../shared/quota-types';

const mocks = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  getAccount: vi.fn(),
  claudeAccountIsNativeLogin: vi.fn((_account: unknown) => false),
  ensureFreshClaudeSubscription: vi.fn(async () => false),
  getSecret: vi.fn<(key: string) => string | null>(),
  setSecret: vi.fn(),
  hasManagedClaudeAuth: vi.fn(() => false),
  managedClaudeAuthHasCredential: vi.fn(() => false),
  managedClaudeAuthDirectory: vi.fn((id: string) => `/managed/${id}/auth`),
  materializeManagedClaudeAuth: vi.fn(),
  readManagedClaudeAuth: vi.fn<() => string | null>(() => null),
  readManagedClaudeAuthAsync: vi.fn(async () => null as string | null),
  probeClaudeCliUsage: vi.fn(),
  probeClaudeOauthUsage: vi.fn(),
  readNativeOAuthCredential: vi.fn(async () => null as string | null),
  claudeBlobIsExpiredUnhealable: vi.fn(() => false),
  claudeBlobNeedsRefresh: vi.fn<
    (blob: string, now: number) => { refreshToken: string } | null
  >(() => null),
  refreshClaudeOauthBlobDetailed: vi.fn(),
  probeClaudeCredentialIdentity: vi.fn<(
    blob: string | null,
    email?: string,
    options?: { expectedAccountUuid?: string; now?: number },
  ) => Promise<'match' | 'mismatch' | 'auth-expired' | 'unavailable'>>(async () => 'match'),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  spawnSync: mocks.spawnSync,
}));

vi.mock('../persistence/account-store', () => ({
  getAccount: mocks.getAccount,
  claudeAccountIsNativeLogin: mocks.claudeAccountIsNativeLogin,
  ensureFreshClaudeSubscription: mocks.ensureFreshClaudeSubscription,
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
  readManagedClaudeAuthAsync: mocks.readManagedClaudeAuthAsync,
}));

vi.mock('./claude-oauth-usage', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  probeClaudeCliUsage: mocks.probeClaudeCliUsage,
  probeClaudeOauthUsage: mocks.probeClaudeOauthUsage,
}));

vi.mock('../adapters/native-oauth-keychain', () => ({
  readNativeOAuthCredential: mocks.readNativeOAuthCredential,
}));

vi.mock('./claude-oauth-refresh', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  claudeBlobIsExpiredUnhealable: mocks.claudeBlobIsExpiredUnhealable,
  claudeBlobNeedsRefresh: mocks.claudeBlobNeedsRefresh,
  refreshClaudeOauthBlobDetailed: mocks.refreshClaudeOauthBlobDetailed,
}));

vi.mock('./claude-native-account', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  probeClaudeCredentialIdentity: mocks.probeClaudeCredentialIdentity,
}));

import {
  CLAUDE_USAGE_CACHE_FRESH_MS,
  clearClaudeConfigSnapshotCache,
  claudeProfileKeychainService,
  discoverClaudeProfiles,
  fetchClaudeAccountUsageWindows,
  parseClaudeCachedUtilization,
  readClaudeConfigSnapshot,
} from './claude-account-usage';
import { CLAUDE_MANAGED_AUTH_ENV } from '../adapters/managed-claude-auth';

const NOW = Date.parse('2026-09-20T20:00:00Z');
const HOST_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')!;

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

function credentialBlob(token: string): string {
  return JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt: NOW + 60_000 } });
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
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  vi.spyOn(os, 'homedir').mockReturnValue(makeHome());
  // Keychain fixtures must never inspect the developer's real login or depend
  // on the host OS. Scoped items exist only when a test supplies keychainProbe.
  mocks.spawnSync.mockReset().mockImplementation((_command: string, args: string[]) => ({
    status: args.at(-1) === 'Claude Code-credentials' ? 0 : 1,
  }));
  clearClaudeConfigSnapshotCache();
  mocks.getAccount.mockReset();
  mocks.ensureFreshClaudeSubscription.mockReset().mockResolvedValue(false);
  mocks.getSecret.mockReset().mockReturnValue(null);
  mocks.hasManagedClaudeAuth.mockReset().mockReturnValue(false);
  mocks.managedClaudeAuthHasCredential.mockReset().mockReturnValue(false);
  mocks.managedClaudeAuthDirectory.mockReset().mockImplementation(
    (id: string) => `/managed/${id}/auth`,
  );
  mocks.materializeManagedClaudeAuth.mockReset();
  mocks.readManagedClaudeAuth.mockReset().mockReturnValue(credentialBlob('scoped-file-token'));
  mocks.readManagedClaudeAuthAsync.mockReset().mockResolvedValue(credentialBlob('scoped-token'));
  mocks.readNativeOAuthCredential.mockReset().mockResolvedValue(credentialBlob('profile-token'));
  mocks.setSecret.mockReset();
  mocks.probeClaudeCliUsage.mockReset().mockResolvedValue({
    windows: null,
    failure: 'unavailable',
  });
  mocks.probeClaudeOauthUsage.mockReset().mockImplementation(async () => {
    const last = mocks.probeClaudeCliUsage.mock.results.at(-1);
    return { windows: last ? (await last.value).windows : null };
  });
  mocks.claudeBlobIsExpiredUnhealable.mockReset().mockReturnValue(false);
  mocks.claudeBlobNeedsRefresh.mockReset().mockReturnValue(null);
  mocks.refreshClaudeOauthBlobDetailed.mockReset().mockResolvedValue({
    outcome: 'error',
  });
  mocks.probeClaudeCredentialIdentity.mockReset().mockResolvedValue('match');
});

/** Atalho: configura a sonda CLI para devolver estas janelas. */
function cliReturns(windows: QuotaWindow[] | null): void {
  mocks.probeClaudeCliUsage.mockResolvedValue({ windows });
}

afterEach(() => {
  Object.defineProperty(process, 'platform', HOST_PLATFORM);
  vi.restoreAllMocks();
  for (const home of tempHomes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

describe('parseClaudeCachedUtilization', () => {
  it('preserves a provider-reported Sonnet 5.5 window alongside shared account limits', () => {
    const payload = usagePayload(73, NOW).utilization;
    payload.limits.push({ kind: 'weekly_scoped', percent: 62,
      resets_at: '2026-09-23T03:59:59Z', scope: { model: { display_name: 'Sonnet 5.5' } },
    });
    const windows = parseClaudeCachedUtilization(payload, NOW);
    expect(windows.find((w) => w.label === 'Semanal (Sonnet 5.5)')).toMatchObject({
      usedRatio: 0.62, source: 'provider-api', resetsAt: Date.parse('2026-09-23T03:59:59Z'),
    });
    expect(windows.find((w) => w.label === 'Semanal')?.usedRatio).toBe(0.73);
    expect(windows.find((w) => w.label === '5 Horas')?.usedRatio).toBe(0.01);
    expect(parseClaudeCachedUtilization(usagePayload(73, NOW).utilization, NOW)
      .some((w) => w.label.includes('Sonnet'))).toBe(false);
  });
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
  it.each(['linux', 'win32'])('reads the native credential file on %s without consulting Keychain', async (platform) => {
    Object.defineProperty(process, 'platform', { value: platform });
    const home = makeHome();
    fs.mkdirSync(path.join(home, '.claude'));
    writeClaudeJson(path.join(home, '.claude.json'), {
      oauthAccount: { emailAddress: 'owner@example.test' },
    });
    fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), credentialBlob('native-file-token'));
    mocks.getAccount.mockReturnValue({ adapterId: 'claude', email: 'owner@example.test' });
    mocks.probeClaudeOauthUsage.mockResolvedValue({ windows: [cliWindow('Semanal', 0.2)] });
    const keychainProbe = vi.fn(() => true);

    expect((await fetchClaudeAccountUsageWindows('owner', { now: NOW, home, keychainProbe })).windows?.[0]?.usedRatio)
      .toBe(0.2);
    expect(mocks.probeClaudeOauthUsage).toHaveBeenCalledWith('native-file-token', expect.objectContaining({ now: NOW }));
    expect(keychainProbe).not.toHaveBeenCalled();
    expect(mocks.readNativeOAuthCredential).not.toHaveBeenCalled();
    expect(mocks.spawnSync).not.toHaveBeenCalled();
  });

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

  it('conta que é o login nativo nunca roda a CLI no escopo gerenciado dela (F-645)', async () => {
    mocks.getAccount.mockReturnValue({ adapterId: 'claude', email: 'a@b.c' });
    mocks.hasManagedClaudeAuth.mockReturnValue(true);
    mocks.managedClaudeAuthHasCredential.mockReturnValue(true);
    mocks.claudeAccountIsNativeLogin.mockReturnValueOnce(true);
    // Vault com blob: o passo 3 semearia um escopo novo e rodaria a CLI nele.
    mocks.getSecret.mockReturnValue(credentialBlob('vault-token'));

    await fetchClaudeAccountUsageWindows('acct-1', { now: NOW });

    const scopedRuns = mocks.probeClaudeCliUsage.mock.calls.filter(
      (args) => (args[0] as { env?: Record<string, string> } | undefined)
        ?.env?.[CLAUDE_MANAGED_AUTH_ENV] !== undefined,
    );
    expect(scopedRuns).toEqual([]);
    expect(mocks.materializeManagedClaudeAuth).not.toHaveBeenCalled();
  });

  it('does not open Keychain for every quota poll when the scoped file proves the account', async () => {
    mocks.getAccount.mockReturnValue({ adapterId: 'claude', email: 'owner@example.test' });
    mocks.managedClaudeAuthHasCredential.mockReturnValue(true);
    mocks.readManagedClaudeAuth.mockReturnValue(credentialBlob('owned-file-token'));
    cliReturns([cliWindow('Semanal', 0.06)]);
    mocks.probeClaudeOauthUsage.mockResolvedValue({ windows: [cliWindow('Semanal', 0.06)] });
    const result = await fetchClaudeAccountUsageWindows('owner', { now: NOW });
    expect(result.windows?.[0]?.usedRatio).toBe(0.06);
    expect(mocks.readManagedClaudeAuthAsync).not.toHaveBeenCalled();
  });

  it('does not publish file usage when the live scoped Keychain belongs to another account', async () => {
    mocks.getAccount.mockReturnValue({ adapterId: 'claude', email: 'owner@example.test' });
    mocks.managedClaudeAuthHasCredential.mockReturnValue(true);
    mocks.readManagedClaudeAuth.mockReturnValue(credentialBlob('owned-file-token'));
    mocks.readNativeOAuthCredential.mockResolvedValue(credentialBlob('other-keychain-token'));
    mocks.probeClaudeCredentialIdentity.mockImplementation(async (blob: string | null) =>
      blob?.includes('other-keychain-token') ? 'mismatch' : 'match');
    mocks.probeClaudeOauthUsage.mockResolvedValue({ windows: [cliWindow('Semanal', 0.06)] });
    cliReturns([cliWindow('Semanal', 0.86)]);

    const result = await fetchClaudeAccountUsageWindows('owner', {
      now: NOW, keychainProbe: () => true,
    });
    expect(result).toEqual({ windows: null, hint: 'identity-mismatch' });
    expect(mocks.probeClaudeOauthUsage).not.toHaveBeenCalled();
  });

  it('does not turn a CLI failure into re-login when the owned usage API is temporarily unavailable', async () => {
    mocks.getAccount.mockReturnValue({ adapterId: 'claude', email: 'owner@example.test' });
    mocks.managedClaudeAuthHasCredential.mockReturnValue(true);
    mocks.readManagedClaudeAuth.mockReturnValue(credentialBlob('owned-file-token'));
    mocks.probeClaudeCliUsage.mockResolvedValue({ windows: null, failure: 'auth-expired' });
    mocks.probeClaudeOauthUsage.mockResolvedValue({ windows: null, failure: 'unavailable' });
    expect(await fetchClaudeAccountUsageWindows('owner', { now: NOW }))
      .toEqual({ windows: null, hint: 'unavailable' });
  });

  it('rejects quota from a managed credential owned by the other Claude account', async () => {
    mocks.getAccount.mockReturnValue({ adapterId: 'claude', email: 'owner@example.test' });
    mocks.managedClaudeAuthHasCredential.mockReturnValue(true);
    mocks.readManagedClaudeAuth.mockReturnValue(JSON.stringify({
      claudeAiOauth: { accessToken: 'other-account', expiresAt: NOW + 60_000 },
    }));
    mocks.probeClaudeCredentialIdentity.mockResolvedValue('mismatch');
    cliReturns([cliWindow('Semanal', 0.86)]);

    const result = await fetchClaudeAccountUsageWindows('owner', { now: NOW });
    expect(result).toEqual({ windows: null, hint: 'identity-mismatch' });
    expect(mocks.probeClaudeCredentialIdentity).toHaveBeenCalledWith(
      expect.any(String), 'owner@example.test', expect.objectContaining({ now: NOW }),
    );
  });

  it('uses the live scoped credential and its own API usage, not a stale file or CLI output', async () => {
    mocks.getAccount.mockReturnValue({ adapterId: 'claude', email: 'owner@example.test' });
    mocks.managedClaudeAuthHasCredential.mockReturnValue(true);
    mocks.readManagedClaudeAuth.mockReturnValue('stale-file-credential');
    mocks.readNativeOAuthCredential.mockResolvedValue(credentialBlob('live-scoped-credential'));
    cliReturns([cliWindow('Semanal', 0.86)]);
    mocks.probeClaudeOauthUsage.mockResolvedValue({ windows: [cliWindow('Semanal', 0.06)] });

    const result = await fetchClaudeAccountUsageWindows('owner', { now: NOW, keychainProbe: () => true });
    expect(mocks.probeClaudeCredentialIdentity).toHaveBeenCalledWith(
      credentialBlob('live-scoped-credential'), 'owner@example.test', expect.objectContaining({ now: NOW }),
    );
    expect(mocks.probeClaudeOauthUsage).toHaveBeenCalledWith(
      expect.any(String), expect.objectContaining({ now: NOW }),
    );
    expect(result.windows?.[0]?.usedRatio).toBe(0.06);
  });

  it('keeps managed quota unknown if the owned token usage endpoint is unavailable', async () => {
    mocks.getAccount.mockReturnValue({ adapterId: 'claude', email: 'owner@example.test' });
    mocks.managedClaudeAuthHasCredential.mockReturnValue(true);
    mocks.readManagedClaudeAuthAsync.mockResolvedValue(JSON.stringify({
      claudeAiOauth: { accessToken: 'owned-token', expiresAt: NOW + 60_000 },
    }));
    cliReturns([cliWindow('Semanal', 0.86)]);
    mocks.probeClaudeOauthUsage.mockResolvedValue({ windows: null, failure: 'unavailable' });

    const result = await fetchClaudeAccountUsageWindows('owner', { now: NOW });
    expect(result).toEqual({ windows: null, hint: 'unavailable' });
  });

  it('never becomes a second refresh actor for a failed managed scope', async () => {
    mocks.getAccount.mockReturnValue({ adapterId: 'claude', email: 'owner@example.test' });
    mocks.managedClaudeAuthHasCredential.mockReturnValue(true);
    mocks.readManagedClaudeAuth.mockReturnValue(credentialBlob('expired-scoped'));
    mocks.probeClaudeCliUsage.mockResolvedValue({ windows: null, failure: 'auth-expired' });
    mocks.claudeBlobNeedsRefresh.mockReturnValue({ refreshToken: 'refresh' });
    mocks.refreshClaudeOauthBlobDetailed.mockResolvedValue({
      outcome: 'refreshed', blob: credentialBlob('other-account'),
    });
    mocks.probeClaudeCredentialIdentity.mockResolvedValue('mismatch');
    const result = await fetchClaudeAccountUsageWindows('owner', { now: NOW });
    expect(result).toEqual({ windows: null, hint: 'identity-mismatch' });
    expect(mocks.materializeManagedClaudeAuth).not.toHaveBeenCalled();
    expect(mocks.setSecret).not.toHaveBeenCalled();
    expect(mocks.refreshClaudeOauthBlobDetailed).not.toHaveBeenCalled();
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

  it('does not report a CLI-written cache as a fresh reading when live usage is unavailable', async () => {
    const home = makeHome();
    fs.mkdirSync(path.join(home, '.claude'));
    writeClaudeJson(path.join(home, '.claude.json'), {
      oauthAccount: { emailAddress: 'User@X.com', accountUuid: 'uuid-1' },
      cachedUsageUtilization: usagePayload(73, NOW - 60_000),
    });
    fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), credentialBlob('owner-token'));
    mocks.probeClaudeOauthUsage.mockResolvedValue({ windows: null, failure: 'unavailable' });
    mocks.getAccount.mockReturnValue({
      adapterId: 'claude',
      email: 'user@x.com',
    });

    const r = await fetchClaudeAccountUsageWindows('acct-1', {
      now: NOW,
      home,
    });
    expect(r).toEqual({ windows: null, hint: 'unavailable' });
    expect(mocks.probeClaudeCliUsage).not.toHaveBeenCalled();
    expect(mocks.materializeManagedClaudeAuth).not.toHaveBeenCalled();
  });

  it('rejects a profile cache when the current credential belongs to another account', async () => {
    const home = makeHome();
    fs.mkdirSync(path.join(home, '.claude'));
    writeClaudeJson(path.join(home, '.claude.json'), {
      oauthAccount: { emailAddress: 'owner@example.test', accountUuid: 'uuid-1' },
      cachedUsageUtilization: usagePayload(86, NOW),
    });
    mocks.getAccount.mockReturnValue({ adapterId: 'claude', email: 'owner@example.test' });
    mocks.readNativeOAuthCredential.mockResolvedValue(credentialBlob('other-account'));
    mocks.probeClaudeCredentialIdentity.mockResolvedValue('mismatch');

    const result = await fetchClaudeAccountUsageWindows('owner', { now: NOW, home });
    expect(result.windows).toBeNull();
    expect(result.hint).toBe('identity-mismatch');
    expect(mocks.probeClaudeCliUsage).not.toHaveBeenCalled();
  });

  it('does not fall back to a profile file when the effective Keychain item is unreadable', async () => {
    const home = makeHome();
    fs.mkdirSync(path.join(home, '.claude'));
    writeClaudeJson(path.join(home, '.claude.json'), {
      oauthAccount: { emailAddress: 'owner@example.test', accountUuid: 'uuid-1' },
      cachedUsageUtilization: usagePayload(86, NOW),
    });
    fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), credentialBlob('owned-file'));
    mocks.getAccount.mockReturnValue({ adapterId: 'claude', email: 'owner@example.test' });
    mocks.readNativeOAuthCredential.mockRejectedValue(new Error('Keychain denied'));
    mocks.probeClaudeOauthUsage.mockResolvedValue({ windows: [cliWindow('Semanal', 0.86)] });
    const result = await fetchClaudeAccountUsageWindows('owner', {
      now: NOW, home, keychainProbe: () => true,
    });
    expect(result).toEqual({ windows: null, hint: 'unavailable' });
    expect(mocks.probeClaudeOauthUsage).not.toHaveBeenCalled();
  });

  it('uses live verified usage when only stale profile metadata has an old UUID', async () => {
    const home = makeHome();
    fs.mkdirSync(path.join(home, '.claude'));
    writeClaudeJson(path.join(home, '.claude.json'), {
      oauthAccount: { emailAddress: 'owner@example.test', accountUuid: 'old-uuid' },
      cachedUsageUtilization: usagePayload(86, NOW),
    });
    mocks.getAccount.mockReturnValue({ adapterId: 'claude', email: 'owner@example.test' });
    mocks.probeClaudeCredentialIdentity.mockImplementation(async (_blob, _email, options) =>
      options?.expectedAccountUuid ? 'mismatch' : 'match');
    mocks.probeClaudeOauthUsage.mockResolvedValue({ windows: [cliWindow('Semanal', 0.06)] });
    const result = await fetchClaudeAccountUsageWindows('owner', { now: NOW, home });
    expect(result.windows?.[0]?.usedRatio).toBe(0.06);
  });

  it('does not show cached profile percentages after the usage API revokes auth', async () => {
    const home = makeHome();
    fs.mkdirSync(path.join(home, '.claude'));
    writeClaudeJson(path.join(home, '.claude.json'), {
      oauthAccount: { emailAddress: 'owner@example.test', accountUuid: 'uuid-1' },
      cachedUsageUtilization: usagePayload(86, NOW),
    });
    mocks.getAccount.mockReturnValue({ adapterId: 'claude', email: 'owner@example.test' });
    mocks.probeClaudeOauthUsage.mockResolvedValue({ windows: null, failure: 'auth-expired' });
    const result = await fetchClaudeAccountUsageWindows('owner', { now: NOW, home });
    expect(result).toEqual({ windows: null, hint: 'auth-expired' });
  });

  it.each(['another-user', undefined])('rejects cached usage with unproved account UUID %s', async (cachedUuid) => {
    const home = makeHome();
    fs.mkdirSync(path.join(home, '.claude'));
    writeClaudeJson(path.join(home, '.claude.json'), {
      oauthAccount: { emailAddress: 'user@x.com', accountUuid: 'uuid-1' },
      cachedUsageUtilization: { ...usagePayload(73, NOW), accountUuid: cachedUuid },
    });
    mocks.getAccount.mockReturnValue({ adapterId: 'claude', email: 'user@x.com' });
    mocks.probeClaudeOauthUsage.mockResolvedValue({ windows: [cliWindow('Semanal', 0.2)] });
    const result = await fetchClaudeAccountUsageWindows('acct-1', { now: NOW, home });
    expect(result.windows?.[0]?.usedRatio).toBe(0.2);
  });

  it('two managed accounts cannot read the native config usage cache', async () => {
    mocks.getAccount.mockReturnValue({ adapterId: 'claude' });
    mocks.managedClaudeAuthHasCredential.mockReturnValue(true);
    mocks.probeClaudeCliUsage.mockImplementation(async ({ env }) => ({
      windows: [cliWindow('Semanal', env.CLAUDE_CONFIG_DIR === '/managed/acct-a/quota' ? 0.2 : 0.7)],
    }));
    const first = await fetchClaudeAccountUsageWindows('acct-a', { now: NOW });
    const second = await fetchClaudeAccountUsageWindows('acct-b', { now: NOW });
    expect(first.windows?.[0]?.usedRatio).toBe(0.2);
    expect(second.windows?.[0]?.usedRatio).toBe(0.7);
  });

  it('stale profile cache falls through to the verified token usage API', async () => {
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
    mocks.probeClaudeOauthUsage.mockResolvedValue({ windows: [cliWindow('Semanal', 0.8)] });

    const r = await fetchClaudeAccountUsageWindows('acct-1', {
      now: NOW,
      home,
      keychainProbe: () => true,
    });
    expect(r.windows?.[0]?.usedRatio).toBe(0.8);
    expect(mocks.probeClaudeCliUsage).not.toHaveBeenCalled();
    expect(mocks.probeClaudeOauthUsage).toHaveBeenCalledWith('profile-token', expect.objectContaining({ now: NOW }));
    expect(mocks.materializeManagedClaudeAuth).not.toHaveBeenCalled();
  });

  it('named profile uses only the verified credential usage API', async () => {
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
    mocks.probeClaudeOauthUsage.mockResolvedValue({ windows: [cliWindow('Semanal', 0.2)] });

    const r = await fetchClaudeAccountUsageWindows('acct-1', {
      now: NOW,
      home,
      keychainProbe: () => true,
    });
    expect(r.windows?.[0]?.usedRatio).toBe(0.2);
    expect(mocks.probeClaudeCliUsage).not.toHaveBeenCalled();
    expect(mocks.readNativeOAuthCredential).toHaveBeenCalledWith(
      claudeProfileKeychainService(work), undefined, { bypassCache: true },
    );
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

  it('does not materialize a vault credential owned by another Claude account', async () => {
    mocks.getAccount.mockReturnValue({ adapterId: 'claude', email: 'owner@example.test' });
    mocks.getSecret.mockReturnValue(credentialBlob('other-account'));
    mocks.probeClaudeCredentialIdentity.mockResolvedValue('mismatch');
    const result = await fetchClaudeAccountUsageWindows('owner', { now: NOW });
    expect(result).toEqual({ windows: null, hint: 'identity-mismatch' });
    expect(mocks.materializeManagedClaudeAuth).not.toHaveBeenCalled();
    expect(mocks.probeClaudeCliUsage).not.toHaveBeenCalled();
  });

  it('delegates an expired vault grant to the account freshness owner before materializing', async () => {
    mocks.getAccount.mockReturnValue({ adapterId: 'claude', email: 'owner@example.test' });
    mocks.getSecret.mockReturnValue(credentialBlob('expired-vault'));
    mocks.probeClaudeCredentialIdentity.mockResolvedValue('auth-expired');
    mocks.claudeBlobNeedsRefresh.mockReturnValue({ refreshToken: 'refresh' });
    const result = await fetchClaudeAccountUsageWindows('owner', { now: NOW });
    expect(mocks.ensureFreshClaudeSubscription).toHaveBeenCalledWith('owner', NOW);
    expect(mocks.materializeManagedClaudeAuth).not.toHaveBeenCalled();
    expect(mocks.probeClaudeCliUsage).not.toHaveBeenCalled();
    expect(result).toEqual({ windows: null, hint: 'unavailable' });
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

  it('does not turn a CLI auth failure into an expired owned grant without provider proof', async () => {
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
      failure: 'auth-expired',
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
    expect(r.hint).toBe('unavailable');
    expect(mocks.refreshClaudeOauthBlobDetailed).not.toHaveBeenCalled();
  });

  it('uses a CLI-refreshed scoped token without an independent HTTP refresh', async () => {
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
    mocks.probeClaudeCliUsage.mockResolvedValue({ windows: [cliWindow('Semanal', 0.3)] });
    mocks.probeClaudeOauthUsage.mockResolvedValue({ windows: [cliWindow('Semanal', 0.3)] });
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
    expect(mocks.materializeManagedClaudeAuth).toHaveBeenLastCalledWith('acct-1', blob);
    expect(mocks.refreshClaudeOauthBlobDetailed).not.toHaveBeenCalled();
    expect(mocks.setSecret).not.toHaveBeenCalled();
  });
});
