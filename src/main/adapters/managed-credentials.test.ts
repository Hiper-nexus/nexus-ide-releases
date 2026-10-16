import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  prepareCheckoutProviderHome,
  authBlobIsUsable,
  captureNativeAuth,
  supportsNativeSessionSnapshot,
  devinDataHome,
  compareAuthBlobIdentity,
  identityFromAuthBlob,
  isFileAuthAdapter,
  managedHomeEnv,
  managedHomePath,
  materializeManagedHome,
  readBackFresherAuth,
  nativeAuthIdentity,
  removeManagedHome,
  scrubManagedSessionAuth,
  setManagedAuthPersister,
  trackManagedSession,
} from './managed-credentials';

const tempRoots: string[] = [];

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-managed-'));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('managed-credentials', () => {
  it('does not snapshot a Muse identity as a credential or portable Keychain session', () => {
    const home = tempHome();
    const authPath = path.join(home, 'custom-auth.json');
    vi.stubEnv('MUSE_AUTH_PATH', authPath);
    const metadata = JSON.stringify({ schema_version: 2, providers: { meta: { mechanism: 'oauth', storage: 'keychain', user_email: 'native@example.test' } } });
    fs.writeFileSync(authPath, metadata);
    expect(authBlobIsUsable('muse', metadata)).toBe(false);
    expect(captureNativeAuth('muse', home)).toBeNull();
    expect(supportsNativeSessionSnapshot('muse', home)).toBe(false);
    expect(nativeAuthIdentity('muse', home)).toEqual({ email: 'native@example.test' });
    const emailOnly = JSON.stringify({ providers: { meta: { email: 'native@example.test' } } });
    expect(authBlobIsUsable('muse', emailOnly)).toBe(false);
  });

  it.each([
    { meta: { mechanism: 'oauth', storage: 'keychain' }, other: { mechanism: 'api_key', storage: 'file', api_key: 'synthetic-other' } },
    { other: { mechanism: 'api_key', storage: 'file', api_key: 'synthetic-other' } },
    { meta: { mechanism: 'api_key', storage: 'unknown', api_key: 'synthetic-meta' } },
    { meta: { mechanism: 'unknown', storage: 'file', api_key: 'synthetic-meta' } },
    { meta: { mechanism: 'oauth', storage: 'file', api_key: 'synthetic-not-oauth' } },
    { meta: { mechanism: 'api_key', storage: 'file', refresh_token: 'synthetic-not-key' } },
    { meta: { mechanism: 'api_key', storage: 'file', api_key: 'synthetic-meta' }, other: { mechanism: 'api_key', storage: 'file', api_key: 'synthetic-other' } },
  ])('rejects Muse snapshots without an unambiguous portable Meta credential (%j)', (providers) => {
    const home = tempHome();
    const authPath = path.join(home, 'auth.json');
    vi.stubEnv('MUSE_AUTH_PATH', authPath);
    const blob = JSON.stringify({ schema_version: 2, providers });
    fs.writeFileSync(authPath, blob);
    expect(authBlobIsUsable('muse', blob)).toBe(false);
    expect(supportsNativeSessionSnapshot('muse', home)).toBe(false);
    expect(captureNativeAuth('muse', home)).toBeNull();
  });

  it('captures and restores Muse inline credentials at its explicit native auth path', () => {
    const home = tempHome();
    const authPath = path.join(home, 'custom-auth.json');
    vi.stubEnv('MUSE_AUTH_PATH', authPath);
    const blob = JSON.stringify({ schema_version: 2, providers: { meta: { mechanism: 'api_key', storage: 'file', api_key: 'synthetic-meta-key', user_email: 'native@example.test' } } });
    fs.writeFileSync(authPath, blob);
    expect(supportsNativeSessionSnapshot('muse', home)).toBe(true);
    expect(captureNativeAuth('muse', home)).toMatchObject({ blob, email: 'native@example.test', authRelativePath: path.join('muse', 'auth.json') });
    const managed = materializeManagedHome('muse', 'synthetic-account', blob, { home, systemHome: null });
    expect(fs.readFileSync(path.join(managed, 'muse', 'auth.json'), 'utf8')).toBe(blob);
    expect(managedHomeEnv('muse', managed)).toMatchObject({ XDG_CONFIG_HOME: managed, MUSE_AUTH_PATH: path.join(managed, 'muse', 'auth.json') });
    expect(authBlobIsUsable('muse', fs.readFileSync(path.join(managed, 'muse', 'auth.json'), 'utf8'))).toBe(true);
  });

  it.each([1, 1000])('keeps a fresh Kimi login and later CLI refresh (expiry scale %s)', (scale) => {
    const home = tempHome();
    const blob = (token: string, expires: number) => JSON.stringify({
      access_token: token, refresh_token: `refresh-${token}`, expires_at: expires * scale,
    });
    const old = blob('old', 1_800_000_000);
    const login = blob('new-login', 1_800_003_600);
    const rotated = blob('cli-rotation', 1_800_007_200);
    const managed = materializeManagedHome('kimi', 'account-a', old, { home, systemHome: null });
    const authFile = path.join(managed, 'credentials', 'kimi-code.json');
    materializeManagedHome('kimi', 'account-a', login, { home, systemHome: null });
    expect(fs.readFileSync(authFile, 'utf8')).toBe(login);
    expect(readBackFresherAuth('kimi', 'account-a', login, { home })).toBeNull();
    fs.writeFileSync(authFile, rotated);
    materializeManagedHome('kimi', 'account-a', login, { home, systemHome: null });
    expect(fs.readFileSync(authFile, 'utf8')).toBe(rotated);
    expect(readBackFresherAuth('kimi', 'account-a', login, { home })).toBe(rotated);
    const second = materializeManagedHome('kimi', 'account-b', blob('other-account', 1_800_001_000), { home, systemHome: null });
    expect(second).not.toBe(managed);
    expect(fs.readFileSync(authFile, 'utf8')).toBe(rotated);
  });

  it('replaces another identity even when its managed token is fresher', () => {
    const home = tempHome();
    const blob = (id: string, last: string) => JSON.stringify({
      tokens: { account_id: id, access_token: `token-${id}`, refresh_token: `refresh-${id}` },
      last_refresh: last,
    });
    const wrong = blob('wrong', '2026-09-21T12:00:00Z');
    const selected = blob('selected', '2026-09-20T12:00:00Z');
    const managed = materializeManagedHome('codex', 'selected', wrong, { home, systemHome: null });
    materializeManagedHome('codex', 'selected', selected, { home, systemHome: null });
    expect(fs.readFileSync(path.join(managed, 'auth.json'), 'utf8')).toBe(selected);
  });

  it('installs an explicitly renewed opaque login over a managed credential', () => {
    const home = tempHome();
    const old = JSON.stringify({ key: 'old' });
    const renewed = JSON.stringify({ key: 'renewed' });
    const managed = materializeManagedHome('grok', 'account', old, { home, systemHome: null });
    materializeManagedHome('grok', 'account', renewed, { home, systemHome: null, replace: true });
    expect(fs.readFileSync(path.join(managed, 'auth.json'), 'utf8')).toBe(renewed);
  });

  it('restores the selected Codex identity over a fresher unidentified managed token', () => {
    const home = tempHome();
    const unknown = JSON.stringify({ tokens: { access_token: 'unknown' }, last_refresh: '2026-09-21T12:00:00Z' });
    const selected = JSON.stringify({ tokens: { account_id: 'selected', access_token: 'selected' }, last_refresh: '2026-09-20T12:00:00Z' });
    const managed = materializeManagedHome('codex', 'selected', unknown, { home, systemHome: null });
    materializeManagedHome('codex', 'selected', selected, { home, systemHome: null });
    expect(fs.readFileSync(path.join(managed, 'auth.json'), 'utf8')).toBe(selected);
  });

  it('restores a saved login over a newer managed logout shell of the same subject', () => {
    const home = tempHome();
    const shell = JSON.stringify({ tokens: { account_id: 'selected' }, last_refresh: '2026-09-21T12:00:00Z' });
    const selected = JSON.stringify({ tokens: { account_id: 'selected', access_token: 'selected' }, last_refresh: '2026-09-20T12:00:00Z' });
    const managed = materializeManagedHome('codex', 'selected', shell, { home, systemHome: null });
    materializeManagedHome('codex', 'selected', selected, { home, systemHome: null });
    expect(fs.readFileSync(path.join(managed, 'auth.json'), 'utf8')).toBe(selected);
  });

  it('recognizes file-auth adapters', () => {
    expect(isFileAuthAdapter('codex')).toBe(true);
    expect(isFileAuthAdapter('grok')).toBe(true);
    expect(isFileAuthAdapter('claude')).toBe(false);
  });

  it('extracts email from Codex JWT id_token', () => {
    const payload = Buffer.from(
      JSON.stringify({ email: 'dev@example.test', sub: 'u1' }),
    ).toString('base64url');
    const blob = JSON.stringify({
      tokens: {
        id_token: `hdr.${payload}.sig`,
        access_token: 'access',
        refresh_token: 'refresh',
        account_id: 'acct',
      },
    });
    expect(identityFromAuthBlob('codex', blob)).toEqual({
      email: 'dev@example.test',
      subject: 'acct',
    });
  });

  it('reads the nested Grok account shape without exposing its credential', () => {
    const blob = JSON.stringify({
      'https://auth.x.ai::client': {
        key: 'secret-access-token',
        refresh_token: 'secret-refresh-token',
        user_id: 'grok-user-1',
        email: 'grok@example.test',
      },
    });

    expect(identityFromAuthBlob('grok', blob)).toEqual({
      email: 'grok@example.test',
      subject: 'grok-user-1',
    });
    expect(authBlobIsUsable('grok', blob)).toBe(true);
    expect(JSON.stringify(identityFromAuthBlob('grok', blob))).not.toContain(
      'secret-',
    );
  });

  it('dedupes Kimi by its real JWT subject when no email claim exists', () => {
    const token = (userId: string, tokenId: string) =>
      `h.${Buffer.from(JSON.stringify({ user_id: userId, sub: userId, token_id: tokenId })).toString('base64url')}.s`;
    const blob = (userId: string, tokenId: string) =>
      JSON.stringify({
        access_token: token(userId, tokenId),
        refresh_token: token(userId, `refresh-${tokenId}`),
        expires_at: 4_102_444_800,
      });

    expect(identityFromAuthBlob('kimi', blob('kimi-user-1', 'old'))).toEqual({
      subject: 'kimi-user-1',
    });
    expect(
      compareAuthBlobIdentity(
        'kimi',
        blob('kimi-user-1', 'old'),
        blob('kimi-user-1', 'rotated'),
      ),
    ).toBe('same');
    expect(
      compareAuthBlobIdentity(
        'kimi',
        blob('kimi-user-1', 'old'),
        blob('kimi-user-2', 'other'),
      ),
    ).toBe('different');
  });

  it('keeps the no-email session fingerprint stable across Kimi token rotation', () => {
    const home = tempHome();
    const credentials = path.join(home, '.kimi-code', 'credentials');
    fs.mkdirSync(credentials, { recursive: true });
    const file = path.join(credentials, 'kimi-code.json');
    const token = (claims: Record<string, string>) =>
      `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
    const blob = (userId: string, tokenId: string) =>
      JSON.stringify({
        access_token: token({
          user_id: userId,
          sub: userId,
          token_id: tokenId,
        }),
        refresh_token: token({ user_id: userId, sub: userId }),
        expires_at: 4_102_444_800,
      });

    fs.writeFileSync(file, blob('kimi-user-a', 'old'));
    const beforeIdentity = nativeAuthIdentity('kimi', home);
    const before = beforeIdentity.fingerprint;
    fs.writeFileSync(file, blob('kimi-user-a', 'rotated'));
    const rotatedIdentity = nativeAuthIdentity('kimi', home);
    const rotated = rotatedIdentity.fingerprint;
    fs.writeFileSync(file, blob('kimi-user-b', 'other'));
    const other = nativeAuthIdentity('kimi', home).fingerprint;

    expect(before).toMatch(/^[a-f0-9]{64}$/);
    expect(rotated).toBe(before);
    expect(beforeIdentity.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(rotatedIdentity.revision).not.toBe(beforeIdentity.revision);
    expect(other).not.toBe(before);
  });

  it('separa duas pessoas do mesmo workspace Codex (Team/Business compartilha o account_id)', () => {
    const jwt = (claims: Record<string, unknown>) =>
      `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
    const codex = (email: string | null, workspace: string, refresh: string) => JSON.stringify({
      tokens: {
        id_token: jwt(email ? { email } : {}),
        access_token: jwt({ exp: 4_102_444_800 }),
        refresh_token: refresh,
        account_id: workspace,
      },
    });
    const admin = codex('admin@volarehost.example', 'ws-team', 'rt-admin');
    const colleague = codex('retornoja@example.invalid', 'ws-team', 'rt-colleague');

    expect(compareAuthBlobIdentity('codex', admin, colleague)).toBe('different');
    expect(compareAuthBlobIdentity('codex', admin, codex('ADMIN@volarehost.example', 'ws-team', 'rt-2'))).toBe('same');
    // Sem e-mail de um lado, o workspace segue decidindo (blobs antigos).
    expect(compareAuthBlobIdentity('codex', admin, codex(null, 'ws-team', 'rt-3'))).toBe('same');
    // Um e-mail em dois workspaces continua sendo duas contas.
    expect(compareAuthBlobIdentity('codex', admin, codex('admin@volarehost.example', 'ws-pessoal', 'rt-4'))).toBe('different');

    // A prova de login novo (fingerprint) também distingue as duas pessoas.
    const home = tempHome();
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    const file = path.join(home, '.codex', 'auth.json');
    fs.writeFileSync(file, admin);
    const before = nativeAuthIdentity('codex', home).fingerprint;
    fs.writeFileSync(file, codex('admin@volarehost.example', 'ws-team', 'rt-rotated'));
    const rotated = nativeAuthIdentity('codex', home).fingerprint;
    fs.writeFileSync(file, colleague);
    const other = nativeAuthIdentity('codex', home).fingerprint;
    expect(before).toMatch(/^[a-f0-9]{64}$/);
    expect(rotated).toBe(before);
    expect(other).not.toBe(before);
  });

  it('does not invent an OpenCode email but emits an opaque session fingerprint', () => {
    const home = tempHome();
    const data = path.join(home, '.local', 'share', 'opencode');
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(
      path.join(data, 'auth.json'),
      JSON.stringify({ opencode: { type: 'api', key: 'opencode-secret' } }),
    );

    const identity = nativeAuthIdentity('opencode', home);
    expect(identity.email).toBeUndefined();
    expect(identity.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(identity)).not.toContain('opencode-secret');
  });

  it('materializes CODEX_HOME with auth.json and returns env', () => {
    const home = tempHome();
    const systemCodex = path.join(home, '.codex');
    fs.mkdirSync(systemCodex, { recursive: true });
    fs.writeFileSync(path.join(systemCodex, 'config.toml'), 'model = "o3"\n');
    fs.writeFileSync(
      path.join(systemCodex, 'auth.json'),
      JSON.stringify({ tokens: { access_token: 'system' } }),
    );

    const accountBlob = JSON.stringify({
      tokens: {
        id_token: `x.${Buffer.from(JSON.stringify({ email: 'work@x.test' })).toString('base64url')}.y`,
        access_token: 'work-access',
        refresh_token: 'work-refresh',
        account_id: 'w1',
      },
    });

    const managed = materializeManagedHome('codex', 'acct-work', accountBlob, {
      home,
      systemHome: systemCodex,
    });

    expect(managed).toBe(managedHomePath('codex', 'acct-work', home));
    expect(fs.existsSync(path.join(managed, 'config.toml'))).toBe(true);
    const written = JSON.parse(
      fs.readFileSync(path.join(managed, 'auth.json'), 'utf8'),
    ) as { tokens: { access_token: string } };
    expect(written.tokens.access_token).toBe('work-access');
    expect(managedHomeEnv('codex', managed)).toEqual({ CODEX_HOME: managed });
  });

  it('captures native codex auth from system home', () => {
    const home = tempHome();
    const systemCodex = path.join(home, '.codex');
    fs.mkdirSync(systemCodex, { recursive: true });
    const blob = JSON.stringify({
      tokens: {
        id_token: `a.${Buffer.from(JSON.stringify({ email: 'cap@x.test' })).toString('base64url')}.b`,
        access_token: 'cap',
        refresh_token: 'r',
        account_id: 'c1',
      },
    });
    fs.writeFileSync(path.join(systemCodex, 'auth.json'), blob);

    const capture = captureNativeAuth('codex', home);
    expect(capture?.blob).toBe(blob);
    expect(capture?.email).toBe('cap@x.test');
  });

  it('rejects empty or invalid Codex auth files instead of treating presence as login', () => {
    const home = tempHome();
    const systemCodex = path.join(home, '.codex');
    fs.mkdirSync(systemCodex, { recursive: true });

    fs.writeFileSync(path.join(systemCodex, 'auth.json'), '{}');
    expect(captureNativeAuth('codex', home)).toBeNull();
    fs.writeFileSync(path.join(systemCodex, 'auth.json'), '{broken');
    expect(captureNativeAuth('codex', home)).toBeNull();
  });

  it('captures AGY oauth_creds and supplements its real account email', () => {
    const home = tempHome();
    const gemini = path.join(home, '.gemini');
    fs.mkdirSync(gemini, { recursive: true });
    const payload = Buffer.from(
      JSON.stringify({ sub: 'google-sub-1', email: 'agy@example.test' }),
    ).toString('base64url');
    fs.writeFileSync(
      path.join(gemini, 'oauth_creds.json'),
      JSON.stringify({
        access_token: 'ya29.access',
        refresh_token: 'refresh',
        id_token: `h.${payload}.s`,
      }),
    );
    fs.writeFileSync(
      path.join(gemini, 'google_accounts.json'),
      JSON.stringify({ active: 'agy@example.test' }),
    );

    const capture = captureNativeAuth('agy', home);
    expect(capture).toMatchObject({
      email: 'agy@example.test',
      authRelativePath: 'oauth_creds.json',
    });
    expect(identityFromAuthBlob('agy', capture!.blob)).toEqual({
      email: 'agy@example.test',
      subject: 'google-sub-1',
    });
  });

  it('normalizes the AGY CLI token file into the isolated oauth_creds path', () => {
    const home = tempHome();
    const gemini = path.join(home, '.gemini');
    fs.mkdirSync(path.join(gemini, 'antigravity-cli'), { recursive: true });
    fs.writeFileSync(
      path.join(gemini, 'antigravity-cli', 'antigravity-oauth-token'),
      JSON.stringify({
        auth_method: 'oauth-v2',
        token: {
          access_token: 'agy-access',
          refresh_token: 'agy-refresh',
          token_type: 'Bearer',
          expiry: '2099-01-01T00:00:00.000Z',
        },
      }),
    );
    fs.writeFileSync(
      path.join(gemini, 'google_accounts.json'),
      JSON.stringify({ active: 'agy@example.test' }),
    );

    const capture = captureNativeAuth('agy', home);
    expect(capture).toMatchObject({
      email: 'agy@example.test',
      authRelativePath: 'oauth_creds.json',
    });
    expect(JSON.parse(capture!.blob)).toEqual({
      access_token: 'agy-access',
      refresh_token: 'agy-refresh',
      token_type: 'Bearer',
      expiry: '2099-01-01T00:00:00.000Z',
    });

    const managed = materializeManagedHome('agy', 'agy-fallback', capture!.blob, {
      home,
      systemHome: gemini,
    });
    expect(
      JSON.parse(fs.readFileSync(path.join(managed, 'oauth_creds.json'), 'utf8')),
    ).toMatchObject({ access_token: 'agy-access' });
  });

  it('removes managed home on cleanup', () => {
    const home = tempHome();
    const managed = materializeManagedHome(
      'codex',
      'acct-rm',
      JSON.stringify({ tokens: {} }),
      { home, systemHome: null },
    );
    expect(fs.existsSync(managed)).toBe(true);
    removeManagedHome('codex', 'acct-rm', home);
    expect(fs.existsSync(managed)).toBe(false);
  });

  it('rejects path-traversal account ids', () => {
    expect(() =>
      materializeManagedHome('codex', '../evil', '{}', {
        home: tempHome(),
        systemHome: null,
      }),
    ).toThrow(/invalid managed account id/);
  });

  it('restores directory snapshots under managed home', () => {
    const home = tempHome();
    const blob = JSON.stringify({
      __nexusDirSnapshot: true,
      root: 'antigravity',
      files: {
        'creds.json': '{"email":"a@b.test"}',
        'nested/token': 'abc',
      },
    });
    const managed = materializeManagedHome('agy', 'acct-agy', blob, {
      home,
      systemHome: null,
    });
    expect(
      fs.readFileSync(path.join(managed, 'antigravity', 'creds.json'), 'utf8'),
    ).toBe('{"email":"a@b.test"}');
    expect(
      fs.readFileSync(path.join(managed, 'antigravity', 'nested', 'token'), 'utf8'),
    ).toBe('abc');
  });

  it('does not clobber fresher on-disk auth with a stale vault blob', () => {
    const home = tempHome();
    const managed = materializeManagedHome(
      'codex',
      'acct-fresh',
      JSON.stringify({
        last_refresh: '2026-07-12T10:00:00.000Z',
        tokens: { access_token: 'old' },
      }),
      { home, systemHome: null },
    );
    const authPath = path.join(managed, 'auth.json');
    const fresher = JSON.stringify({
      last_refresh: '2026-07-12T12:00:00.000Z',
      tokens: { access_token: 'new' },
    });
    fs.writeFileSync(authPath, fresher);

    materializeManagedHome(
      'codex',
      'acct-fresh',
      JSON.stringify({
        last_refresh: '2026-07-12T09:00:00.000Z',
        tokens: { access_token: 'stale-vault' },
      }),
      { home, systemHome: null },
    );
    expect(fs.readFileSync(authPath, 'utf8')).toBe(fresher);
  });

  it('scrub respeita refcount: 2 sessões da mesma conta só apagam no último exit', () => {
    // O persister é chamado imediatamente ANTES do scrub, e só quando o refcount
    // da conta zera — logo, o timing das chamadas prova a guarda de refcount.
    const persisted: string[] = [];
    setManagedAuthPersister((adapterId, accountId) =>
      persisted.push(`${adapterId}:${accountId}`),
    );
    try {
      trackManagedSession('s1', 'codex', 'acct-ref');
      trackManagedSession('s2', 'codex', 'acct-ref');

      // Primeira saída: outra sessão da mesma conta ainda viva → sem scrub.
      scrubManagedSessionAuth('s1');
      expect(persisted).toEqual([]);

      // Segunda (última) saída: persiste fresher e scrub roda uma única vez.
      scrubManagedSessionAuth('s2');
      expect(persisted).toEqual(['codex:acct-ref']);

      // Idempotente: sessão desconhecida não dispara nada.
      scrubManagedSessionAuth('s1');
      expect(persisted).toEqual(['codex:acct-ref']);
    } finally {
      setManagedAuthPersister(null);
    }
  });
});


