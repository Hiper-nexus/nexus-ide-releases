import { describe, expect, it } from 'vitest';
import {
  buildProviderRoutingEnv,
  getUpstreamProvider,
  listUpstreamProviders,
  UPSTREAM_PROVIDERS,
} from './launcher-provider-manager';

describe('launcher provider routing (ported from ~/ai-launcher)', () => {
  it('exposes the canonical provider table', () => {
    const ids = listUpstreamProviders().map((p) => p.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'anthropic',
        'glm',
        'sakana',
        'openrouter',
        'deepseek',
        'ollama',
        'lmstudio',
        'litellm',
      ]),
    );
  });

  it('keeps the exact GLM/Z.ai base URL and routing env', () => {
    expect(UPSTREAM_PROVIDERS.glm.baseUrl).toBe('https://api.z.ai/api/anthropic');
    const env = buildProviderRoutingEnv('glm', 'zai-token');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.z.ai/api/anthropic');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('zai-token');
    // Extra env ported verbatim from PROVIDER_EXTRA_ENV[glm].
    expect(env.API_TIMEOUT_MS).toBe('600000');
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-4.6');
    // Third parties use AUTH_TOKEN, never API_KEY.
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('returns no routing env for native anthropic', () => {
    expect(buildProviderRoutingEnv('anthropic', 'x')).toEqual({});
  });

  it('refuses to route a token-required provider without a token', () => {
    expect(buildProviderRoutingEnv('glm', null)).toEqual({});
    expect(buildProviderRoutingEnv('sakana', null)).toEqual({});
  });

  it('routes local providers without a token', () => {
    const env = buildProviderRoutingEnv('ollama', null);
    expect(env.ANTHROPIC_BASE_URL).toBe('http://localhost:11434');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it('gives OpenRouter both the auth token and its own key var', () => {
    const env = buildProviderRoutingEnv('openrouter', 'or-key');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('or-key');
    expect(env.OPENROUTER_API_KEY).toBe('or-key');
  });

  it('returns null for an unknown provider', () => {
    expect(getUpstreamProvider('nope')).toBeNull();
    expect(buildProviderRoutingEnv('nope', 'x')).toEqual({});
  });
});
