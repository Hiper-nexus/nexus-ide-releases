// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

/**
 * Charter tiering — the worker prompt must stay proportional to the task:
 * recon/planning roles get no build charters, reviewers skip the diff ladder,
 * and the design charter only rides along when the task actually touches UI.
 */

vi.mock('./workspace-path', () => ({ resolveCwdForScope: vi.fn() }));
vi.mock('./pane-registry', () => ({
  getPaneAuthzInfo: vi.fn(),
  requestPaneSpawn: vi.fn(),
  waitForIdle: vi.fn(),
}));
vi.mock('./pane-authz', () => ({ authorizePaneAccess: vi.fn() }));
vi.mock('../pty/pty-manager', () => ({ orchWriteSession: vi.fn(() => true) }));
vi.mock('../adapters/adapter-registry', () => ({ getAdapter: vi.fn() }));
vi.mock('./legacy-handoff', () => ({ LEGACY_MARKER: 'marker' }));
vi.mock('./ponytail', () => ({ PONYTAIL_RULES: '[PONYTAIL]' }));
vi.mock('./engineering-charter', () => ({ ENGINEERING_CHARTER: '[ENGINEERING]' }));
vi.mock('./design-charter', () => ({ DESIGN_CHARTER: '[DESIGN]' }));
vi.mock('../persistence/settings-store', () => ({
  getOrchSettings: vi.fn(() => ({
    leanCode: true,
    seniorMode: true,
    designPro: true,
  })),
}));

import { charterTierForWorker, withHandoffContract } from './tool-util';

const mcpAdapter = { quirks: { nexusMcp: 'opencode' } };

describe('charterTierForWorker', () => {
  it('gives executors full build discipline, design only on UI tasks', () => {
    expect(
      charterTierForWorker({
        prompt: 'Corrigir o parser de datas no backend',
        category: 'executor',
      }),
    ).toEqual({ engineering: true, design: false, lean: true });
    expect(
      charterTierForWorker({
        prompt: 'Refinar a tela de perfil com estados vazios',
        category: 'executor',
      }),
    ).toEqual({ engineering: true, design: true, lean: true });
  });

  it('detects UI work from the pane title/agent name hints too', () => {
    expect(
      charterTierForWorker({
        prompt: 'Melhorar a entrega conforme o handoff anterior',
        category: 'executor',
        hints: ['Frontend', undefined],
      }).design,
    ).toBe(true);
  });

  it('drops the diff ladder for reviewers but keeps the engineering bar', () => {
    expect(
      charterTierForWorker({
        prompt: 'Revisar o diff de autenticação',
        category: 'reviewer',
      }),
    ).toEqual({ engineering: true, design: false, lean: false });
  });

  it('sends scouts and architects without any charter payload', () => {
    for (const category of ['scout', 'architect']) {
      expect(
        charterTierForWorker({
          prompt: 'Levantar como o design system é consumido pela UI',
          category,
        }),
      ).toEqual({ engineering: false, design: false, lean: false });
    }
  });

  it('treats unclassified spawns as executors (fail-safe: keep discipline)', () => {
    expect(charterTierForWorker({ prompt: 'Tarefa ad-hoc' })).toEqual({
      engineering: true,
      design: false,
      lean: true,
    });
  });
});

describe('withHandoffContract tiering', () => {
  it('keeps the handoff contract on every tier', () => {
    for (const category of ['scout', 'reviewer', 'executor']) {
      const prompt = withHandoffContract('tarefa', mcpAdapter, { category });
      expect(prompt).toContain('nexus_handoff_submit');
    }
  });

  it('composes only the charters the tier asks for', () => {
    const scout = withHandoffContract('mapear o repositório', mcpAdapter, {
      category: 'scout',
    });
    expect(scout).not.toContain('[ENGINEERING]');
    expect(scout).not.toContain('[DESIGN]');
    expect(scout).not.toContain('[PONYTAIL]');

    const backend = withHandoffContract('corrigir o cron do backend', mcpAdapter, {
      category: 'executor',
    });
    expect(backend).toContain('[ENGINEERING]');
    expect(backend).toContain('[PONYTAIL]');
    expect(backend).not.toContain('[DESIGN]');

    const frontend = withHandoffContract(
      'implementar a página de onboarding',
      mcpAdapter,
      { category: 'executor' },
    );
    expect(frontend).toContain('[ENGINEERING]');
    expect(frontend).toContain('[PONYTAIL]');
    expect(frontend).toContain('[DESIGN]');
  });

  it('still honors the settings toggles as the outer gate', async () => {
    const { getOrchSettings } = await import('../persistence/settings-store');
    vi.mocked(getOrchSettings).mockReturnValueOnce({
      leanCode: false,
      seniorMode: false,
      designPro: false,
    } as ReturnType<typeof getOrchSettings>);
    const prompt = withHandoffContract('implementar a página inicial', mcpAdapter, {
      category: 'executor',
    });
    expect(prompt).not.toContain('[ENGINEERING]');
    expect(prompt).not.toContain('[DESIGN]');
    expect(prompt).not.toContain('[PONYTAIL]');
  });
});
