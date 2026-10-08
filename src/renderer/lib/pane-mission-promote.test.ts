/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mission } from '../../shared/orch-types';
import type { PaneSessionState } from '../../shared/types';
import { compileIntentContract } from '../../shared/mission-intent';
import { listPanes } from './split-tree';
import {
  PROMOTE_NEW_MISSION,
  resolvePanePromoteTarget,
} from './pane-mission-promote';

/**
 * resolvePanePromoteTarget é pura — os testes do fluxo COM diálogo ficam nos
 * testes de integração dos componentes; aqui travamos a DECISÃO (o coração do
 * F-527: nunca mais anexar silenciosamente à "missão padrão").
 */

function mission(id: string, status: Mission['status']): { id: string; title: string; status: string } {
  return { id, title: `Missão ${id}`, status };
}

describe('resolvePanePromoteTarget (F-527)', () => {
  it('vínculo direto do pane vence — promove sem perguntar', () => {
    const target = resolvePanePromoteTarget({
      paneMissionId: 'm1',
      destinationMissionId: 'm2',
      boundMissionId: 'm3',
      missions: [mission('m1', 'running'), mission('m2', 'running')],
    });
    expect(target).toEqual({ kind: 'mission', missionId: 'm1' });
  });

  it('destination da missão aberta é o vínculo quando o pane não tem', () => {
    const target = resolvePanePromoteTarget({
      destinationMissionId: 'm2',
      missions: [mission('m1', 'running'), mission('m2', 'running')],
    });
    expect(target).toEqual({ kind: 'mission', missionId: 'm2' });
  });

  it('pane solto com missões ativas → ESCOLHA explícita, nunca a primeira', () => {
    // Este era o bug: find(running|blocked) ?? missions[0] anexava à "padrão".
    const target = resolvePanePromoteTarget({
      missions: [mission('m1', 'running'), mission('m2', 'running')],
    });
    expect(target.kind).toBe('choose');
    if (target.kind === 'choose') {
      expect(target.missions.map((m) => m.id)).toEqual(['m1', 'm2']);
    }
  });

  it('missões encerradas não entram na escolha', () => {
    const target = resolvePanePromoteTarget({
      missions: [mission('m1', 'done'), mission('m2', 'failed'), mission('m3', 'blocked')],
    });
    expect(target.kind).toBe('choose');
    if (target.kind === 'choose') {
      expect(target.missions.map((m) => m.id)).toEqual(['m3']);
    }
  });

  it('sem nenhuma missão ativa → no-mission (abrir nova)', () => {
    const target = resolvePanePromoteTarget({
      missions: [mission('m1', 'done')],
    });
    expect(target).toEqual({ kind: 'no-mission' });
  });

  it('sentinela da opção nova missão não colide com ids reais', () => {
    expect(PROMOTE_NEW_MISSION).toBe('__new_mission__');
  });
});

describe('promotePaneWithMissionChoice (fluxo com diálogo)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('pane solto com 2 missões abre o diálogo e promove a ESCOLHIDA', async () => {
    const { promotePaneWithMissionChoice } = await import('./pane-mission-promote');
    const { useChoiceStore } = await import('../state/choice-store');
    const { useOrchStore } = await import('../state/orch-store');
    const { useLayoutStore } = await import('../state/layout-store');
    const promote = vi
      .spyOn(useLayoutStore.getState(), 'promoteMissionPaneRole')
      .mockImplementation(() => {});
    const bind = vi
      .spyOn(useOrchStore.getState(), 'bindPaneMission')
      .mockImplementation(() => {});
    useOrchStore.setState({
      missions: [mission('m1', 'running'), mission('m2', 'running')] as Mission[],
      paneMissions: {},
    });
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: { orch: { promoteMissionOrchestrator: vi.fn(async () => ({ ok: true })) } },
    });

    const pending = promotePaneWithMissionChoice({ paneId: 'pane-1' });
    // Responde o diálogo como o operador: escolhe a SEGUNDA missão.
    await Promise.resolve();
    const ask = useChoiceStore.getState().pending;
    expect(ask).not.toBeNull();
    expect(ask?.options.map((o) => o.value)).toEqual([
      'm1',
      'm2',
      PROMOTE_NEW_MISSION,
    ]);
    useChoiceStore.getState().decide('m2');
    const result = await pending;
    expect(result).toBe('m2');
    expect(promote).toHaveBeenCalledWith('m2', 'pane-1');
    expect(bind).toHaveBeenCalledWith('pane-1', 'm2');
    promote.mockRestore();
    bind.mockRestore();
  });

  it('sem nenhuma missão: vira coordenador do operador na hora, sem wizard', async () => {
    // Como sempre funcionou antes do F-527 e como o operador cobra: um clique,
    // a coroa aparece, nenhuma tela de criação de missão. A sessão `user` já
    // tem todos os poderes sem missão.
    const { promotePaneWithMissionChoice, PROMOTE_LOCAL_ORCHESTRATOR: local } =
      await import('./pane-mission-promote');
    const { useOrchStore } = await import('../state/orch-store');
    const { useLayoutStore } = await import('../state/layout-store');
    const { useProductNavigationStore } = await import(
      '../state/product-navigation-store'
    );
    const setRole = vi
      .spyOn(useLayoutStore.getState(), 'setPaneRole')
      .mockImplementation(() => {});
    const promote = vi
      .spyOn(useLayoutStore.getState(), 'promoteMissionPaneRole')
      .mockImplementation(() => {});
    const openNew = vi
      .spyOn(useProductNavigationStore.getState(), 'openNewMission')
      .mockImplementation(() => {});
    useOrchStore.setState({ missions: [], paneMissions: {} });

    expect(await promotePaneWithMissionChoice({ paneId: 'pane-3' })).toBe(local);
    expect(setRole).toHaveBeenCalledWith('pane-3', 'orchestrator');
    expect(openNew).not.toHaveBeenCalled();
    expect(promote).not.toHaveBeenCalled();
    setRole.mockRestore();
    promote.mockRestore();
    openNew.mockRestore();
  });

  it('opção "nova missão" abre o caminho expresso sem promover nada', async () => {
    const { promotePaneWithMissionChoice } = await import('./pane-mission-promote');
    const { useChoiceStore } = await import('../state/choice-store');
    const { useOrchStore } = await import('../state/orch-store');
    const { useLayoutStore } = await import('../state/layout-store');
    const { useProductNavigationStore } = await import(
      '../state/product-navigation-store'
    );
    const promote = vi
      .spyOn(useLayoutStore.getState(), 'promoteMissionPaneRole')
      .mockImplementation(() => {});
    const openNew = vi
      .spyOn(useProductNavigationStore.getState(), 'openNewMission')
      .mockImplementation(() => {});
    useOrchStore.setState({
      missions: [mission('m1', 'running')] as Mission[],
      paneMissions: {},
    });

    const pending = promotePaneWithMissionChoice({ paneId: 'pane-2' });
    await Promise.resolve();
    useChoiceStore.getState().decide(PROMOTE_NEW_MISSION);
    expect(await pending).toBeNull();
    expect(openNew).toHaveBeenCalledTimes(1);
    expect(promote).not.toHaveBeenCalled();
    promote.mockRestore();
    openNew.mockRestore();
  });
});

