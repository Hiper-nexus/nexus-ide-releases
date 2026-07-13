import { describe, expect, it } from 'vitest';
import {
  catalogEmptyCta,
  catalogEmptyKindFromMessage,
  catalogInstallableEmptyMessage,
} from './empty-cta-policy';

describe('catalogEmptyCta policy', () => {
  it('offers marketplace only for installable missing agents/skills', () => {
    expect(catalogEmptyCta('installable')).toBe('marketplace');
    expect(
      catalogEmptyKindFromMessage(
        'Nenhum agent instalado — use o Marketplace para instalar.',
      ),
    ).toBe('installable');
    expect(
      catalogEmptyKindFromMessage(
        'Nenhuma skill instalada — use o Marketplace para instalar.',
      ),
    ).toBe('installable');
  });

  it('does not offer marketplace for tier filter, plugins, or hooks', () => {
    expect(catalogEmptyCta('tier-filter')).toBe('none');
    expect(catalogEmptyCta('plugins')).toBe('none');
    expect(catalogEmptyCta('hooks')).toBe('none');
    expect(
      catalogEmptyKindFromMessage(
        'Nenhum agent no tier builder — rode "Enriquecer" para classificar.',
      ),
    ).toBe('tier-filter');
    expect(
      catalogEmptyKindFromMessage(
        'Nenhum plugin de usuário — solte um JSON de adapter em ~/.nexus/plugins/adapters.',
      ),
    ).toBe('plugins');
    expect(
      catalogEmptyKindFromMessage(
        'Nenhum hook ativo — são gerados ao spawnar workers de squad com allowlist.',
      ),
    ).toBe('hooks');
  });
});

describe('catalogInstallableEmptyMessage → policy path (Agents/Skills)', () => {
  it('0 installed + any tier → installable + marketplace CTA', () => {
    for (const tier of ['todos', 'scout', 'builder', 'reviewer'] as const) {
      const agentMsg = catalogInstallableEmptyMessage('agent', 0, tier);
      const skillMsg = catalogInstallableEmptyMessage('skill', 0, tier);
      expect(catalogEmptyKindFromMessage(agentMsg)).toBe('installable');
      expect(catalogEmptyKindFromMessage(skillMsg)).toBe('installable');
      expect(catalogEmptyCta(catalogEmptyKindFromMessage(agentMsg))).toBe(
        'marketplace',
      );
      expect(catalogEmptyCta(catalogEmptyKindFromMessage(skillMsg))).toBe(
        'marketplace',
      );
      expect(agentMsg).toMatch(/Marketplace/i);
      expect(skillMsg).toMatch(/Marketplace/i);
      expect(agentMsg).not.toMatch(/Enriquecer/i);
    }
  });

  it('base installed but filter empty → tier-filter, no marketplace CTA', () => {
    const agentMsg = catalogInstallableEmptyMessage('agent', 3, 'builder');
    const skillMsg = catalogInstallableEmptyMessage('skill', 2, 'scout');
    expect(catalogEmptyKindFromMessage(agentMsg)).toBe('tier-filter');
    expect(catalogEmptyKindFromMessage(skillMsg)).toBe('tier-filter');
    expect(catalogEmptyCta(catalogEmptyKindFromMessage(agentMsg))).toBe('none');
    expect(catalogEmptyCta(catalogEmptyKindFromMessage(skillMsg))).toBe('none');
    expect(agentMsg).toMatch(/tier builder/i);
    expect(skillMsg).toMatch(/Enriquecer/i);
  });
});
