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
  STRIPE_PRICE_TEAM: 'price_team',
  PUBLIC_SITE_URL: 'https://nexuside.app',
};

describe('parseEnv', () => {
  it('aceita env completo e aplica PORT default 8080', () => {
    const env = parseEnv(FULL);
    expect(env.DATABASE_URL).toBe('postgres://x');
    expect(env.PORT).toBe(8080);
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
    const ok = parseEnv({
      ...FULL,
      STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x',
      STRIPE_PRICE_PRO: 'price_pro', STRIPE_PRICE_TEAM: 'price_team',
      PUBLIC_SITE_URL: 'https://nexuside.app',
    });
    expect(ok.STRIPE_PRICE_PRO).toBe('price_pro');
  });
});
