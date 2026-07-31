import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyGatewayBaseUrls,
  GATEWAY_BASE_URL_ENV,
  resolveGatewayBaseUrl,
} from './gateway-env';

const GATEWAY = 'http://127.0.0.1:20128/v1';

const claudeLike = {
  id: 'claude',
  env: { passthrough: ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'] },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveGatewayBaseUrl', () => {
  it('reads the gateway URL and strips the trailing slash', () => {
    expect(
      resolveGatewayBaseUrl({ [GATEWAY_BASE_URL_ENV]: `${GATEWAY}/` }),
    ).toBe(GATEWAY);
  });

  it('stays off when the variable is absent', () => {
    expect(resolveGatewayBaseUrl({})).toBeNull();
  });

  it('refuses a non-http scheme instead of feeding it to every CLI', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(
      resolveGatewayBaseUrl({ [GATEWAY_BASE_URL_ENV]: 'file:///etc/passwd' }),
    ).toBeNull();
    expect(
      resolveGatewayBaseUrl({ [GATEWAY_BASE_URL_ENV]: 'não é url' }),
    ).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});

describe('applyGatewayBaseUrls', () => {
  it('points only the base-URL vars the adapter itself declared', () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: 'k' };
    applyGatewayBaseUrls(env, claudeLike, GATEWAY);
    expect(env.ANTHROPIC_BASE_URL).toBe(GATEWAY);
    // Nunca inventa uma var que a CLI não conhece.
    expect(env.OPENAI_BASE_URL).toBeUndefined();
    // Nunca toca em credencial.
    expect(env.ANTHROPIC_API_KEY).toBe('k');
  });

  it('leaves everything untouched when no gateway is configured', () => {
    const env: NodeJS.ProcessEnv = { ANTHROPIC_BASE_URL: 'https://original' };
    applyGatewayBaseUrls(env, claudeLike, null);
    expect(env.ANTHROPIC_BASE_URL).toBe('https://original');
  });

  it('routes the OpenAI surface for adapters that declare it', () => {
    const env: NodeJS.ProcessEnv = {};
    applyGatewayBaseUrls(
      env,
      { id: 'codex', env: { passthrough: ['OPENAI_BASE_URL'] } },
      GATEWAY,
    );
    expect(env.OPENAI_BASE_URL).toBe(GATEWAY);
  });
});
