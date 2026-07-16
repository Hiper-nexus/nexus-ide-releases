import { describe, expect, it } from 'vitest';
import { relayOptionsFromEnv } from './relay-server-main';

describe('relayOptionsFromEnv', () => {
  it('uses Railway PORT and preserves the configured browser origin', () => {
    expect(
      relayOptionsFromEnv({
        PORT: '8080',
        RELAY_ALLOWED_ORIGINS: 'https://app.nexuside.app',
      }),
    ).toMatchObject({
      port: 8080,
      host: '0.0.0.0',
      allowedOrigins: ['https://app.nexuside.app'],
    });
  });

  it('fails closed when production has no browser origin allowlist', () => {
    expect(() => relayOptionsFromEnv({ NODE_ENV: 'production' })).toThrow(
      'RELAY_ALLOWED_ORIGINS is required in production',
    );
  });

  it('rejects invalid numeric limits before binding a public port', () => {
    expect(() =>
      relayOptionsFromEnv({
        RELAY_ALLOWED_ORIGINS: 'https://app.nexuside.app',
        RELAY_MAX_ROOMS: '0',
      }),
    ).toThrow('RELAY_MAX_ROOMS must be between 1 and 10000');
  });
});