describe('devinDataHome', () => {
  it('prefere XDG_DATA_HOME em qualquer plataforma', () => {
    expect(
      devinDataHome('/home/op', { XDG_DATA_HOME: '/xdg', APPDATA: 'C:\\Roaming' }, 'win32', '/home/op'),
    ).toBe('/xdg');
  });

  it('no Windows lê %APPDATA% da sessão do operador', () => {
    const roaming = 'C:\\Users\\op\\AppData\\Roaming';
    expect(
      devinDataHome('C:\\Users\\op', { APPDATA: roaming }, 'win32', 'C:\\Users\\op'),
    ).toBe(roaming);
  });

  it('não empresta o Roaming real para um home de teste', () => {
    expect(
      devinDataHome('/tmp/fake', { APPDATA: 'C:\\Users\\op\\AppData\\Roaming' }, 'win32', 'C:\\Users\\op'),
    ).toBe(path.join('/tmp/fake', '.local', 'share'));
  });

  it('no macOS continua em ~/.local/share', () => {
    expect(
      devinDataHome('/Users/op', { APPDATA: 'C:\\Roaming' }, 'darwin', '/Users/op'),
    ).toBe(path.join('/Users/op', '.local', 'share'));
  });
});

describe('F-567 checkout provider homes', () => {
  it.each(['agy', 'devin'] as const)('isolates %s conversations across checkouts and preserves credential links', (kind) => {
    const root = tempHome();
    const sourceHome = path.join(root, 'native');
    const relativeAuth = kind === 'agy' ? 'oauth_creds.json' : path.join('devin', 'credentials.toml');
    fs.mkdirSync(path.dirname(path.join(sourceHome, relativeAuth)), { recursive: true });
    fs.writeFileSync(path.join(sourceHome, relativeAuth), 'test-credential');
    const nativeSessions = path.join(sourceHome, kind === 'agy' ? 'antigravity-cli/conversations' : 'devin/cli');
    fs.mkdirSync(nativeSessions, { recursive: true });
    fs.writeFileSync(path.join(nativeSessions, 'sessions.db'), 'external');
    const options = { userDataPath: path.join(root, 'userData'), checkoutId: 'checkout-a', sourceHome };
    const first = prepareCheckoutProviderHome(kind, options);
    const second = prepareCheckoutProviderHome(kind, { ...options, checkoutId: 'checkout-b' });
    const providerHome = (home: typeof first) => kind === 'agy' ? home.env.GEMINI_CLI_HOME : home.env.XDG_DATA_HOME;
    expect(first.stateHome).not.toBe(second.stateHome);
    expect(first.stateHome).toContain(path.join('provider-state', kind, 'checkout-a'));
    expect(fs.readFileSync(path.join(providerHome(first), relativeAuth), 'utf8')).toBe('test-credential');
    expect(fs.existsSync(path.join(providerHome(first), kind === 'agy' ? 'antigravity-cli/conversations/sessions.db' : 'devin/cli/sessions.db'))).toBe(false);
    fs.writeFileSync(path.join(first.stateHome, 'conversation-marker'), 'pane');
    expect(prepareCheckoutProviderHome(kind, options).stateHome).toBe(first.stateHome);
    expect(fs.existsSync(path.join(second.stateHome, 'conversation-marker'))).toBe(false);
    expect(prepareCheckoutProviderHome(kind, { ...options, sourceHome: path.join(root, 'other-account') }).stateHome).not.toBe(first.stateHome);
    if (kind === 'agy') expect(first.env.GEMINI_CLI_HOME).toBe(path.join(first.env.HOME, '.gemini'));
  });

  it('links the AGY 1.2 file-fallback token into the checkout home (keyring unavailable under sandbox)', () => {
    const root = tempHome();
    const sourceHome = path.join(root, 'native');
    fs.mkdirSync(sourceHome, { recursive: true });
    const token = JSON.stringify({ auth_method: 'oauth-v2', token: { access_token: 'synthetic', expiry: '2099-01-01T00:00:00.000Z' } });
    fs.writeFileSync(path.join(sourceHome, 'jetski-standalone-oauth-token'), token);
    const home = prepareCheckoutProviderHome('agy', { userDataPath: path.join(root, 'userData'), checkoutId: 'checkout-jetski', sourceHome });
    const linked = path.join(home.env.GEMINI_CLI_HOME, 'jetski-standalone-oauth-token');
    expect(fs.lstatSync(linked).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(linked, 'utf8')).toBe(token);
    expect(home.sharedFiles).toContain(fs.realpathSync(path.join(sourceHome, 'jetski-standalone-oauth-token')));
  });

  it('keeps AGY skills visible when the spawn hook mirrors them after home preparation', () => {
    const root = tempHome();
    const sourceHome = path.join(root, 'native');
    const options = { userDataPath: path.join(root, 'userData'), checkoutId: 'checkout-skills', sourceHome };
    const home = prepareCheckoutProviderHome('agy', options);
    const skills = path.join(sourceHome, 'config', 'skills');
    fs.mkdirSync(skills, { recursive: true });
    fs.writeFileSync(path.join(skills, 'SKILL.md'), 'synthetic skill');
    expect(fs.readFileSync(path.join(home.env.GEMINI_CLI_HOME, 'config', 'skills', 'SKILL.md'), 'utf8')).toBe('synthetic skill');
    expect(home.sharedReadPaths).toContain(skills);
    expect(home.sharedFiles).not.toContain(skills);
    expect(prepareCheckoutProviderHome('agy', options).stateHome).toBe(home.stateHome);
  });

  it('normalizes AGY skill aliases on respawn without changing auth or conversations', () => {
    const root = tempHome();
    const sourceHome = path.join(root, 'native');
    fs.mkdirSync(path.join(sourceHome, 'config/skills'), { recursive: true });
    fs.mkdirSync(path.join(sourceHome, 'antigravity-cli/skills'), { recursive: true });
    fs.writeFileSync(path.join(sourceHome, 'config/skills/SKILL.md'), 'config skill');
    fs.writeFileSync(path.join(sourceHome, 'oauth_creds.json'), 'account A');
    const options = { userDataPath: path.join(root, 'userData'), checkoutId: 'checkout-aliases', sourceHome };
    const first = prepareCheckoutProviderHome('agy', options);
    const profile = first.env.GEMINI_CLI_HOME;
    const configSkills = path.join(profile, 'config/skills');
    const cliSkills = path.join(profile, 'antigravity-cli/skills');
    fs.unlinkSync(configSkills);
    fs.symlinkSync(path.join(sourceHome, 'antigravity-cli/skills'), configSkills, 'junction');
    fs.unlinkSync(cliSkills);
    fs.symlinkSync(configSkills, cliSkills, 'junction');
    const conversation = path.join(profile, 'antigravity-cli/conversations/keep.txt');
    fs.writeFileSync(conversation, 'existing conversation');

    expect(prepareCheckoutProviderHome('agy', options).stateHome).toBe(first.stateHome);
    expect(fs.readlinkSync(configSkills)).toBe(path.join(sourceHome, 'config/skills'));
    expect(fs.readlinkSync(cliSkills)).toBe(path.join(sourceHome, 'antigravity-cli/skills'));
    expect(fs.readFileSync(path.join(profile, 'config/skills/SKILL.md'), 'utf8')).toBe('config skill');
    expect(fs.readFileSync(path.join(sourceHome, 'oauth_creds.json'), 'utf8')).toBe('account A');
    expect(fs.readFileSync(conversation, 'utf8')).toBe('existing conversation');
  });

  it('re-points AGY config links consolidated inside the managed home instead of failing the spawn', () => {
    const root = tempHome();
    const sourceHome = path.join(root, 'native');
    fs.mkdirSync(path.join(sourceHome, 'antigravity-cli'), { recursive: true });
    fs.writeFileSync(path.join(sourceHome, 'oauth_creds.json'), 'account A');
    fs.writeFileSync(path.join(sourceHome, 'antigravity-cli/mcp_config.json'), '{"mcp":1}');
    const options = { userDataPath: path.join(root, 'userData'), checkoutId: 'checkout-consolidated', sourceHome };
    const first = prepareCheckoutProviderHome('agy', options);
    const profile = first.env.GEMINI_CLI_HOME;
    // What the AGY CLI does on this machine: antigravity-cli/mcp_config.json
    // becomes a link to the sibling config/mcp_config.json inside the home.
    const cliConfig = path.join(profile, 'antigravity-cli/mcp_config.json');
    fs.unlinkSync(cliConfig);
    fs.symlinkSync(path.join(profile, 'config/mcp_config.json'), cliConfig, 'junction');

    const second = prepareCheckoutProviderHome('agy', options);
    expect(second.stateHome).toBe(first.stateHome);
    // Mesmo arquivo: symlink no POSIX, hardlink no Windows (realpath de
    // hardlink devolve o próprio caminho, então compare a identidade).
    const linkedConfig = fs.statSync(cliConfig);
    const sourceConfig = fs.statSync(path.join(sourceHome, 'antigravity-cli/mcp_config.json'));
    expect([linkedConfig.dev, linkedConfig.ino]).toEqual([sourceConfig.dev, sourceConfig.ino]);
    expect(fs.readFileSync(cliConfig, 'utf8')).toBe('{"mcp":1}');
  });

  it('still rejects a credential link resolving outside the auth source and managed home', () => {
    const root = tempHome();
    const sourceHome = path.join(root, 'native');
    fs.mkdirSync(sourceHome, { recursive: true });
    fs.writeFileSync(path.join(sourceHome, 'oauth_creds.json'), 'account A');
    const options = { userDataPath: path.join(root, 'userData'), checkoutId: 'checkout-tamper', sourceHome };
    const first = prepareCheckoutProviderHome('agy', options);
    const foreign = path.join(root, 'foreign.txt');
    fs.writeFileSync(foreign, 'not ours');
    const target = path.join(first.env.GEMINI_CLI_HOME, 'oauth_creds.json');
    fs.unlinkSync(target);
    fs.symlinkSync(foreign, target, 'junction');

    expect(() => prepareCheckoutProviderHome('agy', options)).toThrow(/outside its auth source/);
    expect(fs.readlinkSync(target)).toBe(foreign);

    // F-716: pasta irmã com o mesmo prefixo (native → native2) não é "dentro".
    const sibling = path.join(`${sourceHome}2`, 'oauth_creds.json');
    fs.mkdirSync(path.dirname(sibling), { recursive: true });
    fs.writeFileSync(sibling, 'account B');
    fs.unlinkSync(target);
    fs.symlinkSync(sibling, target, 'junction');
    expect(() => prepareCheckoutProviderHome('agy', options)).toThrow(/outside its auth source/);
    expect(fs.readlinkSync(target)).toBe(sibling);
  });

  it('rejects AGY skills pointing at another profile and preserves that profile', () => {
    const root = tempHome();
    const options = { userDataPath: path.join(root, 'userData'), checkoutId: 'checkout-skills', sourceHome: path.join(root, 'account-a') };
    const first = prepareCheckoutProviderHome('agy', options);
    const foreign = path.join(root, 'account-b/antigravity-cli/skills');
    fs.mkdirSync(foreign, { recursive: true });
    fs.writeFileSync(path.join(foreign, 'SKILL.md'), 'other account');
    const target = path.join(first.env.GEMINI_CLI_HOME, 'config/skills');
    fs.unlinkSync(target);
    fs.symlinkSync(foreign, target, 'junction');
    expect(() => prepareCheckoutProviderHome('agy', options)).toThrow(/skill link/);
    expect(fs.readFileSync(path.join(foreign, 'SKILL.md'), 'utf8')).toBe('other account');
  });

  it('refreshes a Windows-style credential copy from the selected account on respawn', () => {
    const root = tempHome();
    const sourceHome = path.join(root, 'native');
    fs.mkdirSync(path.join(sourceHome, 'devin'), { recursive: true });
    const source = path.join(sourceHome, 'devin', 'credentials.toml');
    fs.writeFileSync(source, 'original-test-credential');
    const options = { userDataPath: path.join(root, 'userData'), checkoutId: 'checkout-auth', sourceHome };
    const home = prepareCheckoutProviderHome('devin', options);
    const target = path.join(home.env.XDG_DATA_HOME, 'devin', 'credentials.toml');
    fs.unlinkSync(target);
    fs.writeFileSync(target, 'original-test-credential');
    fs.writeFileSync(source, 'updated-test-credential');
    prepareCheckoutProviderHome('devin', options);
    expect(fs.readFileSync(target, 'utf8')).toBe('updated-test-credential');
    expect(() => prepareCheckoutProviderHome('devin', { ...options, sourceHome: 'relative' })).toThrow(/absolute/);
  });

  it('rejects checkout traversal and linked state roots', () => {
    const root = tempHome();
    const options = { userDataPath: root, checkoutId: '../escape', sourceHome: path.join(root, 'native') };
    expect(() => prepareCheckoutProviderHome('devin', options)).toThrow(/checkout/i);
    fs.mkdirSync(path.join(root, 'external'));
    fs.symlinkSync(path.join(root, 'external'), path.join(root, 'provider-state'), 'junction');
    expect(() => prepareCheckoutProviderHome('devin', { ...options, checkoutId: 'checkout-a' })).toThrow(/symlink/i);
  });
});
