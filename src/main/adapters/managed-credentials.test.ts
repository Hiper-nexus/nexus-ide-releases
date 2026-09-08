import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  authBlobIsUsable,
  captureNativeAuth,
  compareAuthBlobIdentity,
  identityFromAuthBlob,
  isFileAuthAdapter,
  managedHomeEnv,
  managedHomePath,
  materializeManagedHome,
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
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('managed-credentials', () => {
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
    const before = nativeAuthIdentity('kimi', home).fingerprint;
    fs.writeFileSync(file, blob('kimi-user-a', 'rotated'));
    const rotated = nativeAuthIdentity('kimi', home).fingerprint;
    fs.writeFileSync(file, blob('kimi-user-b', 'other'));
    const other = nativeAuthIdentity('kimi', home).fingerprint;

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
