/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchPaneSpawnRequest } from '../../shared/orch-types';
import { listPanes } from '../lib/split-tree';
import { setActiveWorkspacePath } from '../state/active-workspace';
import { useLayoutStore } from '../state/layout-store';
import { useOrchBridge } from './orch-bridge';

const terminal = vi.hoisted(() => ({
  cancelPaneRecovery: vi.fn(),
  getPaneSessionId: vi.fn((_paneId: string) => null as string | null),
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

function missionBridge() {
  return {
    list: vi.fn(async () => []),
    onChanged: listener(),
  };
}

function Harness(): null {
  useOrchBridge();
  return null;
}

function mount(): Root {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<Harness />));
  return root;
}

/**
 * Layout restaurado do boot: um orquestrador morto (grant de sessão anterior),
 * um worker da mesma missão e um orquestrador de OUTRA missão. O spawn novo
 * só pode aposentar o primeiro — worker e missão vizinha intocados.
 */
function seedRestoredLayout(): void {
  useLayoutStore.setState({
    hydrated: true,
    root: {
      kind: 'split',
      id: 'split-restored',
      direction: 'row',
      children: [
        {
          kind: 'leaf',
          id: 'leaf-old-orchestrator',
          pane: {
            id: 'pane-old-orchestrator',
            kind: 'cli-agent',
            title: 'Cliente tesoura de ouro',
            adapterId: 'claude',
            missionId: 'mission-a',
            role: 'orchestrator',
            orchRequestId: 'orchspawn-from-previous-app-run',
          },
        },
        {
          kind: 'split',
          id: 'split-right',
          direction: 'column',
          children: [
            {
              kind: 'leaf',
              id: 'leaf-worker',
              pane: {
                id: 'pane-worker',
                kind: 'cli-agent',
                title: 'Worker',
                adapterId: 'codex',
                missionId: 'mission-a',
                role: 'worker',
              },
            },
            {
              kind: 'leaf',
              id: 'leaf-other-mission',
              pane: {
                id: 'pane-other-mission',
                kind: 'cli-agent',
                title: 'Outra missão',
                adapterId: 'claude',
                missionId: 'mission-b',
                role: 'orchestrator',
              },
            },
          ],
        },
      ],
    },
    focusedPaneId: 'pane-old-orchestrator',
  });
}

function orchestratorSpawnRequest(
  overrides: Partial<OrchPaneSpawnRequest> = {},
): OrchPaneSpawnRequest {
  return {
    requestId: 'orchspawn-fresh',
    paneId: 'pane-fresh',
    adapterId: 'claude',
    missionId: 'mission-a',
    role: 'orchestrator',
    resume: false,
    resumeLatestOnly: false,
    restorePersistedAuthority: false,
    ...overrides,
  };
}

describe('orchestration bridge orchestrator dedup', () => {
  beforeEach(() => {
    useLayoutStore.setState({ hydrated: true });
  });

  afterEach(() => {
    setActiveWorkspacePath(null);
    Reflect.deleteProperty(window, 'nexus');
    document.body.innerHTML = '';
    vi.clearAllMocks();
    terminal.getPaneSessionId.mockReset().mockReturnValue(null);
    terminal.waitForSession.mockReset().mockResolvedValue('session-new');
  });

  it('retires the dead orchestrator pane of the same mission on a fresh orchestrator spawn', async () => {
    let spawnHandler: ((request: OrchPaneSpawnRequest) => void) | null = null;
    const sendPaneSpawnResult = vi.fn();
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        mission: missionBridge(),
        orch: {
          onPaneSpawnRequest: vi.fn(
            (cb: (request: OrchPaneSpawnRequest) => void) => {
              spawnHandler = cb;
              return vi.fn();
            },
          ),
          onPanePresentationRequest: listener(),
          onPaneRecoveryRequest: listener(),
          onBrowserOpenRequest: listener(),
          onPaneCloseRequest: listener(),
          onMissionsChanged: listener(),
          onHandoffsChanged: listener(),
          onTodosChanged: listener(),
          onSquadsChanged: listener(),
          syncPanes: vi.fn(),
          sendPaneSpawnResult,
          sendPaneRecoveryResult: vi.fn(),
          sendBrowserOpenResult: vi.fn(),
        },
      },
    });
    seedRestoredLayout();
    const root = mount();

    act(() => {
      spawnHandler?.(orchestratorSpawnRequest());
    });
    await vi.waitFor(() => {
      expect(sendPaneSpawnResult).toHaveBeenCalledWith(
        expect.objectContaining({ ok: true, paneId: 'pane-fresh' }),
      );
    });

    // Um orquestrador por missão: o pane restaurado da sessão anterior é
    // cadáver (main já provou o exit físico antes de emitir o grant novo) e
    // precisa sair do layout na hora — não pode virar o "segundo pane travado".
    const panes = listPanes(useLayoutStore.getState().root).map(
      (pane) => pane.id,
    );
    expect(panes).toEqual(
      expect.arrayContaining(['pane-fresh', 'pane-worker', 'pane-other-mission']),
    );
    expect(panes).not.toContain('pane-old-orchestrator');
    act(() => root.unmount());
  });

  it('keeps the previous orchestrator pane when the new spawn is a worker', async () => {
    let spawnHandler: ((request: OrchPaneSpawnRequest) => void) | null = null;
    const sendPaneSpawnResult = vi.fn();
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        mission: missionBridge(),
        orch: {
          onPaneSpawnRequest: vi.fn(
            (cb: (request: OrchPaneSpawnRequest) => void) => {
              spawnHandler = cb;
              return vi.fn();
            },
          ),
          onPanePresentationRequest: listener(),
          onPaneRecoveryRequest: listener(),
          onBrowserOpenRequest: listener(),
          onPaneCloseRequest: listener(),
          onMissionsChanged: listener(),
          onHandoffsChanged: listener(),
          onTodosChanged: listener(),
          onSquadsChanged: listener(),
          syncPanes: vi.fn(),
          sendPaneSpawnResult,
          sendPaneRecoveryResult: vi.fn(),
          sendBrowserOpenResult: vi.fn(),
        },
      },
    });
    seedRestoredLayout();
    const root = mount();

    act(() => {
      spawnHandler?.(
        orchestratorSpawnRequest({
          requestId: 'orchspawn-worker',
          paneId: 'pane-worker-fresh',
          role: 'worker',
        }),
      );
    });
    await vi.waitFor(() => {
      expect(sendPaneSpawnResult).toHaveBeenCalledWith(
        expect.objectContaining({ ok: true, paneId: 'pane-worker-fresh' }),
      );
    });

    // Spawn de worker não aposenta orquestrador: só a substituição do próprio
    // orquestrador (mesma missão, papel igual) tem esse efeito.
    const panes = listPanes(useLayoutStore.getState().root).map(
      (pane) => pane.id,
    );
    expect(panes).toContain('pane-old-orchestrator');
    expect(panes).toContain('pane-worker-fresh');
    act(() => root.unmount());
  });
});
