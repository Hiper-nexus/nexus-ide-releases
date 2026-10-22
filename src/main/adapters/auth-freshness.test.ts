import { describe, expect, it } from 'vitest';
import {
  authBlobFreshness,
  compareAuthFreshness,
  grokSessionNeedsLogin,
  toEpochMs,
} from './auth-freshness';

function jwt(claims: Record<string, unknown>): string {
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
    .toString('base64url');
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${head}.${body}.signature`;
}

const SEP_03 = Date.UTC(2026, 8, 3, 14, 43, 37);
const SEP_21 = Date.UTC(2026, 8, 21, 12, 16, 46);

describe('Grok OAuth renewal readiness', () => {
  const now = Date.UTC(2026, 9, 22);
  function renewable() {
    const parsed = JSON.parse(grokBlob(now - 21 * 86400000));
    const entry = Object.values(parsed)[0] as Record<string, unknown>;
    entry.oidc_issuer = 'https://issuer.example.test';
    entry.oidc_client_id = 'fixture-client';
    entry.user_id = 'fixture-user';
    return { parsed, entry };
  }

  it('does not confuse an old expired access token with an unrenewable OIDC session', () => {
    const { parsed } = renewable();
    expect(grokSessionNeedsLogin(JSON.stringify(parsed), now)).toBe(false);
  });

  it.each(['refresh_token', 'oidc_issuer', 'oidc_client_id', 'key', 'user_id'])(
    'keeps the expired-session refusal when renewal material %s is absent', field => {
      const { parsed, entry } = renewable();
      delete entry[field];
      expect(grokSessionNeedsLogin(JSON.stringify(parsed), now)).toBe(true);
    },
  );

  it('does not assemble a renewable session from fields belonging to different entries', () => {
    const { parsed, entry } = renewable();
    delete entry.refresh_token;
    parsed['another-synthetic-scope'] = { refresh_token: 'fixture-refresh' };
    expect(grokSessionNeedsLogin(JSON.stringify(parsed), now)).toBe(true);
  });

  it('refuses an old multi-entry blob even when every entry has complete OIDC renewal material', () => {
    const { parsed, entry } = renewable();
    parsed['another-synthetic-scope'] = { ...entry };
    expect(grokSessionNeedsLogin(JSON.stringify(parsed), now)).toBe(true);
  });

  it('refuses an old multi-entry blob with one renewable entry and one incomplete entry', () => {
    const { parsed } = renewable();
    parsed['another-synthetic-scope'] = {};
    expect(grokSessionNeedsLogin(JSON.stringify(parsed), now)).toBe(true);
  });
});

/** Formato real do Grok: mapa com chave composta e a sessão dentro de um JWT. */
function grokBlob(createdMs: number): string {
  return JSON.stringify({
    'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828': {
      key: jwt({
        iss: 'https://auth.x.ai',
        iat: Math.floor(createdMs / 1000),
        exp: Math.floor(createdMs / 1000) + 21_600,
      }),
      auth_mode: 'oidc',
      create_time: new Date(createdMs).toISOString(),
      email: 'user@example.com',
      refresh_token: 'opaque-refresh-token',
      expires_at: new Date(createdMs + 21_600_000).toISOString(),
    },
  });
}

/** Formato real do Codex: o único que a implementação anterior entendia. */
function codexBlob(refreshMs: number): string {
  return JSON.stringify({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: { access_token: jwt({ exp: Math.floor(refreshMs / 1000) + 3600 }) },
    last_refresh: new Date(refreshMs).toISOString(),
  });
}

describe('toEpochMs', () => {
  it('reads ISO-8601, seconds, milliseconds and microseconds alike', () => {
    const iso = '2026-09-21T12:16:46.000Z';
    const ms = Date.parse(iso);
    expect(toEpochMs(iso)).toBe(ms);
    expect(toEpochMs(ms)).toBe(ms);
    expect(toEpochMs(Math.floor(ms / 1000))).toBe(ms);
    expect(toEpochMs(ms * 1000)).toBe(ms);
    expect(toEpochMs(String(Math.floor(ms / 1000)))).toBe(ms);
  });

  it('refuses counters, flags and garbage instead of reading them as 1970', () => {
    for (const value of [0, 1, -1, 42, 2, NaN, Infinity, '', '  ', 'never', true, null, undefined, {}]) {
      expect(toEpochMs(value)).toBeNull();
    }
  });

  it('refuses instants outside a plausible credential window', () => {
    expect(toEpochMs(Date.UTC(1995, 0, 1))).toBeNull();
    expect(toEpochMs(Date.UTC(2200, 0, 1))).toBeNull();
  });
});

describe('authBlobFreshness', () => {
  it('reads the Grok shape the old engine was blind to', () => {
    const freshness = authBlobFreshness(grokBlob(SEP_21));
    expect(freshness).not.toBeNull();
    expect(freshness?.issuedAt).toBe(SEP_21);
    expect(freshness?.expiresAt).toBe(SEP_21 + 21_600_000);
  });

  it('still reads the Codex shape (no regression)', () => {
    expect(authBlobFreshness(codexBlob(SEP_21))?.issuedAt).toBe(SEP_21);
  });

  it('still reads the Kimi shape: top-level token with expires_at', () => {
    // Formato que a engine anterior tratava com um ramo dedicado: segundos.
    const seconds = JSON.stringify({
      access_token: 'opaque',
      expires_at: Math.floor(SEP_21 / 1000),
    });
    expect(authBlobFreshness(seconds)?.expiresAt).toBe(SEP_21);
    // …e snapshots importados que gravam o mesmo campo em milissegundos.
    const millis = JSON.stringify({ access_token: 'x', expires_at: SEP_21 });
    expect(authBlobFreshness(millis)?.expiresAt).toBe(SEP_21);
  });

  it('reads a bare JWT access token when nothing else carries a date', () => {
    // Ramo antigo: tokens.access_token → exp. Agora vale em qualquer posição.
    const exp = Math.floor(SEP_21 / 1000);
    const nested = JSON.stringify({ tokens: { access_token: jwt({ exp }) } });
    expect(authBlobFreshness(nested)?.expiresAt).toBe(SEP_21);
    const flat = JSON.stringify({ access_token: jwt({ exp }) });
    expect(authBlobFreshness(flat)?.expiresAt).toBe(SEP_21);
  });

  it('reads the OpenCode shape: provider map with millisecond expiry', () => {
    const blob = JSON.stringify({
      opencode: { type: 'oauth', access: 'a', refresh: 'r', expires: SEP_21 },
    });
    expect(authBlobFreshness(blob)).toEqual({
      issuedAt: null,
      expiresAt: SEP_21,
    });
  });

  it('descends into __nexusDirSnapshot files (Kimi/AGY multi-file vaults)', () => {
    const blob = JSON.stringify({
      __nexusDirSnapshot: true,
      root: 'credentials',
      files: { 'kimi-code.json': JSON.stringify({ expires_at: SEP_21 }) },
    });
    expect(authBlobFreshness(blob)?.expiresAt).toBe(SEP_21);
  });

  it('keeps the newest issuance and the furthest expiry across many entries', () => {
    const blob = JSON.stringify({
      a: { create_time: new Date(SEP_03).toISOString(), expires: SEP_03 },
      b: { create_time: new Date(SEP_21).toISOString(), expires: SEP_21 },
    });
    expect(authBlobFreshness(blob)).toEqual({
      issuedAt: SEP_21,
      expiresAt: SEP_21,
    });
  });

  it('never treats expires_in (a duration) as an instant', () => {
    expect(authBlobFreshness(JSON.stringify({ expires_in: 3600 }))).toBeNull();
  });

  it('returns null for blobs with no credible instant', () => {
    // Muse delega o token ao Keychain: identidade sem prazo não é frescor.
    const muse = JSON.stringify({
      schema_version: 2,
      providers: { meta: { mechanism: 'oauth', storage: 'keychain' } },
    });
    for (const blob of [muse, '{}', '[]', 'not json', '', 'null']) {
      expect(authBlobFreshness(blob)).toBeNull();
    }
  });

  it('never throws on hostile input', () => {
    let deep: unknown = { exp: 1_790_000_000 };
    for (let i = 0; i < 400; i += 1) deep = { nested: deep };
    expect(() => authBlobFreshness(JSON.stringify(deep))).not.toThrow();
    const wide = JSON.stringify(
      Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`k${i}`, i])),
    );
    expect(() => authBlobFreshness(wide)).not.toThrow();
    expect(() => authBlobFreshness('eyJ' + 'A'.repeat(10_000))).not.toThrow();
  });
});

describe('compareAuthFreshness', () => {
  it('orders two Grok logins by issuance — the field bug', () => {
    const stale = grokBlob(SEP_03);
    const fresh = grokBlob(SEP_21);
    expect(compareAuthFreshness(fresh, stale)).toBe(1);
    expect(compareAuthFreshness(stale, fresh)).toBe(-1);
    expect(compareAuthFreshness(fresh, fresh)).toBe(0);
  });

  it('prefers issuance over expiry when both sides carry both', () => {
    // Login novo com TTL curto vence login velho com TTL longo.
    const old = JSON.stringify({ created_at: SEP_03, expires_at: SEP_21 });
    const recent = JSON.stringify({ created_at: SEP_21, expires_at: SEP_03 });
    expect(compareAuthFreshness(recent, old)).toBe(1);
  });

  it('falls back to expiry only when neither side has issuance', () => {
    const a = JSON.stringify({ expires_at: SEP_03 });
    const b = JSON.stringify({ expires_at: SEP_21 });
    expect(compareAuthFreshness(b, a)).toBe(1);
  });

  it('reports incomparable rather than a false tie', () => {
    const issuedOnly = JSON.stringify({ created_at: SEP_21 });
    const expiryOnly = JSON.stringify({ expires_at: SEP_21 });
    expect(compareAuthFreshness(issuedOnly, expiryOnly)).toBeNull();
    expect(compareAuthFreshness(issuedOnly, '{}')).toBeNull();
    expect(compareAuthFreshness('not json', issuedOnly)).toBeNull();
  });
});
