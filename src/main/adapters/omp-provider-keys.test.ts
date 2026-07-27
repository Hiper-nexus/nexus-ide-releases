import { describe, expect, it } from 'vitest';
import {
  buildOmpInheritedKeyEnv,
  buildOmpSelectedProviderKeyEnv,
  hasOmpSelectedProviderKey,
  resolveOmpSelectedProviderKey,
} from './omp-provider-keys';

describe('OMP provider/model-scoped key env', () => {
  it('injects only the selected model provider key', () => {
    const vault: Record<string, string> = {
      glm: 'glm-secreta',
      openrouter: 'or-secreta',
    };
    const seen: string[] = [];
    const env = buildOmpSelectedProviderKeyEnv(
      'zai/glm-5',
      (id) => {
        seen.push(id);
        return vault[id] ?? null;
      },
    );
    expect(env).toEqual({
      ZAI_API_KEY: 'glm-secreta',
    });
    expect(seen).toEqual(['glm']);
  });

  it('a different selected provider never receives neighboring keys', () => {
    const vault: Record<string, string> = {
      anthropic: 'anthropic-secret',
      deepseek: 'deepseek-secret',
      openrouter: 'openrouter-secret',
    };
    expect(
      buildOmpSelectedProviderKeyEnv(
        'deepseek/deepseek-v4-pro',
        (id) => vault[id] ?? null,
      ),
    ).toEqual({ DEEPSEEK_API_KEY: 'deepseek-secret' });
  });

  it('missing selected key produces an empty env', () => {
    expect(
      buildOmpSelectedProviderKeyEnv('openrouter/openai/gpt-5', () => null),
    ).toEqual({});
    expect(
      hasOmpSelectedProviderKey('openrouter/openai/gpt-5', () => null),
    ).toBe(false);
  });

  it('unknown and malformed model routes fail closed without probing the vault', () => {
    const seen: string[] = [];
    const load = (id: string) => {
      seen.push(id);
      return 'must-not-flow';
    };
    expect(buildOmpSelectedProviderKeyEnv('future/model', load)).toEqual({});
    expect(buildOmpSelectedProviderKeyEnv('malformed', load)).toEqual({});
    expect(buildOmpSelectedProviderKeyEnv(undefined, load)).toEqual({});
    expect(seen).toEqual([]);
  });

  it('subscription-only provider aliases never receive a launcher key', () => {
    const seen: string[] = [];
    expect(
      buildOmpSelectedProviderKeyEnv(
        'openai-codex/gpt-5.5',
        (id) => {
          seen.push(id);
          return 'sk-openai';
        },
      ),
    ).toEqual({});
    expect(seen).toEqual([]);

    expect(
      buildOmpSelectedProviderKeyEnv(
        'xai-oauth/grok-4.5',
        (id) => {
          seen.push(id);
          return 'must-not-flow';
        },
      ),
    ).toEqual({});
    expect(
      buildOmpSelectedProviderKeyEnv(
        'google-gemini-cli/gemini-3',
        (id) => {
          seen.push(id);
          return 'must-not-flow';
        },
      ),
    ).toEqual({});
    expect(seen).toEqual([]);
  });

  it('returns secret-free route metadata alongside the scoped env', () => {
    const selected = resolveOmpSelectedProviderKey(
      'xai/grok-4.5',
      (id) => (id === 'xai' ? 'xai-secret' : null),
    );
    expect(selected).toEqual({
      modelProvider: 'xai',
      launcherProviderId: 'xai',
      env: { XAI_API_KEY: 'xai-secret' },
    });
  });

  it('auth-broker compatibility path with no model receives no launcher key', () => {
    const seen: string[] = [];
    expect(
      buildOmpInheritedKeyEnv(undefined, (id) => {
        seen.push(id);
        return 'must-not-flow';
      }),
    ).toEqual({});
    expect(seen).toEqual([]);
  });
});
