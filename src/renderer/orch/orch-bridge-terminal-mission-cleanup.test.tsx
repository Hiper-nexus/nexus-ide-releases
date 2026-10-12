/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mission } from '../../shared/orch-types';
import {
  missionHomeScopeKeys,
  spaceScopeKey,
} from '../lib/pane-spaces';
import { listPanes } from '../lib/split-tree';
import { setActiveWorkspacePath } from '../state/active-workspace';
import { useLayoutStore } from '../state/layout-store';
import { useOrchStore } from '../state/orch-store';
import { useOrchBridge } from './orch-bridge';

const terminal = vi.hoisted(() => ({
  cancelPaneRecovery: vi.fn(),
  getPaneSessionId: vi.fn((_paneId: string) => null as string | null),
  holdSpawnUntilApproved: vi.fn(),
  isPaneSessionHealthy: vi.fn(() => true),
  markPersistedAuthorityOnSpawn: vi.fn(),
  onPaneSessionChange: vi.fn(() => vi.fn()),
  respawnMissionPaneFresh: vi.fn(async () => 'session-new'),
  submitPromptToPaneConfirmed: vi.fn(async () => true),
  waitForHealthyPaneSession: vi.fn(async () => 'session-new' as string | null),
  waitForSession: vi.fn(async () => 'session-new' as string | null),
}));