// ── F-561: nunca existe orquestrador sem missão que o reconheça ──────────────

describe('resolvePanePromoteTarget — autoridade do vínculo (F-561)', () => {
  it('lê o vínculo GRAVADO no pane do layout, não só o observado', () => {
    const target = resolvePanePromoteTarget({
      paneMissionId: 'm-layout',
      missions: [mission('m-layout', 'running')],
    });
    expect(target).toEqual({ kind: 'mission', missionId: 'm-layout' });
  });

  it('missão encerrada no destino NÃO promove — ela não recebe orquestrador', () => {
    // Antes: destination vencia sem olhar o status, então abrir uma missão
    // `done` e clicar "Tornar orquestrador" carimbava o pane numa missão morta.
    const target = resolvePanePromoteTarget({
      destinationMissionId: 'm-done',
      missions: [mission('m-done', 'done'), mission('m-viva', 'running')],
    });
    expect(target.kind).toBe('choose');
    if (target.kind === 'choose') {
      expect(target.missions.map((m) => m.id)).toEqual(['m-viva']);
    }
  });

  it('vínculo que aponta para missão inexistente cai na escolha, não promove às cegas', () => {
    const target = resolvePanePromoteTarget({
      paneMissionId: 'm-fantasma',
      missions: [mission('m-viva', 'running')],
    });
    expect(target.kind).toBe('choose');
  });

  it('vínculo fantasma e nenhuma missão viva → no-mission', () => {
    const target = resolvePanePromoteTarget({
      paneMissionId: 'm-fantasma',
      missions: [],
    });
    expect(target).toEqual({ kind: 'no-mission' });
  });
});

describe('promotePaneToMissionOrchestrator — recusa do main é final (F-561)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function setupPromote(promoteResult: unknown) {
    const { promotePaneToMissionOrchestrator } = await import(
      './pane-mission-promote'
    );
    const { useLayoutStore } = await import('../state/layout-store');
    const { useOrchStore } = await import('../state/orch-store');
    const promoteRole = vi
      .spyOn(useLayoutStore.getState(), 'promoteMissionPaneRole')
      .mockImplementation(() => {});
    const bind = vi
      .spyOn(useOrchStore.getState(), 'bindPaneMission')
      .mockImplementation(() => {});
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        orch: {
          promoteMissionOrchestrator: vi.fn(async () => promoteResult),
        },
      },
    });
    return { promotePaneToMissionOrchestrator, promoteRole, bind };
  }

  it('main aceita → o layout promove e o vínculo é gravado', async () => {
    const { promotePaneToMissionOrchestrator, promoteRole, bind } =
      await setupPromote({ ok: true });

    await expect(
      promotePaneToMissionOrchestrator('m1', 'pane-1'),
    ).resolves.toBe(true);
    expect(promoteRole).toHaveBeenCalledWith('m1', 'pane-1');
    expect(bind).toHaveBeenCalledWith('pane-1', 'm1');
  });

  it('main RECUSA → nada é promovido; o pane não vira orquestrador órfão', async () => {
    const { promotePaneToMissionOrchestrator, promoteRole, bind } =
      await setupPromote({ ok: false, error: 'mission_unavailable' });

    await expect(
      promotePaneToMissionOrchestrator('m1', 'pane-1'),
    ).resolves.toBe(false);
    expect(promoteRole).not.toHaveBeenCalled();
    expect(bind).not.toHaveBeenCalled();
  });

  it('IPC ausente (janela sem bridge) também não promove às cegas', async () => {
    const { promotePaneToMissionOrchestrator } = await import(
      './pane-mission-promote'
    );
    const { useLayoutStore } = await import('../state/layout-store');
    const promoteRole = vi
      .spyOn(useLayoutStore.getState(), 'promoteMissionPaneRole')
      .mockImplementation(() => {});
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: { orch: {} },
    });

    await expect(
      promotePaneToMissionOrchestrator('m1', 'pane-1'),
    ).resolves.toBe(false);
    expect(promoteRole).not.toHaveBeenCalled();
  });
});

// ── F-561: o painel marcado lidera a próxima missão (adoção) ─────────────────

