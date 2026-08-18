import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mission, MissionStatus } from '../../shared/orch-types';
import type { PaneModel } from '../../shared/types';
import { buildGridTree } from '../lib/split-tree';
import { useLayoutStore } from '../state/layout-store';
import { useOrchStore } from '../state/orch-store';
import { useToastStore } from '../state/toast-store';

const confirmAndReopenMission = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true as const, panes: 1 })),
);

vi.mock('./confirm-reopen-mission', () => ({ confirmAndReopenMission }));

function makeMission(status: MissionStatus, id = 'mission-1'): Mission {
  return {
    id,
    title: 'Refatorar checkout',
    description: '',
    status,
    milestones: [],
    learnings: '',
    createdAt: 0,
    updatedAt: 0,
  } as Mission;
}

function seedLayout(panes: PaneModel[]): void {
  useLayoutStore.setState({
    root: buildGridTree(panes),
    focusedPaneId: panes[0]?.id ?? null,
    maximizedPaneId: null,
    hydrated: true,
    viewKind: 'grid',
    canvasNodeLayouts: {},
    canvasViewport: { x: 0, y: 0, zoom: 1 },
  });
}

function seedOrch(missions: Mission[], paneMissions: Record<string, string>): void {
  useOrchStore.setState({ missions, paneMissions });
}

const missionPane: PaneModel = {
  id: 'pane-m1',
  kind: 'cli-agent',
  title: 'orquestrador',
  adapterId: 'claude',
  missionId: 'mission-1',
  role: 'orchestrator',
};

beforeEach(() => {
  confirmAndReopenMission.mockClear();
  useToastStore.setState({ toasts: [] });
  seedOrch([], {});
});

describe('mission last pane closed → toast de reabertura', () => {
  it('avisa com ação "Reabrir panes" quando o último pane de uma missão running fecha', () => {
    seedLayout([missionPane]);
    seedOrch([makeMission('running')], { 'pane-m1': 'mission-1' });

    useLayoutStore.getState().close('pane-m1', 'user');

    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({
      kind: 'info',
      title: 'Missão continua em execução',
      action: { label: 'Reabrir panes' },
    });
    expect(toasts[0]?.detail).toContain('Refatorar checkout');
    expect(toasts[0]?.detail).not.toContain('mission-1');
  });

  it('a ação do toast segue a mesma rota de retomada do card da missão', async () => {
    const mission = makeMission('running');
    seedLayout([missionPane]);
    seedOrch([mission], { 'pane-m1': 'mission-1' });

    useLayoutStore.getState().close('pane-m1', 'user');
    const action = useToastStore.getState().toasts[0]?.action;
    expect(action).toBeDefined();

    await action!.onClick();

    // Mesma entrada usada pelo "Retomar panes salvos" do MissionRail.
    expect(confirmAndReopenMission).toHaveBeenCalledTimes(1);
    expect(confirmAndReopenMission).toHaveBeenCalledWith(mission);
  });

  it('também dispara quando o runtime aposenta o último pane (sem ação do operador)', () => {
    seedLayout([missionPane]);
    seedOrch([makeMission('running')], { 'pane-m1': 'mission-1' });

    useLayoutStore.getState().close('pane-m1', 'orch-close-request');

    expect(useToastStore.getState().toasts).toHaveLength(1);
  });

  it.each(['done', 'failed', 'blocked'] as const)(
    'não avisa quando a missão está %s',
    (status) => {
      seedLayout([missionPane]);
      seedOrch([makeMission(status)], { 'pane-m1': 'mission-1' });

      useLayoutStore.getState().close('pane-m1', 'user');

      expect(useToastStore.getState().toasts).toHaveLength(0);
    },
  );

  it('não avisa enquanto outro pane da mesma missão continua aberto', () => {
    const worker: PaneModel = {
      id: 'pane-m1-worker',
      kind: 'cli-agent',
      title: 'worker',
      adapterId: 'codex',
      missionId: 'mission-1',
      role: 'worker',
    };
    seedLayout([missionPane, worker]);
    seedOrch([makeMission('running')], {
      'pane-m1': 'mission-1',
      'pane-m1-worker': 'mission-1',
    });

    useLayoutStore.getState().close('pane-m1', 'user');

    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('não avisa ao fechar um pane shell sem missão', () => {
    seedLayout([{ id: 'pane-shell', kind: 'shell', title: 'Terminal' }]);
    seedOrch([makeMission('running')], {});

    useLayoutStore.getState().close('pane-shell', 'user');

    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('não avisa quando o pane foi aposentado pela substituição do orquestrador', () => {
    // O successor nasce no mesmo tick do spawn que aposentou o cadáver;
    // "missão sem pane" seria mentira pelos milissegundos que o toast vive.
    seedLayout([missionPane]);
    seedOrch([makeMission('running')], { 'pane-m1': 'mission-1' });

    useLayoutStore.getState().close('pane-m1', 'orchestrator-replaced');

    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('não avisa quando o fechamento já encerrou o runtime da missão (toolbar/rail/board)', () => {
    seedLayout([missionPane]);
    seedOrch([makeMission('running')], { 'pane-m1': 'mission-1' });

    useLayoutStore.getState().close('pane-m1', 'pane-toolbar-close');

    expect(useToastStore.getState().toasts).toHaveLength(0);
  });
});
