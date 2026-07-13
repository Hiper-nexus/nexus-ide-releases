/**
 * Structural contract: agent-picker empty must open Providers via shipped store.
 * Avoids mounting full WorkspaceBar (heavy); asserts source wiring + policy.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { catalogEmptyCta, catalogEmptyKindFromMessage } from './empty-cta-policy';

const ROOT = path.resolve(__dirname, '../..');

describe('agent-picker / empty CTA contracts', () => {
  it('WorkspaceBar empty CLI path opens providers drawer', () => {
    const src = readFileSync(
      path.join(ROOT, 'renderer/components/WorkspaceBar.tsx'),
      'utf8',
    );
    expect(src).toContain('EmptyState');
    expect(src).toContain("openDrawer('providers')");
    expect(src).toContain('Nenhuma CLI encontrada');
    expect(src).toContain('Abrir Providers');
  });

  it('AccountSwitcher empty vault opens providers and explains native ≠ vault', () => {
    const src = readFileSync(
      path.join(ROOT, 'renderer/components/AccountSwitcher.tsx'),
      'utf8',
    );
    expect(src).toContain('EmptyState');
    expect(src).toContain("openDrawer('providers')");
    expect(src).toContain('Vault multi-conta vazio');
    expect(src).toContain('sessão nativa');
    expect(src).toContain('Salvar sessão logada');
  });

  it('PetSection primary create/import use ActionCard', () => {
    const src = readFileSync(
      path.join(ROOT, 'renderer/components/settings/PetSection.tsx'),
      'utf8',
    );
    expect(src).toContain('ActionCard');
    expect(src).toContain('Criar pet com IA');
    expect(src).toContain('Importar spritesheet do Codex');
    // Primary path should not require legacy pet-import__btn for create/import
    expect(src).not.toMatch(
      /settings-pet-import__btn settings-pet-import__btn--primary/,
    );
  });

  it('plugin/hook empties do not get marketplace via policy', () => {
    expect(
      catalogEmptyCta(
        catalogEmptyKindFromMessage(
          'Nenhum plugin de usuário — solte um JSON',
        ),
      ),
    ).toBe('none');
    expect(
      catalogEmptyCta(
        catalogEmptyKindFromMessage('Nenhum hook ativo — são gerados'),
      ),
    ).toBe('none');
  });

  it('Rules / LLMs / DesignSystems / MediaCatalog empties use EmptyState pattern', () => {
    const rules = readFileSync(
      path.join(ROOT, 'renderer/components/settings/CatalogSections.tsx'),
      'utf8',
    );
    expect(rules).toContain('Nenhuma regra');
    expect(rules).toContain("openDrawer('squads')");
    expect(rules).toContain('Nenhum LLM/CLI habilitado');
    expect(rules).toContain("openDrawer('providers')");
    expect(rules).toContain('catalogInstallableEmptyMessage');
    expect(rules).toContain('Nenhum provider de mídia');
    expect(rules).toContain("openDrawer('media')");
    expect(rules).not.toMatch(
      /settings-detail__hint">nenhum provider de mídia/,
    );
    const design = readFileSync(
      path.join(ROOT, 'renderer/components/settings/DesignSystemsSection.tsx'),
      'utf8',
    );
    expect(design).toContain('EmptyState');
    expect(design).toContain('Nenhum kit encontrado');
  });

  it('MissionRail and CommandPalette empties use EmptyState + ActionCard', () => {
    const rail = readFileSync(
      path.join(ROOT, 'renderer/components/MissionRail.tsx'),
      'utf8',
    );
    expect(rail).toContain('EmptyState');
    expect(rail).toContain('ActionCard');
    expect(rail).toContain('Nova missão');
    const palette = readFileSync(
      path.join(ROOT, 'renderer/components/CommandPalette.tsx'),
      'utf8',
    );
    expect(palette).toContain('EmptyState');
    expect(palette).toContain("openDrawer('providers')");
  });
});