describe('marcação de adoção (F-561)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('a opção "nova missão" do diálogo também marca o painel', async () => {
    const { promotePaneWithMissionChoice, PROMOTE_NEW_MISSION: sentinel } =
      await import('./pane-mission-promote');
    const { useChoiceStore } = await import('../state/choice-store');
    const { useOrchStore } = await import('../state/orch-store');
    const { useProductNavigationStore } = await import(
      '../state/product-navigation-store'
    );
    const { usePendingOrchestratorAdoptionStore } = await import(
      '../state/pending-orchestrator-adoption-store'
    );
    vi.spyOn(
      useProductNavigationStore.getState(),
      'openNewMission',
    ).mockImplementation(() => {});
    useOrchStore.setState({
      missions: [mission('m1', 'running')] as Mission[],
      paneMissions: {},
    });
    usePendingOrchestratorAdoptionStore.getState().clear();

    const pending = promotePaneWithMissionChoice({
      paneId: 'pane-10',
      paneTitle: 'Claude',
    });
    await Promise.resolve();
    useChoiceStore.getState().decide(sentinel);
    expect(await pending).toBeNull();

    expect(
      usePendingOrchestratorAdoptionStore.getState().pending?.paneId,
    ).toBe('pane-10');
  });

  it('take() consome a marca — um start, uma adoção', async () => {
    const { usePendingOrchestratorAdoptionStore } = await import(
      '../state/pending-orchestrator-adoption-store'
    );
    usePendingOrchestratorAdoptionStore
      .getState()
      .request({ paneId: 'pane-1', paneTitle: null });

    expect(usePendingOrchestratorAdoptionStore.getState().take()?.paneId).toBe(
      'pane-1',
    );
    expect(usePendingOrchestratorAdoptionStore.getState().take()).toBeNull();
  });
});

// ── Orquestrador por aba: missão leve da aba (0.76.110) ─────────────────────

describe('promotePaneWithMissionChoice — missão leve por aba', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function setupTabs(bridge: Record<string, unknown>) {
    const mod = await import('./pane-mission-promote');
    const { useOrchStore } = await import('../state/orch-store');
    const { useLayoutStore } = await import('../state/layout-store');
    const { useChoiceStore } = await import('../state/choice-store');
    const { buildGridTree } = await import('./split-tree');
    useLayoutStore.setState({
      root: buildGridTree([
        // Aba A: orquestrador da missão mA (anfitrião) + um shell.
        {
          id: 'a1', kind: 'cli-agent', title: 'Claude A', adapterId: 'claude',
          spaceId: 'space-a', spaceTitle: 'Checkout', missionId: 'mA',
          missionHost: true, role: 'orchestrator',
        },
        { id: 'a2', kind: 'shell', title: 'shell', spaceId: 'space-a', spaceTitle: 'Checkout' },
        // Aba B: dois panes soltos, sem missão.
        { id: 'b1', kind: 'cli-agent', title: 'Codex B', adapterId: 'codex', spaceId: 'space-b', spaceTitle: 'Login' },
        { id: 'b2', kind: 'cli-agent', title: 'GLM B', adapterId: 'glm', spaceId: 'space-b', spaceTitle: 'Login' },
      ]),
    });
    useOrchStore.setState({
      // F-373: a aba só reusa a missão quando ela tem autoridade de despacho
      // viva — a fixture precisa do contrato aprovado da revisão corrente.
      missions: [
        {
          id: 'mA', title: 'Missão mA', status: 'running',
          intentState: 'dispatched', intentVersion: 1,
          intentContract: {
            ...compileIntentContract({
              goal: 'Entregar o checkout',
              source: 'typed',
              intentVersion: 1,
              executionMode: 'autopilot',
              contextPolicy: 'on-demand',
            }),
            approvedAt: 1,
          },
        },
      ] as Mission[],
      paneMissions: { a1: 'mA' },
    });
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: { orch: bridge },
    });
    return { ...mod, useLayoutStore, useChoiceStore };
  }

  it('promover na aba B cria a missão da B e NÃO mexe no orquestrador da A', async () => {
    const createPaneMission = vi.fn(async () => ({ ok: true, mission: { id: 'mB' } }));
    const promoteMissionOrchestrator = vi.fn(async () => ({ ok: true }));
    const { promotePaneWithMissionChoice, useLayoutStore, useChoiceStore } =
      await setupTabs({ createPaneMission, promoteMissionOrchestrator });

    expect(await promotePaneWithMissionChoice({ paneId: 'b1' })).toBe('mB');
    // Sem diálogo com a missão da outra aba.
    expect(useChoiceStore.getState().pending).toBeNull();
    expect(createPaneMission).toHaveBeenCalledWith({ paneId: 'b1', title: 'Missão · Login', tabKey: 'space:space-b' });
    expect(promoteMissionOrchestrator).not.toHaveBeenCalled();

    const panes = new Map(listPanes(useLayoutStore.getState().root).map((p) => [p.id, p]));
    expect(panes.get('b1')).toMatchObject({ role: 'orchestrator', missionId: 'mB', missionHost: true });
    expect(panes.get('a1')).toMatchObject({ role: 'orchestrator', missionId: 'mA' });
    // A missão nova mora na aba B: o pane continua no espaço dela.
    expect(panes.get('b1')?.spaceId).toBe('space-b');
    expect(panes.get('b2')?.role).toBeUndefined();
  });

  it('promover outro pane numa aba que já tem missão reusa a missão dela', async () => {
    const createPaneMission = vi.fn();
    const promoteMissionOrchestrator = vi.fn(async () => ({ ok: true }));
    const { promotePaneWithMissionChoice } = await setupTabs({
      createPaneMission,
      promoteMissionOrchestrator,
    });

    expect(await promotePaneWithMissionChoice({ paneId: 'a2' })).toBe('mA');
    expect(promoteMissionOrchestrator).toHaveBeenCalledWith({ missionId: 'mA', paneId: 'a2' });
    expect(createPaneMission).not.toHaveBeenCalled();
  });

  it('Hardened: o main recusa a missão leve e o fluxo de escolha explícita continua', async () => {
    const createPaneMission = vi.fn(async () => ({ ok: false, error: 'hardened' }));
    const { promotePaneWithMissionChoice, useChoiceStore } = await setupTabs({
      createPaneMission,
      promoteMissionOrchestrator: vi.fn(async () => ({ ok: true })),
    });

    const pending = promotePaneWithMissionChoice({ paneId: 'b1' });
    await vi.waitFor(() => expect(useChoiceStore.getState().pending).not.toBeNull());
    useChoiceStore.getState().decide(null);
    expect(await pending).toBeNull();
  });

  it('duas promoções simultâneas na mesma aba pedem UMA missão; a segunda a reusa', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const createPaneMission = vi.fn(async () => {
      await gate;
      return { ok: true, mission: { id: 'mB' } };
    });
    const promoteMissionOrchestrator = vi.fn(async () => ({ ok: true }));
    const { promotePaneWithMissionChoice } = await setupTabs({ createPaneMission, promoteMissionOrchestrator });

    const first = promotePaneWithMissionChoice({ paneId: 'b1' });
    const second = promotePaneWithMissionChoice({ paneId: 'b2' });
    release();

    expect(await Promise.all([first, second])).toEqual(['mB', 'mB']);
    expect(createPaneMission).toHaveBeenCalledTimes(1);
    expect(promoteMissionOrchestrator).toHaveBeenCalledWith({ missionId: 'mB', paneId: 'b2' });
  });

  it('pane sem sessão de IA viva: toast próprio, sem diálogo e sem coroa local', async () => {
    const createPaneMission = vi.fn(async () => ({ ok: false, error: 'pane_unavailable' }));
    const { promotePaneWithMissionChoice, useChoiceStore, useLayoutStore } = await setupTabs({
      createPaneMission,
      promoteMissionOrchestrator: vi.fn(),
    });
    const { useToastStore } = await import('../state/toast-store');

    expect(await promotePaneWithMissionChoice({ paneId: 'b1' })).toBeNull();
    expect(useChoiceStore.getState().pending).toBeNull();
    expect(listPanes(useLayoutStore.getState().root).find((p) => p.id === 'b1')?.role).toBeUndefined();
    expect(JSON.stringify(useToastStore.getState())).toContain('O painel não tem sessão de IA viva');
  });

  it('página da missão da aba A aberta não prende o pane da aba B à missão A', async () => {
    const createPaneMission = vi.fn(async () => ({ ok: true, mission: { id: 'mB' } }));
    const promoteMissionOrchestrator = vi.fn(async () => ({ ok: true }));
    const { promotePaneWithMissionChoice } = await setupTabs({ createPaneMission, promoteMissionOrchestrator });
    const { useProductNavigationStore } = await import('../state/product-navigation-store');
    useProductNavigationStore.setState({ destination: { kind: 'mission', missionId: 'mA' } } as never);

    expect(await promotePaneWithMissionChoice({ paneId: 'b1' })).toBe('mB');
    expect(promoteMissionOrchestrator).not.toHaveBeenCalled();
  });
});

