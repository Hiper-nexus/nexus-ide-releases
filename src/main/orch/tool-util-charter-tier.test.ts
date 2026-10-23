// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

/**
 * Charter tiering — the worker prompt must stay proportional to the task:
 * recon/planning roles get no build charters, reviewers skip the diff ladder,
 * and the design charter only rides along when the task actually touches UI.
 */

vi.mock('./workspace-path', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./workspace-path')>()),
  resolveCwdForScope: vi.fn(),
}));
vi.mock('./pane-registry', () => ({
  getPaneAuthzInfo: vi.fn(),
  listPaneSnapshots: vi.fn(() => []),
  requestMissionPaneClose: vi.fn(async () => true),
  requestPaneClose: vi.fn(async () => true),
  requestPaneSpawn: vi.fn(),
  waitForIdle: vi.fn(),
}));
vi.mock('./pane-authz', () => ({ authorizePaneAccess: vi.fn() }));
vi.mock('../pty/pty-manager', () => ({
  hasAcceptedNativeArgvPrompt: () => false,
  getAgentSessionInfo: vi.fn(() => null),
  getSessionState: vi.fn(() => null),
  orchWriteSession: vi.fn(() => true),
}));
vi.mock('../adapters/adapter-registry', () => ({ getAdapter: vi.fn() }));
vi.mock('./legacy-handoff', () => ({ LEGACY_MARKER: 'marker' }));
vi.mock('./ponytail', () => ({ PONYTAIL_RULES: '[PONYTAIL]' }));
vi.mock('./engineering-charter', () => ({ ENGINEERING_CHARTER: '[ENGINEERING]' }));
vi.mock('./design-charter', () => ({ DESIGN_CHARTER: '[DESIGN]' , UI_KIT_BRIEF_LINE: '[UI-KIT]' }));
vi.mock('../persistence/settings-store', () => ({
  getOrchSettings: vi.fn(() => ({
    leanCode: true,
    seniorMode: true,
    designPro: true,
  })),
}));

import fs from 'node:fs';
import { testProjectScope } from './__tests__/scope-fixture';
import { applyAttestedBusinessModel, createBarbershopRepo } from '../context/business-model/__fixtures__/barbershop';
import {
  charterTierForWorker,
  recallsWorkspaceMemory,
  withHandoffContract,
  withProjectContextBlocks,
} from './tool-util';

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
    expect(frontend).toContain('# Nexus UI composition baseline');
  });

  it('composes the design profile (direction + dials) into the design charter', async () => {
    const { getOrchSettings } = await import('../persistence/settings-store');
    vi.mocked(getOrchSettings).mockReturnValueOnce({
      leanCode: false,
      seniorMode: false,
      designPro: true,
      designDirection: 'brutalist',
      designMotion: 9,
    } as ReturnType<typeof getOrchSettings>);
    const prompt = withHandoffContract(
      'implementar a landing page',
      mcpAdapter,
      { category: 'executor' },
    );
    expect(prompt).toContain('[DESIGN]');
    expect(prompt).toContain('BRUTALIST');
    expect(prompt).toContain('Motion intensity 9/10');
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
    expect(prompt).toContain('# Nexus UI composition baseline');
  });
});

describe('recallsWorkspaceMemory', () => {
  const brief = 'Implemente a validação do formulário de cadastro';

  it('mission workers and orchestrators keep the recall', () => {
    expect(recallsWorkspaceMemory({ prompt: brief, missionId: 'm1', role: 'worker' })).toBe(true);
    expect(recallsWorkspaceMemory({ prompt: brief, missionId: 'm1', role: 'orchestrator' })).toBe(true);
  });

  it('the operator helper (no role, no mission) is born with a brief and gets it too', () => {
    expect(recallsWorkspaceMemory({ prompt: brief })).toBe(true);
  });

  it('no brief, or an internal transient pane, recalls nothing', () => {
    expect(recallsWorkspaceMemory({ missionId: 'm1', role: 'worker' })).toBe(false);
    expect(recallsWorkspaceMemory({ prompt: brief, transient: true })).toBe(false);
  });
});

describe('withProjectContextBlocks (brief de spawn de toda CLI)', () => {
  it('põe <business-model> antes da tarefa; pane transitório e spawn sem brief ficam de fora', async () => {
    const root = createBarbershopRepo();
    try {
      await applyAttestedBusinessModel(root);
      const scope = testProjectScope({ rootRealPath: root });
      const prompt = withProjectContextBlocks({ prompt: 'Mexa no fechamento da comanda', scope })!;
      expect(prompt.startsWith('<business-model fonte=')).toBe(true);
      expect(prompt.endsWith('Mexa no fechamento da comanda')).toBe(true);
      expect(prompt).toContain('close_commanda#1');
      // Worktree isolado: lê o doc da raiz de execução.
      expect(
        withProjectContextBlocks({
          prompt: 'x',
          scope: testProjectScope({ rootRealPath: '/nao/existe' }),
          executionScope: scope,
        }),
      ).toContain('<business-model');
      const transient = withProjectContextBlocks({ prompt: 'x', scope, transient: true })!;
      expect(transient).toContain('# Nexus UI composition baseline');
      expect(transient).not.toContain('<business-model');
      expect(transient.endsWith('\n\nx')).toBe(true);
      expect(withProjectContextBlocks({ scope })).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
