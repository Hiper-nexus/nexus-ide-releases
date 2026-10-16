import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ tokens: new Map<string, string>(), mode: 'auto' as 'auto' | 'jev' | 'clef' | 'luna' | 'together', vaultReads: [] as string[],
  vision: {} as { visionEnabled?: boolean; visionConsent?: { version: 1; recipients: ('clef' | 'luna')[] } } }));
vi.mock('../persistence/settings-store', () => ({ getOrchSettings: () => ({ decisionModels: {
  mode: state.mode, clefModel: 'clef', cloudflareAccountId: '0123456789abcdef0123456789abcdef', visionEnabled: false, ...state.vision,
} }) }));
vi.mock('../persistence/secrets-store', () => ({
  hasSecret: (name: string) => { state.vaultReads.push(name); return state.tokens.has(name); }, getSecret: (name: string) => state.tokens.get(name) ?? null,
  setSecret: (name: string, value: string) => { if (value) state.tokens.set(name, value); else state.tokens.delete(name); return { ok: true }; },
  isSecureStorageAvailable: () => true,
}));
import { decisionConfigurationKey, getDecisionAvailability, hasDecisionCredential } from './decision-availability';
import { setClefApiToken } from './clef-secrets';

describe('configured decision availability', () => {
  beforeEach(() => { state.tokens.clear(); state.vaultReads.length = 0; state.mode = 'auto'; state.vision = {}; delete process.env.TYPESAFE_API_KEY; delete process.env.NEXUS_CLEF_API_TOKEN; delete process.env.OPENAI_API_KEY; });

  it('makes Clef usable without a TypeSafe key and respects Jev-only selection', () => {
    setClefApiToken('synthetic-token');
    expect(hasDecisionCredential('toolPick')).toBe(true);
    state.mode = 'jev';
    expect(hasDecisionCredential('toolPick')).toBe(false);
  });

  it('does not read the vault for the provider the selected mode can never use', () => {
    state.mode = 'jev';
    expect(getDecisionAvailability()).toEqual({ jev: false, clef: false, luna: false });
    expect(state.vaultReads.some(name => name.startsWith('clef-env:') || name.startsWith('voice-env:'))).toBe(false);
    state.vaultReads.length = 0; state.mode = 'clef';
    getDecisionAvailability();
    expect(state.vaultReads.some(name => name.startsWith('jev-env:') || name.startsWith('voice-env:'))).toBe(false);
    state.vaultReads.length = 0; state.mode = 'luna';
    getDecisionAvailability();
    expect(state.vaultReads.some(name => name.startsWith('clef-env:') || name.startsWith('jev-env:'))).toBe(false);
    expect(new Set(state.vaultReads.map(name => name.split(':')[0]))).toEqual(new Set(['voice-env']));
    state.vaultReads.length = 0; state.mode = 'together';
    getDecisionAvailability();
    expect(new Set(state.vaultReads.map(name => name.split(':')[0]))).toEqual(new Set(['jev-env', 'clef-env', 'voice-env']));
    state.vaultReads.length = 0; state.mode = 'auto';
    getDecisionAvailability();
    expect(new Set(state.vaultReads.map(name => name.split(':')[0]))).toEqual(new Set(['jev-env', 'clef-env', 'voice-env']));
  });

  it('Somente Jev reads only the image recipient the operator authorized, and text stays on Jev', () => {
    setClefApiToken('synthetic-token');
    state.mode = 'jev'; state.vision = { visionEnabled: true, visionConsent: { version: 1, recipients: ['clef'] } };
    state.vaultReads.length = 0;
    expect(getDecisionAvailability()).toEqual({ jev: false, clef: true, luna: false });
    expect(state.vaultReads.some(name => name.startsWith('voice-env:'))).toBe(false);
    expect(hasDecisionCredential('toolPick')).toBe(false);
    state.vision = { visionEnabled: false, visionConsent: { version: 1, recipients: ['clef'] } };
    expect(getDecisionAvailability().clef).toBe(false);
  });

  it('invalidates in-flight/cache identity when a present token is rotated', () => {
    setClefApiToken('synthetic-token-one');
    const before = decisionConfigurationKey();
    setClefApiToken('synthetic-token-two');
    expect(decisionConfigurationKey()).not.toBe(before);
    expect(decisionConfigurationKey()).not.toContain('synthetic-token');
  });
});