describe('startTabMissionFor — "Criar missão desta aba"', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function setup(bridge: Record<string, unknown>) {
    const mod = await import('./pane-mission-promote');
    const { useOrchStore } = await import('../state/orch-store');
    const { useLayoutStore } = await import('../state/layout-store');
    const { buildGridTree } = await import('./split-tree');
    useLayoutStore.setState({
      root: buildGridTree([
        { id: 'b1', kind: 'cli-agent', title: 'Codex B', adapterId: 'codex', spaceId: 'space-b', spaceTitle: 'Login' },
      ]),
    });
    useOrchStore.setState({ missions: [], paneMissions: {} });
    Object.defineProperty(window, 'nexus', { configurable: true, value: { orch: bridge } });
    return { ...mod, useLayoutStore };
  }

  it('Hardened abre o fluxo explícito de criação e não anuncia missão', async () => {
    const { startTabMissionFor, useLayoutStore } = await setup({
      createPaneMission: vi.fn(async () => ({ ok: false, error: 'hardened' })),
    });
    const { usePendingOrchestratorAdoptionStore } = await import('../state/pending-orchestrator-adoption-store');

    expect(await startTabMissionFor({ paneId: 'b1', paneTitle: 'Codex B' })).toBeNull();
    expect(usePendingOrchestratorAdoptionStore.getState().take()).toMatchObject({ paneId: 'b1' });
    // Nada de coroa local fingindo missão.
    expect(listPanes(useLayoutStore.getState().root)[0]?.role).toBeUndefined();
  });

  it('só devolve id de missão real', async () => {
    const { startTabMissionFor } = await setup({
      createPaneMission: vi.fn(async () => ({ ok: true, mission: { id: 'mB' } })),
    });
    expect(await startTabMissionFor({ paneId: 'b1' })).toBe('mB');
  });
});

// ── F-373: a missão dormindo/parada da aba não recebe a coroa ────────────────

