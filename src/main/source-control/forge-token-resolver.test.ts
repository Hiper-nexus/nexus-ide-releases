import { afterEach, describe, expect, it } from 'vitest';
import {
  assertNotProjectNexusSecretPath,
  createMemoryForgeTokenResolver,
  getForgeTokenResolver,
  resolveForgeToken,
  setForgeTokenResolver,
  tokenCacheKey,
} from './forge-token-resolver';

afterEach(() => {
  setForgeTokenResolver(null);
});

describe('forge-token-resolver', () => {
  it('resolves injected tokens and never requires project path', async () => {
    const resolver = createMemoryForgeTokenResolver({
      'github:default:user1': 'ghp_test',
    });
    setForgeTokenResolver(resolver);
    expect(getForgeTokenResolver()).toBe(resolver);
    const token = await resolveForgeToken({
      provider: 'github',
      accountId: 'user1',
    });
    expect(token).toBe('ghp_test');
  });

  it('tokenCacheKey is stable', () => {
    expect(
      tokenCacheKey({ provider: 'gitlab', accountId: 'a', host: 'gitlab.com' }),
    ).toBe('gitlab:gitlab.com:a');
  });

  it('refuses project-scoped .nexus secret paths', () => {
    expect(() =>
      assertNotProjectNexusSecretPath('/repo/checkout/.nexus/tokens.json'),
    ).toThrow(/project-scoped|refusing/);
    expect(() =>
      assertNotProjectNexusSecretPath('/repo/checkout/.nexus/project.json'),
    ).toThrow(/refusing/);
    expect(() =>
      assertNotProjectNexusSecretPath('/Users/me/.nexus/settings.json'),
    ).not.toThrow();
    expect(() =>
      assertNotProjectNexusSecretPath('/Users/me/.nexus/agent-hooks/claude-hook.sh'),
    ).not.toThrow();
  });
});
