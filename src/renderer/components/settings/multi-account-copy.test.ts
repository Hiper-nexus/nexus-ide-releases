import { describe, expect, it } from 'vitest';
import {
  ALL_MULTI_ACCOUNT_ADAPTER_IDS,
  apiKeyChoiceBlurb,
  multiAccountAddCopy,
  sessionChoiceBlurb,
} from './multi-account-copy';
import { isFileAuthAdapter } from '../../../shared/file-auth-adapters';

/** Mirrors main `supportsSessionSnapshot` without loading account-store/DB. */
function supportsSessionSnapshot(adapterId: string): boolean {
  return adapterId === 'claude' || isFileAuthAdapter(adapterId);
}

describe('multiAccountAddCopy — ordinal rules', () => {
  it('vault empty + no em uso → 1ª conta', () => {
    const c = multiAccountAddCopy({
      vaultCount: 0,
      standbyCount: 0,
      hasEmUso: false,
    });
    expect(c.nextOrdinal).toBe(1);
    expect(c.title).toBe('Adicionar a 1ª conta');
    expect(c.chip).toBe('Multi-conta');
    expect(c.chipOn).toBe(false);
  });

  it('vault empty + em uso (sessão nativa) → 2ª conta, never 1ª', () => {
    const c = multiAccountAddCopy({
      vaultCount: 0,
      standbyCount: 0,
      hasEmUso: true,
    });
    expect(c.nextOrdinal).toBe(2);
    expect(c.title).toBe('Adicionar a 2ª conta');
    expect(c.title).not.toMatch(/1ª/);
    expect(c.sub).toMatch(/já é a 1ª/i);
    expect(c.chip).toMatch(/falta reserva/i);
  });

  it('1 no vault → próximo é 2ª', () => {
    const c = multiAccountAddCopy({
      vaultCount: 1,
      standbyCount: 0,
      hasEmUso: true,
    });
    expect(c.nextOrdinal).toBe(2);
    expect(c.title).toBe('Adicionar a 2ª conta');
    expect(c.chipOn).toBe(true);
  });

  it('3 no vault → próximo é 4ª', () => {
    const c = multiAccountAddCopy({
      vaultCount: 3,
      standbyCount: 2,
      hasEmUso: true,
    });
    expect(c.nextOrdinal).toBe(4);
    expect(c.title).toBe('Adicionar a 4ª conta');
    expect(c.chip).toBe('Multi-conta · 3');
    expect(c.chipOn).toBe(true);
  });
});

describe('multi-account copy for every builtin LLM adapter', () => {
  for (const adapterId of ALL_MULTI_ACCOUNT_ADAPTER_IDS) {
    it(`${adapterId}: ordinal + blurb stable with em uso`, () => {
      const copy = multiAccountAddCopy({
        vaultCount: 0,
        standbyCount: 0,
        hasEmUso: true,
      });
      expect(copy.title).toBe('Adicionar a 2ª conta');

      const label = adapterId;
      const session = sessionChoiceBlurb({
        adapterLabel: label,
        hasEmUso: true,
        vaultCount: 0,
      });
      expect(session).toContain(label);
      expect(session).toMatch(/2ª conta/);

      const api = apiKeyChoiceBlurb({ hasEmUso: true, vaultCount: 0 });
      expect(api).toMatch(/2ª conta/);
    });

    it(`${adapterId}: cold start (no auth) is 1ª conta`, () => {
      const copy = multiAccountAddCopy({
        vaultCount: 0,
        standbyCount: 0,
        hasEmUso: false,
      });
      expect(copy.title).toBe('Adicionar a 1ª conta');
    });
  }
});

describe('supportsSessionSnapshot matrix (main vault)', () => {
  // OAuth / session snapshot: Claude keychain + file-auth CLIs.
  // API-only (glm, longcat, aider) → só botão API key na UI.
  const expectSnapshot: Record<string, boolean> = {
    claude: true,
    codex: true,
    agy: true,
    grok: true,
    kimi: true,
    opencode: true,
    openclaude: false,
    glm: false,
    longcat: false,
    aider: false,
  };

  for (const adapterId of ALL_MULTI_ACCOUNT_ADAPTER_IDS) {
    it(`${adapterId}: supportsSessionSnapshot=${expectSnapshot[adapterId]}`, () => {
      expect(supportsSessionSnapshot(adapterId)).toBe(expectSnapshot[adapterId]);
      if (adapterId !== 'claude' && expectSnapshot[adapterId]) {
        expect(isFileAuthAdapter(adapterId)).toBe(true);
      }
    });
  }
});