describe('promover numa aba cuja missão está parada (F-373)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function setupParkedTab(
    bridge: Record<string, unknown>,
    marker: string,
  ) {
    const mod = await import('./pane-mission-promote');
    const { useOrchStore } = await import('../state/orch-store');
    const { useLayoutStore } = await import('../state/layout-store');
    const { buildGridTree } = await import('./split-tree');
    useLayoutStore.setState({
      root: buildGridTree([
        // O Maestro morto da missão parada ainda ocupa a aba.
        {
          id: 'a1', kind: 'cli-agent', title: 'Claude A', adapterId: 'claude',
          spaceId: 'space-a', spaceTitle: 'Checkout', missionId: 'mA',
          missionHost: true, role: 'orchestrator',
        },
        { id: 'a2', kind: 'cli-agent', title: 'Codex A', adapterId: 'codex', spaceId: 'space-a', spaceTitle: 'Checkout' },
      ]),
    });
    useOrchStore.setState({
      missions: [
        {
          id: 'mA', title: 'Missão · Checkout', status: 'blocked',
          intentState: 'blocked_user', description: `Trabalho anterior. ${marker}`,
          milestones: [], learnings: '', createdAt: 1, updatedAt: 2,
        },
      ] as Mission[],
      paneMissions: { a1: 'mA' },
    });
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: { orch: bridge },
    });
    return { ...mod, useLayoutStore };
  }

  it('promover na aba dormindo (leftover-parked) cria missão NOVA — a parada não recebe coroa', async () => {
    const createPaneMission = vi.fn(async () => ({ ok: true, mission: { id: 'mB' } }));
    const promoteMissionOrchestrator = vi.fn(async () => ({ ok: true }));
    const { promotePaneWithMissionChoice } = await setupParkedTab(
      { createPaneMission, promoteMissionOrchestrator },
      '<!-- nexus:leftover-parked -->',
    );

    expect(await promotePaneWithMissionChoice({ paneId: 'a2' })).toBe('mB');
    expect(createPaneMission).toHaveBeenCalledWith({
      paneId: 'a2', title: 'Missão · Checkout 2', tabKey: 'space:space-a',
    });
    expect(promoteMissionOrchestrator).not.toHaveBeenCalled();
  });

  it('o mesmo para a missão parada pelo operador (runtime fechado)', async () => {
    const createPaneMission = vi.fn(async () => ({ ok: true, mission: { id: 'mB' } }));
    const promoteMissionOrchestrator = vi.fn(async () => ({ ok: true }));
    const { promotePaneWithMissionChoice } = await setupParkedTab(
      { createPaneMission, promoteMissionOrchestrator },
      '<!-- nexus:runtime-closed -->',
    );

    expect(await promotePaneWithMissionChoice({ paneId: 'a2' })).toBe('mB');
    expect(createPaneMission).toHaveBeenCalledWith({
      paneId: 'a2', title: 'Missão · Checkout 2', tabKey: 'space:space-a',
    });
    expect(promoteMissionOrchestrator).not.toHaveBeenCalled();
  });

  it('«Criar missão desta aba» na aba dormindo também cria missão nova', async () => {
    const createPaneMission = vi.fn(async () => ({ ok: true, mission: { id: 'mB' } }));
    const promoteMissionOrchestrator = vi.fn();
    const { startTabMissionFor } = await setupParkedTab(
      { createPaneMission, promoteMissionOrchestrator },
      '<!-- nexus:leftover-parked -->',
    );

    expect(await startTabMissionFor({ paneId: 'a2' })).toBe('mB');
    expect(createPaneMission).toHaveBeenCalledWith({
      paneId: 'a2', title: 'Missão · Checkout 2', tabKey: 'space:space-a',
    });
    expect(promoteMissionOrchestrator).not.toHaveBeenCalled();
  });

  it('mission_unavailable: a cópia aponta Retomar, não culpa o painel', async () => {
    const { toastPromoteRefused } = await import('./pane-mission-promote');
    const { useToastStore } = await import('../state/toast-store');
    useToastStore.setState({ toasts: [] });

    toastPromoteRefused('mission_unavailable');

    expect(JSON.stringify(useToastStore.getState())).toContain(
      'A missão deste painel não está rodando agora. Retome-a pelo Quadro ou ' +
        'use um painel livre para começar outra missão.',
    );
  });
});

describe('pickTabMissionLeader — um pane morto nunca lidera de novo (F-373)', () => {
  const states = (entries: Record<string, PaneSessionState>) =>
    new Map<string, PaneSessionState>(Object.entries(entries));

  it('orquestrador vivo do escopo lidera', async () => {
    const { pickTabMissionLeader } = await import('./pane-mission-promote');
    const agents = [{ id: 'a1' }, { id: 'a2' }];
    expect(
      pickTabMissionLeader(agents, {
        orchestratorPaneId: 'a1',
        focusedPaneId: 'a2',
        paneStates: states({ a1: 'idle', a2: 'busy' }),
      })?.id,
    ).toBe('a1');
  });

  it('orquestrador morto é pulado — o pane focado vivo lidera', async () => {
    const { pickTabMissionLeader } = await import('./pane-mission-promote');
    const agents = [{ id: 'a1' }, { id: 'a2' }];
    expect(
      pickTabMissionLeader(agents, {
        orchestratorPaneId: 'a1',
        focusedPaneId: 'a2',
        paneStates: states({ a1: 'exited', a2: 'idle' }),
      })?.id,
    ).toBe('a2');
  });

  it('sem foco nem orquestrador vivo, o primeiro vivo da aba lidera', async () => {
    const { pickTabMissionLeader } = await import('./pane-mission-promote');
    const agents = [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }];
    expect(
      pickTabMissionLeader(agents, {
        orchestratorPaneId: 'a1',
        paneStates: states({ a1: 'exited', a2: 'hibernated', a3: 'spawning' }),
      })?.id,
    ).toBe('a3');
  });

  it('F-970: orquestrador fora do ar e revisor focado — o worker nunca é escolhido; o pane do operador lidera', async () => {
    const { pickTabMissionLeader } = await import('./pane-mission-promote');
    const agents = [
      { id: 'operator' },
      { id: 'orchestrator', role: 'orchestrator' as const },
      { id: 'reviewer', role: 'worker' as const },
    ];
    expect(
      pickTabMissionLeader(agents, {
        orchestratorPaneId: 'orchestrator',
        focusedPaneId: 'reviewer',
        paneStates: states({ operator: 'idle', orchestrator: 'exited', reviewer: 'busy' }),
      })?.id,
    ).toBe('operator');
  });

  it('F-970: só workers vivos na aba → null (a missão fica sem líder vivo e o operador é avisado)', async () => {
    const { pickTabMissionLeader } = await import('./pane-mission-promote');
    expect(
      pickTabMissionLeader(
        [
          { id: 'orchestrator', role: 'orchestrator' as const },
          { id: 'reviewer', role: 'worker' as const },
        ],
        {
          orchestratorPaneId: 'orchestrator',
          focusedPaneId: 'reviewer',
          paneStates: states({ orchestrator: 'exited', reviewer: 'idle' }),
        },
      ),
    ).toBeNull();
  });

  it('nenhum agente vivo → null (quem chama pede IA viva na aba)', async () => {
    const { pickTabMissionLeader } = await import('./pane-mission-promote');
    expect(
      pickTabMissionLeader([{ id: 'a1' }], {
        orchestratorPaneId: 'a1',
        paneStates: states({ a1: 'exited' }),
      }),
    ).toBeNull();
  });
});