vi.mock('../terminal/terminal-host', () => terminal);
vi.mock('../browser/browser-host', () => ({
  waitForBrowserPaneCreated: vi.fn(async () => undefined),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function listener() {
  return vi.fn(() => vi.fn());
}

function Harness(): null {
  useOrchBridge();
  return null;
}

function makeMission(id: string, status: Mission['status']): Mission {
  return {
    id,
    title: `Missão ${id}`,
    description: '',
    status,
    milestones: [],
    learnings: '',
    createdAt: 0,
    updatedAt: 0,
  } as Mission;
}

describe('cleanup de panes de missão terminal (campanha 0.50)', () => {
  let missionsHandler: ((missions: Mission[]) => void) | null = null;
  let root: Root;

  beforeEach(() => {
    useLayoutStore.setState({ hydrated: true });
    useLayoutStore.setState({
      root: {
        kind: 'split',
        id: 'split-terminal',
        direction: 'row',
        children: [
          {
            kind: 'split',
            id: 'split-done',
            direction: 'row',
            children: [
              {
                kind: 'leaf',
                id: 'leaf-done',
                pane: {
                  id: 'pane-done-mission',
                  kind: 'cli-agent',
                  title: 'orq da missão encerrada',
                  adapterId: 'claude',
                  missionId: 'mission-done',
                  role: 'orchestrator',
                },
              },
              {
                kind: 'leaf',
                id: 'leaf-done-worker',
                pane: {
                  id: 'pane-done-worker',
                  kind: 'cli-agent',
                  title: 'worker da missão encerrada',
                  adapterId: 'claude',
                  missionId: 'mission-done',
                  role: 'worker',
                },
              },
            ],
          },
          {
            kind: 'split',
            id: 'split-col',
            direction: 'column',
            children: [
              {
                kind: 'leaf',
                id: 'leaf-running',
                pane: {
                  id: 'pane-running-mission',
                  kind: 'cli-agent',
                  title: 'worker vivo',
                  adapterId: 'claude',
                  missionId: 'mission-running',
                  role: 'worker',
                },
              },
              {
                kind: 'split',
                id: 'split-row2',
                direction: 'row',
                children: [
                  {
                    kind: 'leaf',
                    id: 'leaf-blocked',
                    pane: {
                      id: 'pane-blocked-mission',
                      kind: 'cli-agent',
                      title: 'worker da bloqueada',
                      adapterId: 'claude',
                      missionId: 'mission-blocked',
                      role: 'worker',
                    },
                  },
                  {
                    kind: 'leaf',
                    id: 'leaf-shell',
                    pane: { id: 'pane-shell', kind: 'shell', title: 'Shell' },
                  },
                ],
              },
            ],
          },
        ],
      },
      focusedPaneId: 'pane-shell',
    });
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        mission: { list: vi.fn(async () => []), onChanged: listener() },
        orch: {
          onPaneSpawnRequest: listener(),
          onPanePresentationRequest: listener(),
          onPaneRecoveryRequest: listener(),
          onBrowserOpenRequest: listener(),
          onPaneCloseRequest: listener(),
          onPaneParkRequest: listener(),
          onMissionsChanged: vi.fn((cb: (missions: Mission[]) => void) => {
            missionsHandler = cb;
            return vi.fn();
          }),
          onHandoffsChanged: listener(),
          onTodosChanged: listener(),
          onSquadsChanged: listener(),
          syncPanes: vi.fn(),
          sendPaneSpawnResult: vi.fn(),
          sendPaneRecoveryResult: vi.fn(),
          sendBrowserOpenResult: vi.fn(),
        },
      },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(<Harness />));
  });

  afterEach(() => {
    setActiveWorkspacePath(null);
    Reflect.deleteProperty(window, 'nexus');
    document.body.innerHTML = '';
    vi.clearAllMocks();
    terminal.getPaneSessionId.mockReset().mockReturnValue(null);
    terminal.waitForSession.mockReset().mockResolvedValue('session-new');
  });

  it('missão terminal não apaga pane nenhum: orquestrador E worker são aposentados', () => {
    // F-108 protegia só o Maestro. O worker morto de missão encerrada era
    // varrido com `close` + `syncPanesNow` — que PERSISTE. Foi uma das duas
    // portas que apagaram 7 panes de uma missão `done` em campo, e a pior:
    // `getPaneSessionId` fica vazio enquanto os hosts do renderer estão
    // drenados numa troca de workspace, então pane VIVO era tratado como
    // cadáver. Agora nada é removido automaticamente.
    act(() => {
      missionsHandler?.([
        makeMission('mission-done', 'done'),
        makeMission('mission-running', 'running'),
        makeMission('mission-blocked', 'blocked'),
      ]);
    });

    const panes = listPanes(useLayoutStore.getState().root).map((p) => p.id);
    expect(panes).toContain('pane-done-mission');
    expect(panes).toContain('pane-done-worker');
    expect(panes).toContain('pane-running-mission');
    expect(panes).toContain('pane-blocked-mission');
    expect(panes).toContain('pane-shell');
    // Aposentado = spawn segurado: fica no layout, nunca reexecuta sozinho.
    expect(terminal.holdSpawnUntilApproved).toHaveBeenCalledWith(
      'pane-done-worker',
    );
  });

  it('pane de missão done com SESSÃO VIVA não é fechado pelo renderer', () => {
    terminal.getPaneSessionId.mockImplementation(
      (paneId: string) =>
        paneId === 'pane-done-mission' ? 'session-viva' : null,
    );
    act(() => {
      missionsHandler?.([
        makeMission('mission-done', 'done'),
        makeMission('mission-running', 'running'),
        makeMission('mission-blocked', 'blocked'),
      ]);
    });

    // Sessão viva é lifecycle do main (close autoritativo mata o PTY) — o
    // renderer não fecha layout de pane vivo por varredura.
    const panes = listPanes(useLayoutStore.getState().root).map((p) => p.id);
    expect(panes).toContain('pane-done-mission');
  });

  it('lista vazia não varre nada (hidratação/travessia não pode derrubar grid)', () => {
    act(() => {
      missionsHandler?.([]);
    });
    const panes = listPanes(useLayoutStore.getState().root).map((p) => p.id);
    expect(panes).toContain('pane-done-mission');
  });

  it.each(['done', 'failed'] as const)(
    'mesma sessão lidera a missão seguinte (%s): o anfitrião herda a missão nova na MESMA aba',
    (terminalStatus) => {
      // F-1268: o pane do operador (sessão S, espaço X) hospeda a missão A.
      // A termina, o Main devolve a mão e a MESMA sessão passa a liderar B —
      // o broadcast prova a adoção pelo par sessão–missão. O missionId
      // persistido da missão terminal não pode vencer: B mora na aba X.
      useLayoutStore.setState({
        root: {
          kind: 'leaf',
          id: 'leaf-op',
          pane: {
            id: 'pane-op',
            kind: 'cli-agent',
            title: 'mão do operador',
            adapterId: 'claude',
            missionId: 'mission-a',
            missionHost: true,
            role: 'orchestrator',
            spaceId: 'space-x',
            spaceTitle: 'Meus terminais',
          },
        },
      });
      terminal.getPaneSessionId.mockImplementation((paneId: string) =>
        paneId === 'pane-op' ? 'session-s' : null,
      );

      act(() => {
        missionsHandler?.([
          { ...makeMission('mission-a', 'running'), orchestratorSessionId: 'session-s' },
        ]);
      });
      act(() => {
        missionsHandler?.([makeMission('mission-a', terminalStatus)]);
      });
      act(() => {
        missionsHandler?.([
          makeMission('mission-a', terminalStatus),
          { ...makeMission('mission-b', 'running'), orchestratorSessionId: 'session-s' },
        ]);
      });

      const pane = listPanes(useLayoutStore.getState().root).find(
        (item) => item.id === 'pane-op',
      );
      expect(pane?.missionId).toBe('mission-b');
      expect(pane?.role).toBe('orchestrator');
      expect(pane?.spaceId).toBe('space-x');
      const panes = listPanes(useLayoutStore.getState().root);
      expect(
        missionHomeScopeKeys(
          panes,
          useOrchStore.getState().paneMissions,
        ).get('mission-b'),
      ).toBe(spaceScopeKey('space-x'));
    },
  );
});
