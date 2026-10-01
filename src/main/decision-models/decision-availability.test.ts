import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ tokens: new Map<string, string>(), mode: 'auto' as 'auto' | 'jev' | 'clef' }));
vi.mock('../persistence/settings-store', () => ({ getOrchSettings: () => ({ decisionModels: {
  mode: state.mode, clefModel: 'clef', cloudflareAccountId: '0123456789abcdef0123456789abcdef', visionEnabled: false,
} }) }));
vi.mock('../persistence/secrets-store', () => ({
  hasSecret: (name: string) => state.tokens.has(name), getSecret: (name: string) => state.tokens.get(name) ?? null,
  setSecret: (name: string, value: string) => { if (value) state.tokens.set(name, value); else state.tokens.delete(name); return { ok: true }; },
  isSecureStorageAvailable: () => true,
}));
import { decisionConfigurationKey, hasDecisionCredential } from './decision-availability';
import { setClefApiToken } from './clef-secrets';

describe('configured decision availability', () => {
  beforeEach(() => { state.tokens.clear(); state.mode = 'auto'; delete process.env.TYPESAFE_API_KEY; delete process.env.CLOUDFLARE_API_TOKEN; });

  it('makes Clef usable without a TypeSafe key and respects Jev-only selection', () => {
    setClefApiToken('synthetic-token');
    expect(hasDecisionCredential('toolPick')).toBe(true);
    state.mode = 'jev';
    expect(hasDecisionCredential('toolPick')).toBe(false);
  });

  it('invalidates in-flight/cache identity when a present token is rotated', () => {
    setClefApiToken('synthetic-token-one');
    const before = decisionConfigurationKey();
    setClefApiToken('synthetic-token-two');
    expect(decisionConfigurationKey()).not.toBe(before);
    expect(decisionConfigurationKey()).not.toContain('synthetic-token');
  });
});