describe('isLivePaneSessionState (F-373)', () => {
  it.each(['spawning', 'busy', 'idle'] as const)('%s conta como viva', async (state) => {
    const { isLivePaneSessionState } = await import('./pane-mission-promote');
    expect(isLivePaneSessionState(state)).toBe(true);
  });

  it.each(['exited', 'hibernated', undefined] as const)('%s não é viva', async (state) => {
    const { isLivePaneSessionState } = await import('./pane-mission-promote');
    expect(isLivePaneSessionState(state)).toBe(false);
  });
});

// ── F-374: a coroa de uma missão com orquestrador vivo não troca em silêncio ──

describe('aba com orquestrador VIVO — missão própria ou a coroa (F-374)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function setupLiveLeaderTab(bridge: Record<string, unknown>) {
    const mod = await import('./pane-mission-promote');
    const { useOrchStore } = await import('../state/orch-store');
    const { useLayoutStore } = await import('../state/layout-store');
    const { useChoiceStore } = await import('../state/choice-store');
    const { useSessionStateStore } = await import('../state/session-state-store');
    const { buildGridTree } = await import('./split-tree');
    useLayoutStore.setState({
      root: buildGridTree([
        {
          id: 'a1', kind: 'cli-agent', title: 'Claude A', adapterId: 'claude',
          spaceId: 'space-a', spaceTitle: 'Checkout', missionId: 'mA',
          missionHost: true, role: 'orchestrator',
        },
        { id: 'a3', kind: 'cli-agent', title: 'Codex A', adapterId: 'codex', spaceId: 'space-a', spaceTitle: 'Checkout' },
      ]),
    });
    useOrchStore.setState({
      missions: [
        {
          id: 'mA', title: 'Missão · Checkout', status: 'running',
          intentState: 'dispatched', intentVersion: 1,
          intentContract: {
            ...compileIntentContract({
              goal: 'Entregar o checkout',
              source: 'typed',
              intentVersion: 1,
              executionMode: 'autopilot',
              contextPolicy: 'on-demand',
            }),
            approvedAt: 1,
          },
          milestones: [], learnings: '', createdAt: 1, updatedAt: 2, description: 'x',
        },
      ] as Mission[],
      paneMissions: { a1: 'mA' },
    });
    useSessionStateStore.setState({
      paneStates: new Map<string, PaneSessionState>([
        ['a1', 'idle'],
        ['a3', 'idle'],
      ]),
    });
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: { orch: bridge },
    });
    return { ...mod, useLayoutStore, useChoiceStore, useSessionStateStore };
  }

  it('promover outro pane abre a escolha; cancelar não toca em nada', async () => {
    const createPaneMission = vi.fn();
    const promoteMissionOrchestrator = vi.fn(async () => ({ ok: true }));
    const {
      promotePaneWithMissionChoice, useChoiceStore,
      PROMOTE_OWN_MISSION, PROMOTE_TAKE_OVER,
    } = await setupLiveLeaderTab({ createPaneMission, promoteMissionOrchestrator });

    const pending = promotePaneWithMissionChoice({ paneId: 'a3' });
    await vi.waitFor(() =>
      expect(useChoiceStore.getState().pending).not.toBeNull(),
    );
    const ask = useChoiceStore.getState().pending!;
    expect(ask.title).toBe('Esta aba já tem uma missão rodando');
    expect(ask.body).toContain('Missão · Checkout');
    expect(ask.body).toContain('Claude A');
    expect(ask.options.map((o) => o.value)).toEqual([
      PROMOTE_OWN_MISSION,
      PROMOTE_TAKE_OVER,
    ]);

    useChoiceStore.getState().decide(null);
    expect(await pending).toBeNull();
    expect(createPaneMission).not.toHaveBeenCalled();
    expect(promoteMissionOrchestrator).not.toHaveBeenCalled();
  });

  it('«Nova missão deste painel» cria missão própria (ownGroup) sem tomar a coroa da outra', async () => {
    const createPaneMission = vi.fn(async () => ({ ok: true, mission: { id: 'mB' } }));
    const promoteMissionOrchestrator = vi.fn(async () => ({ ok: true }));
    const {
      promotePaneWithMissionChoice, useChoiceStore, useLayoutStore,
      PROMOTE_OWN_MISSION,
    } = await setupLiveLeaderTab({ createPaneMission, promoteMissionOrchestrator });

    const pending = promotePaneWithMissionChoice({ paneId: 'a3' });
    await vi.waitFor(() =>
      expect(useChoiceStore.getState().pending).not.toBeNull(),
    );
    useChoiceStore.getState().decide(PROMOTE_OWN_MISSION);
    expect(await pending).toBe('mB');

    expect(createPaneMission).toHaveBeenCalledWith({
      paneId: 'a3',
      title: 'Missão · Codex A',
      tabKey: 'space:space-a',
      ownGroup: true,
    });
    expect(promoteMissionOrchestrator).not.toHaveBeenCalled();
    const panes = new Map(
      listPanes(useLayoutStore.getState().root).map((p) => [p.id, p]),
    );
    expect(panes.get('a3')).toMatchObject({ role: 'orchestrator', missionId: 'mB' });
    expect(panes.get('a1')).toMatchObject({ role: 'orchestrator', missionId: 'mA' });
  });

  it('«Assumir a liderança» promove o pane na missão da aba (a coroa troca)', async () => {
    const createPaneMission = vi.fn();
    const promoteMissionOrchestrator = vi.fn(async () => ({ ok: true }));
    const {
      promotePaneWithMissionChoice, useChoiceStore, PROMOTE_TAKE_OVER,
    } = await setupLiveLeaderTab({ createPaneMission, promoteMissionOrchestrator });

    const pending = promotePaneWithMissionChoice({ paneId: 'a3' });
    await vi.waitFor(() =>
      expect(useChoiceStore.getState().pending).not.toBeNull(),
    );
    useChoiceStore.getState().decide(PROMOTE_TAKE_OVER);
    expect(await pending).toBe('mA');

    expect(promoteMissionOrchestrator).toHaveBeenCalledWith({ missionId: 'mA', paneId: 'a3' });
    expect(createPaneMission).not.toHaveBeenCalled();
  });

  it('orquestrador da aba morto: promove direto, sem diálogo', async () => {
    const createPaneMission = vi.fn();
    const promoteMissionOrchestrator = vi.fn(async () => ({ ok: true }));
    const {
      promotePaneWithMissionChoice, useChoiceStore, useSessionStateStore,
    } = await setupLiveLeaderTab({ createPaneMission, promoteMissionOrchestrator });
    useSessionStateStore.setState({
      paneStates: new Map<string, PaneSessionState>([
        ['a1', 'exited'],
        ['a3', 'idle'],
      ]),
    });

    expect(await promotePaneWithMissionChoice({ paneId: 'a3' })).toBe('mA');
    expect(useChoiceStore.getState().pending).toBeNull();
    expect(promoteMissionOrchestrator).toHaveBeenCalledWith({ missionId: 'mA', paneId: 'a3' });
    expect(createPaneMission).not.toHaveBeenCalled();
  });
});

