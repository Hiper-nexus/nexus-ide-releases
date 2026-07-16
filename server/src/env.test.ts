import { describe, expect, it } from 'vitest';
import { parseEnv } from './env';

const FULL = {
  DATABASE_URL: 'postgres://x',
  LICENSE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----',
  LICENSE_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----\nx\n-----END PUBLIC KEY-----',
  GITHUB_OAUTH_ID: 'gid',
  GITHUB_OAUTH_SECRET: 'gsec',
  GOOGLE_OAUTH_ID: 'ggid',
  GOOGLE_OAUTH_SECRET: 'ggsec',
  PUBLIC_BASE_URL: 'https://api.nexuside.app',
  APP_DEEP_LINK_BASE: 'nexus://auth',
  STRIPE_SECRET_KEY: 'sk_test_x',
  STRIPE_WEBHOOK_SECRET: 'whsec_x',
  STRIPE_PRICE_PRO: 'price_pro',
  PUBLIC_SITE_URL: 'https://nexuside.app',
};

describe('parseEnv', () => {
  it('aceita env completo e aplica PORT default 8080', () => {
    const env = parseEnv(FULL);
    expect(env.DATABASE_URL).toBe('postgres://x');
    expect(env.PORT).toBe(8080);
    expect(env.DATABASE_CONNECTION_TIMEOUT_MS).toBeGreaterThan(0);
    expect(env.DATABASE_QUERY_TIMEOUT_MS).toBeGreaterThan(0);
    expect(env.DATABASE_STATEMENT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(env.DATABASE_READINESS_TIMEOUT_MS).toBeGreaterThan(0);
    expect(env.SERVER_CLEANUP_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('lança quando falta um segredo obrigatório', () => {
    const { LICENSE_PRIVATE_KEY: _omit, ...missing } = FULL;
    expect(() => parseEnv(missing)).toThrow(/LICENSE_PRIVATE_KEY/);
  });

  it('rejeita PUBLIC_BASE_URL que não é URL', () => {
    expect(() => parseEnv({ ...FULL, PUBLIC_BASE_URL: 'nao-url' })).toThrow();
  });

  it('exige as vars do Stripe', () => {
    expect(() => parseEnv({ ...FULL, STRIPE_SECRET_KEY: undefined } as never)).toThrow(/STRIPE_SECRET_KEY/);
    expect(() => parseEnv({ ...FULL, STRIPE_WEBHOOK_SECRET: undefined } as never)).toThrow(/STRIPE_WEBHOOK_SECRET/);
    expect(() => parseEnv({ ...FULL, STRIPE_PRICE_PRO: undefined } as never)).toThrow(/STRIPE_PRICE_PRO/);
  });

  it('aceita STRIPE_PRICE_TEAM apenas para compatibilidade com assinaturas legadas', () => {
    expect(parseEnv({ ...FULL, STRIPE_PRICE_TEAM: 'price_team_legacy' }).STRIPE_PRICE_TEAM)
      .toBe('price_team_legacy');
    expect(parseEnv(FULL).STRIPE_PRICE_TEAM).toBeUndefined();
  });

  it('rejeita PUBLIC_SITE_URL que não é URL', () => {
    expect(() => parseEnv({ ...FULL, PUBLIC_SITE_URL: 'nao-e-url' })).toThrow();
  });

  it('accepts bounded database timeout overrides and rejects unsafe values', () => {
    const env = parseEnv({
      ...FULL,
      DATABASE_CONNECTION_TIMEOUT_MS: '1500',
      DATABASE_QUERY_TIMEOUT_MS: '2500',
      DATABASE_STATEMENT_TIMEOUT_MS: '2000',
      DATABASE_READINESS_TIMEOUT_MS: '1200',
      SERVER_CLEANUP_TIMEOUT_MS: '800',
    });

    expect(env).toMatchObject({
      DATABASE_CONNECTION_TIMEOUT_MS: 1500,
      DATABASE_QUERY_TIMEOUT_MS: 2500,
      DATABASE_STATEMENT_TIMEOUT_MS: 2000,
      DATABASE_READINESS_TIMEOUT_MS: 1200,
      SERVER_CLEANUP_TIMEOUT_MS: 800,
    });
    expect(() => parseEnv({
      ...FULL,
      DATABASE_READINESS_TIMEOUT_MS: '0',
    })).toThrow(/DATABASE_READINESS_TIMEOUT_MS/);
    expect(() => parseEnv({
      ...FULL,
      DATABASE_QUERY_TIMEOUT_MS: '60001',
    })).toThrow(/DATABASE_QUERY_TIMEOUT_MS/);
  });
});