// ── Revisão: a missão da aba é a do VÍNCULO, e o título nunca se repete ──────

describe('duas missões vivas na mesma aba — a da aba é a do vínculo gravado', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function setupTwoMissionsTab(bridge: Record<string, unknown>) {
    const mod = await import('./pane-mission-promote');
    const { useOrchStore } = await import('../state/orch-store');
    const { useLayoutStore } = await import('../state/layout-store');
    const { useChoiceStore } = await import('../state/choice-store');
    const { useSessionStateStore } = await import('../state/session-state-store');
    const { buildGridTree } = await import('./split-tree');
    useLayoutStore.setState({
      root: buildGridTree([
        // b1 primeiro na árvore: a hospedagem lista a missão dele antes da da
        // aba. missionHost porque foi ele que a criou ("Nova missão deste
        // painel") — a missão do grupo mora na mesma aba.
        {
          id: 'b1', kind: 'cli-agent', title: 'GLM B', adapterId: 'glm',
          spaceId: 'space-a', spaceTitle: 'Checkout', missionId: 'mB',
          missionHost: true, role: 'orchestrator',
        },
        {
          id: 'a1', kind: 'cli-agent', title: 'Claude A', adapterId: 'claude',
          spaceId: 'space-a', spaceTitle: 'Checkout', missionId: 'mA',
          missionHost: true, role: 'orchestrator',
        },
        { id: 'a3', kind: 'cli-agent', title: 'Codex A', adapterId: 'codex', spaceId: 'space-a', spaceTitle: 'Checkout' },
      ]),
    });
    useOrchStore.setState({
      // O Main lista a mais nova primeiro: mB é a missão do GRUPO do b1
      // (nasceu via "Nova missão deste painel", sem tabKey no vínculo).
      missions: [
        {
          id: 'mB', title: 'Missão · GLM B', status: 'running',
          intentState: 'dispatched', intentVersion: 1,
          intentContract: {
            ...compileIntentContract({
              goal: 'Escrever o rodapé',
              source: 'typed',
              intentVersion: 1,
              executionMode: 'autopilot',
              contextPolicy: 'on-demand',
            }),
            approvedAt: 1,
          },
          milestones: [], learnings: '', createdAt: 1, updatedAt: 2, description: 'x',
        },
        {
          id: 'mA', title: 'Missão · Checkout', status: 'running',
          intentState: 'dispatched', intentVersion: 1,
          intentContract: {
            ...compileIntentContract({
              goal: 'Entregar o checkout',
              source: 'typed',
              intentVersion: 1,
              executionMode: 'autopilot',
              contextPolicy: 'on-demand',
            }),
            approvedAt: 1,
            workspaceBinding: { version: 1, tabKey: 'space:space-a' },
          },
          milestones: [], learnings: '', createdAt: 1, updatedAt: 2, description: 'x',
        },
      ] as Mission[],
      paneMissions: { a1: 'mA', b1: 'mB' },
    });
    useSessionStateStore.setState({
      paneStates: new Map<string, PaneSessionState>([
        ['a1', 'idle'],
        ['b1', 'idle'],
        ['a3', 'idle'],
      ]),
    });
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: { orch: bridge },
    });
    return { ...mod, useLayoutStore, useChoiceStore };
  }

  it('o diálogo nomeia a missão da aba (mA + “Claude A”), não a mais nova', async () => {
    const promoteMissionOrchestrator = vi.fn(async () => ({ ok: true }));
    const {
      promotePaneWithMissionChoice, useChoiceStore, PROMOTE_TAKE_OVER,
    } = await setupTwoMissionsTab({
      createPaneMission: vi.fn(),
      promoteMissionOrchestrator,
    });

    const pending = promotePaneWithMissionChoice({ paneId: 'a3' });
    await vi.waitFor(() =>
      expect(useChoiceStore.getState().pending).not.toBeNull(),
    );
    const ask = useChoiceStore.getState().pending!;
    expect(ask.body).toContain('Missão · Checkout');
    expect(ask.body).toContain('Claude A');
    expect(ask.body).not.toContain('Missão · GLM B');

    useChoiceStore.getState().decide(PROMOTE_TAKE_OVER);
    expect(await pending).toBe('mA');
    expect(promoteMissionOrchestrator).toHaveBeenCalledWith({ missionId: 'mA', paneId: 'a3' });
  });
});

describe('título de missão criada pelo renderer nunca se repete', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('«Nova missão deste painel» com título já usado ganha sufixo', async () => {
    const createPaneMission = vi.fn(async () => ({ ok: true, mission: { id: 'mC' } }));
    const mod = await import('./pane-mission-promote');
    const { useOrchStore } = await import('../state/orch-store');
    const { useLayoutStore } = await import('../state/layout-store');
    const { useChoiceStore } = await import('../state/choice-store');
    const { useSessionStateStore } = await import('../state/session-state-store');
    const { buildGridTree } = await import('./split-tree');
    useLayoutStore.setState({
      root: buildGridTree([
        {
          id: 'a1', kind: 'cli-agent', title: 'Claude A', adapterId: 'claude',
          spaceId: 'space-a', spaceTitle: 'Checkout', missionId: 'mA',
          missionHost: true, role: 'orchestrator',
        },
        { id: 'a3', kind: 'cli-agent', title: 'Codex A', adapterId: 'codex', spaceId: 'space-a', spaceTitle: 'Checkout' },
      ]),
    });
    useOrchStore.setState({
      missions: [
        {
          id: 'mA', title: 'Missão · Checkout', status: 'running',
          intentState: 'dispatched', intentVersion: 1,
          intentContract: {
            ...compileIntentContract({
              goal: 'Entregar o checkout',
              source: 'typed',
              intentVersion: 1,
              executionMode: 'autopilot',
              contextPolicy: 'on-demand',
            }),
            approvedAt: 1,
          },
          milestones: [], learnings: '', createdAt: 1, updatedAt: 2, description: 'x',
        },
        // A missão do grupo de uma promoção anterior já usa o nome do pane.
        {
          id: 'mX', title: 'Missão · Codex A', status: 'running',
          intentState: 'dispatched', intentVersion: 1,
          intentContract: {
            ...compileIntentContract({
              goal: 'Outra entrega',
              source: 'typed',
              intentVersion: 1,
              executionMode: 'autopilot',
              contextPolicy: 'on-demand',
            }),
            approvedAt: 1,
          },
          milestones: [], learnings: '', createdAt: 1, updatedAt: 2, description: 'x',
        },
      ] as Mission[],
      paneMissions: { a1: 'mA' },
    });
    useSessionStateStore.setState({
      paneStates: new Map<string, PaneSessionState>([
        ['a1', 'idle'],
        ['a3', 'idle'],
      ]),
    });
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: { orch: { createPaneMission, promoteMissionOrchestrator: vi.fn(async () => ({ ok: true })) } },
    });

    const pending = mod.promotePaneWithMissionChoice({ paneId: 'a3' });
    await vi.waitFor(() =>
      expect(useChoiceStore.getState().pending).not.toBeNull(),
    );
    useChoiceStore.getState().decide(mod.PROMOTE_OWN_MISSION);
    expect(await pending).toBe('mC');
    expect(createPaneMission).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Missão · Codex A 2', ownGroup: true }),
    );
  });

  it('o sufixo nunca deixa o título passar de 120 caracteres', async () => {
    const base120 = `Missão · ${'P'.repeat(200)}`.slice(0, 120);
    const createPaneMission = vi.fn(
      async (_input: { paneId: string; title: string; tabKey?: string; ownGroup?: boolean }) =>
        ({ ok: true as const, mission: { id: 'mC' } }),
    );
    const mod = await import('./pane-mission-promote');
    const { useOrchStore } = await import('../state/orch-store');
    const { useLayoutStore } = await import('../state/layout-store');
    const { useChoiceStore } = await import('../state/choice-store');
    const { useSessionStateStore } = await import('../state/session-state-store');
    const { buildGridTree } = await import('./split-tree');
    useLayoutStore.setState({
      root: buildGridTree([
        {
          id: 'a1', kind: 'cli-agent', title: 'Claude A', adapterId: 'claude',
          spaceId: 'space-a', spaceTitle: 'Checkout', missionId: 'mA',
          missionHost: true, role: 'orchestrator',
        },
        { id: 'a3', kind: 'cli-agent', title: 'P'.repeat(200), adapterId: 'codex', spaceId: 'space-a', spaceTitle: 'Checkout' },
      ]),
    });
    useOrchStore.setState({
      missions: [
        {
          id: 'mA', title: 'Missão · Checkout', status: 'running',
          intentState: 'dispatched', intentVersion: 1,
          intentContract: {
            ...compileIntentContract({
              goal: 'Entregar o checkout',
              source: 'typed',
              intentVersion: 1,
              executionMode: 'autopilot',
              contextPolicy: 'on-demand',
            }),
            approvedAt: 1,
          },
          milestones: [], learnings: '', createdAt: 1, updatedAt: 2, description: 'x',
        },
        // Já existe uma missão com o título base completo (120 chars).
        {
          id: 'mX', title: base120, status: 'running',
          intentState: 'dispatched', intentVersion: 1,
          intentContract: {
            ...compileIntentContract({
              goal: 'Outra entrega',
              source: 'typed',
              intentVersion: 1,
              executionMode: 'autopilot',
              contextPolicy: 'on-demand',
            }),
            approvedAt: 1,
          },
          milestones: [], learnings: '', createdAt: 1, updatedAt: 2, description: 'x',
        },
      ] as Mission[],
      paneMissions: { a1: 'mA' },
    });
    useSessionStateStore.setState({
      paneStates: new Map<string, PaneSessionState>([
        ['a1', 'idle'],
        ['a3', 'idle'],
      ]),
    });
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: { orch: { createPaneMission, promoteMissionOrchestrator: vi.fn(async () => ({ ok: true })) } },
    });

    const pending = mod.promotePaneWithMissionChoice({ paneId: 'a3' });
    await vi.waitFor(() =>
      expect(useChoiceStore.getState().pending).not.toBeNull(),
    );
    useChoiceStore.getState().decide(mod.PROMOTE_OWN_MISSION);
    expect(await pending).toBe('mC');
    const sent = createPaneMission.mock.calls[0]?.[0];
    expect(sent!.title.length).toBeLessThanOrEqual(120);
    expect(sent!.title).toBe(`${base120.slice(0, 118)} 2`);
  });
});
