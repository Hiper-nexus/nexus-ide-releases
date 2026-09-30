/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MissionPanePresentationRequest } from '../../shared/orch-types';
import type { PaneModel, WorkspaceLayout } from '../../shared/types';
import {
  buildGridTree,
  isStructuralPlaceholderPane,
  listPanes,
  MAX_LIVE_PANES_HARD,
} from '../lib/split-tree';
import { setActiveWorkspacePath } from '../state/active-workspace';
import {
  abandonWorkspaceLayoutAfterMainSwitch,
  detachWorkspaceLayout,
  switchWorkspaceLayout,
  switchWorkspaceLayoutWithFallback,
  useLayoutStore,
  whenWorkspaceLayoutSettled,
} from '../state/layout-store';
import { useOrchStore } from '../state/orch-store';
import { useOrchBridge } from './orch-bridge';

/**
 * THE INVARIANT UNDER TEST
 *
 * A live main-owned mission pane is AUTHORITY; the persisted workspace layout
 * is only a RESTORATION HINT, and a structural placeholder is a VACANCY.
 * Therefore, after any interleaving of {workspace layout restore, mission
 * presentation, worker spawn, recovery}:
 *
 *  I1  a structural placeholder never coexists with (or replaces) real content;
 *  I2  a zoom (maximizedPaneId) never points at a pane that left the tree and,
 *      desde a F-521, SOBREVIVE a writes que adicionam panes — workers entram
 *      atrás do orquestrador em modo foco em vez de roubar o zoom;
 *  I3  no layout restore (persisted tree, or the read-failure fallback) may
 *      evict a pane bound to a live mission;
 *  I4  the presentation channel owns focus for the pane it presents.
 *
 * Every previous fix patched ONE caller. These assertions are written against
 * the STATE, so they fail no matter which path breaks them.
 */

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

/**
 * `switchWorkspaceLayout` coalesces concurrent loads per path in module-level
 * state, so each scenario gets its own workspace path — a test may never
 * inherit another test's in-flight switch.
 */
let workspaceSeq = 0;
let WORKSPACE = '/workspace/live-0';

/**
 * Byte-for-byte the shape found in a real 0.21.0 install
 * (project-runtime/.../runtime.sqlite3 → workspace_layout): ONE structural
 * placeholder that carries persisted scrollback, so on restore it replays
 * "[nexus] process exited (code 0)" and respawns a shell. That is why the
 * operator sees a REAL terminal and not an obviously empty tile.
 */
const PERSISTED_PLACEHOLDER_LAYOUT: WorkspaceLayout = {
  root: {
    kind: 'leaf',
    id: 'leaf-persisted',
    pane: {
      id: 'pane-1c962a59',
      kind: 'shell',
      title: 'shell',
      isStructuralPlaceholder: true,
      terminalScrollback:
        'cleofasrocha@MacBook-Pro nexus-ide % \r\n[90m[nexus] process exited (code 0)[0m',
    },
  },
  focusedPaneId: 'pane-1c962a59',
};

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

let presentationHandler:
  | ((request: MissionPanePresentationRequest) => void)
  | null = null;
let loadLayout: (path: string) => Promise<WorkspaceLayout | null> = async () =>
  null;

function installNexus(): void {
  presentationHandler = null;
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    value: {
      mission: missionBridge(),
      layout: {
        load: vi.fn((path: string) => loadLayout(path)),
        save: vi.fn(async () => undefined),
        saveSync: vi.fn(() => undefined),
      },
      orch: {
        onPaneSpawnRequest: listener(),
        onPanePresentationRequest: vi.fn(
          (next: (request: MissionPanePresentationRequest) => void) => {
            presentationHandler = next;
            return vi.fn();
          },
        ),
        onPaneRecoveryRequest: listener(),
        onBrowserOpenRequest: listener(),
        onPaneCloseRequest: listener(),
        onPaneParkRequest: listener(),
        onMissionsChanged: listener(),
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
}

function mount(): Root {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<Harness />));
  return root;
}

function presentationRequest(
  id: string,
): MissionPanePresentationRequest {
  return {
    missionId: `mission-${id}`,
    paneId: `pane-${id}`,
    sessionId: `session-${id}`,
    role: 'orchestrator',
    pane: {
      adapterId: 'codex',
      cwd: WORKSPACE,
      title: `${id} · orq`,
      agentName: 'Maestro',
      role: 'orchestrator',
    },
  };
}

async function present(id: string): Promise<void> {
  terminal.waitForSession.mockResolvedValue(`session-${id}`);
  await act(async () => {
    presentationHandler?.(presentationRequest(id));
    await vi.waitFor(() => {
      expect(terminal.waitForSession).toHaveBeenCalledWith(
        `pane-${id}`,
        75_000,
      );
    });
  });
}

function panes(): PaneModel[] {
  return listPanes(useLayoutStore.getState().root);
}

function paneIds(): string[] {
  return panes().map((pane) => pane.id);
}

/** I1 + I2, checkable after ANY action, by ANY path. */
function expectLayoutInvariants(): void {
  const live = panes();
  const placeholders = live.filter(isStructuralPlaceholderPane);
  if (live.length > placeholders.length) {
    expect({
      rule: 'I1 placeholder is a vacancy, never content',
      panes: live.map((pane) => ({
        id: pane.id,
        kind: pane.kind,
        placeholder: pane.isStructuralPlaceholder === true,
      })),
      placeholders: placeholders.map((pane) => pane.id),
    }).toMatchObject({ placeholders: [] });
  }
  const maximized = useLayoutStore.getState().maximizedPaneId;
  if (maximized !== null) {
    expect(live.map((pane) => pane.id)).toContain(maximized);
  }
}

describe('mission pane authority vs. workspace layout restore', () => {
  beforeEach(() => {
    workspaceSeq += 1;
    WORKSPACE = `/workspace/live-${workspaceSeq}`;
    installNexus();
    loadLayout = async () => structuredClone(PERSISTED_PLACEHOLDER_LAYOUT);
    setActiveWorkspacePath(WORKSPACE);
    useOrchStore.setState({ paneMissions: {}, workspaceEpoch: 0 });
    useLayoutStore.setState({
      root: {
        kind: 'leaf',
        id: 'leaf-boot',
        pane: {
          id: 'pane-boot',
          kind: 'shell',
          title: 'shell',
          isStructuralPlaceholder: true,
        },
      },
      focusedPaneId: 'pane-boot',
      maximizedPaneId: null,
      hydrated: false,
    });
  });

  afterEach(() => {
    detachWorkspaceLayout();
    setActiveWorkspacePath(null);
    Reflect.deleteProperty(window, 'nexus');
    document.body.innerHTML = '';
    vi.clearAllMocks();
    terminal.getPaneSessionId.mockReset().mockReturnValue(null);
    terminal.isPaneSessionHealthy.mockReset().mockReturnValue(true);
    terminal.waitForSession.mockReset().mockResolvedValue('session-new');
  });

  it('regression (4e2229c0): a presentation fired before the first hydrate is held, then replaces the placeholder', async () => {
    const root = mount();
    terminal.waitForSession.mockResolvedValue('session-boot');
    act(() => {
      presentationHandler?.(presentationRequest('boot'));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(terminal.waitForSession).not.toHaveBeenCalled();

    await act(async () => {
      await switchWorkspaceLayout(WORKSPACE);
      await vi.waitFor(() => {
        expect(terminal.waitForSession).toHaveBeenCalledWith(
          'pane-boot',
          75_000,
        );
      });
    });
    expect(paneIds()).toEqual(['pane-boot']);
    expectLayoutInvariants();
    act(() => root.unmount());
  });

  it('I3: a second workspace layout restore must not evict the live mission pane it did not know about', async () => {
    // Boot: the persisted lone placeholder restores and settles.
    const root = mount();
    await act(async () => {
      await switchWorkspaceLayout(WORKSPACE);
    });
    expect(paneIds()).toEqual(['pane-1c962a59']);

    // The operator starts a mission. Main owns it and presents its pane.
    await present('live');
    expect(paneIds()).toEqual(['pane-live']);

    // ANY later workspace re-activation reloads the SAME persisted layout —
    // the debounced save of the mission pane has not landed (and
    // abandonWorkspaceLayoutAfterMainSwitch cancels it outright). `hydrated`
    // is a one-shot latch, so nothing holds this restore back.
    abandonWorkspaceLayoutAfterMainSwitch();
    await act(async () => {
      await switchWorkspaceLayout(WORKSPACE);
    });

    expect(paneIds()).toContain('pane-live');
    expectLayoutInvariants();
    act(() => root.unmount());
  });

  it('I3: the layout read-failure fallback must not wipe a live mission pane', async () => {
    const root = mount();
    await act(async () => {
      await switchWorkspaceLayout(WORKSPACE);
    });
    await present('live');
    expect(paneIds()).toEqual(['pane-live']);

    // switchWorkspaceLayoutWithFallback: two failed reads → hydrate(null).
    // In production this is App.tsx's catch branch ("Layout não pôde ser
    // restaurado"). Today it installs a fresh structural placeholder over a
    // running main-owned mission — the exact "empty pane covering the
    // mission; I close it and the mission appears" report.
    abandonWorkspaceLayoutAfterMainSwitch();
    loadLayout = async () => {
      throw new Error('runtime.sqlite3 is busy');
    };
    await act(async () => {
      await switchWorkspaceLayoutWithFallback(WORKSPACE).catch(() => undefined);
    });

    expect(paneIds()).toContain('pane-live');
    expectLayoutInvariants();
    act(() => root.unmount());
  });

  it('the settle gate must re-arm for every layout load, not only the first', async () => {
    const root = mount();
    await act(async () => {
      await switchWorkspaceLayout(WORKSPACE);
    });
    expect(useLayoutStore.getState().hydrated).toBe(true);

    // A second load is in flight. Until it lands, the tree is NOT settled —
    // presentations must wait, exactly as they do on the first boot.
    let releaseLoad: (() => void) | null = null;
    loadLayout = async () => {
      await new Promise<void>((resolve) => {
        releaseLoad = resolve;
      });
      return structuredClone(PERSISTED_PLACEHOLDER_LAYOUT);
    };
    abandonWorkspaceLayoutAfterMainSwitch();
    let settled = false;
    let settledWhileLoading = true;
    await act(async () => {
      const inFlight = switchWorkspaceLayout(WORKSPACE);
      void whenWorkspaceLayoutSettled().then(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      settledWhileLoading = settled;
      // Always release: a pending load would leak into the next scenario.
      releaseLoad?.();
      await inFlight;
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(settledWhileLoading).toBe(false);
    expect(settled).toBe(true);
    act(() => root.unmount());
  });

  it('I2: a stale zoom never survives a restore that changes the pane set', async () => {
    const root = mount();
    await act(async () => {
      await switchWorkspaceLayout(WORKSPACE);
    });
    act(() => {
      useLayoutStore.getState().toggleMaximizePane('pane-1c962a59');
    });
    expect(useLayoutStore.getState().maximizedPaneId).toBe('pane-1c962a59');

    // A restore that keeps the maximized pane AND adds others leaves the zoom
    // covering the newcomers: PaneGrid renders only the maximized pane.
    loadLayout = async () => ({
      root: {
        kind: 'split',
        id: 'split-restored',
        direction: 'row',
        children: [
          structuredClone(PERSISTED_PLACEHOLDER_LAYOUT.root),
          {
            kind: 'leaf',
            id: 'leaf-mission',
            pane: {
              id: 'pane-restored-mission',
              kind: 'cli-agent',
              title: 'orq',
              adapterId: 'codex',
              missionId: 'mission-restored',
              role: 'orchestrator',
            },
          },
        ],
      },
      focusedPaneId: 'pane-restored-mission',
    });
    abandonWorkspaceLayoutAfterMainSwitch();
    await act(async () => {
      await switchWorkspaceLayout(WORKSPACE);
    });

    expect(useLayoutStore.getState().maximizedPaneId).toBeNull();
    expectLayoutInvariants();
    act(() => root.unmount());
  });

  it('I4: the presentation channel owns focus for the pane it presents', async () => {
    const root = mount();
    await act(async () => {
      await switchWorkspaceLayout(WORKSPACE);
    });
    // A first mission is live; a second one is presented next to it.
    await present('one');
    await present('two');

    expect(paneIds()).toEqual(['pane-one', 'pane-two']);
    expect(useLayoutStore.getState().focusedPaneId).toBe('pane-two');
    expectLayoutInvariants();
    act(() => root.unmount());
  });

  /**
   * M1 — the cap is REACHED in a squad swarm, and that is the whole chain:
   *
   *  1. `panesAfterMainOwnedPresentation` appends the presented pane LAST;
   *  2. `setPanes` enforces MAX_LIVE_PANES_HARD by truncating the tail, so the
   *     pane this request just presented is exactly the one discarded;
   *  3. the presentation channel focuses it anyway (I4) — focus now names a
   *     pane that exists nowhere;
   *  4. the next `addShellPane` uses `focusedPaneId` as its split pivot;
   *     `splitPane` cannot find it, returns the tree UNCHANGED, and the store
   *     still hands back the id of a pane it never inserted — the caller then
   *     waits for a PTY session that can never attach.
   *
   * Asserted against the STATE, so it fails at whichever link breaks.
   */
  it('M1: a presentation the hard cap discards leaves neither phantom focus nor a phantom pane id', async () => {
    const saturated: PaneModel[] = Array.from(
      { length: MAX_LIVE_PANES_HARD },
      (_, index) => ({
        id: `pane-full-${index}`,
        kind: 'shell' as const,
        title: `T${index}`,
      }),
    );
    loadLayout = async () => ({
      root: buildGridTree(saturated),
      focusedPaneId: 'pane-full-0',
    });
    const root = mount();
    await act(async () => {
      await switchWorkspaceLayout(WORKSPACE);
    });
    expect(paneIds()).toHaveLength(MAX_LIVE_PANES_HARD);

    terminal.waitForSession.mockResolvedValue('session-live');
    await act(async () => {
      presentationHandler?.(presentationRequest('live'));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    // Precondition: the grid is full, so the presented pane was discarded.
    expect(paneIds()).not.toContain('pane-live');
    // Focus may only ever name a pane that is actually in the tree.
    expect(paneIds()).toContain(useLayoutStore.getState().focusedPaneId);

    // ...and the next ＋Terminal must hand back an id its caller can spawn on.
    let shellPaneId = '';
    act(() => {
      shellPaneId = useLayoutStore.getState().addShellPane();
    });
    expect(paneIds()).toContain(shellPaneId);
    expectLayoutInvariants();
    act(() => root.unmount());
  });

  /**
   * The point of the whole exercise. Four fixes each proved ONE arrival order
   * and the bug came back through another. These steps are the real events a
   * mission start produces, and EVERY order of them must end with the mission
   * on screen and the invariants intact.
   */
  const STEPS = ['restore', 'present', 'zoom', 'worker'] as const;
  type Step = (typeof STEPS)[number];

  function permutations<T>(items: readonly T[]): T[][] {
    if (items.length <= 1) return [[...items]];
    return items.flatMap((item, index) =>
      permutations([
        ...items.slice(0, index),
        ...items.slice(index + 1),
      ]).map((rest) => [item, ...rest]),
    );
  }

  for (const order of permutations(STEPS)) {
    it(`ordering matrix — ${order.join(' → ')}`, async () => {
      const root = mount();
      let zoomedPaneId: string | null = null;
      await act(async () => {
        await switchWorkspaceLayout(WORKSPACE);
      });

      const run: Record<Step, () => Promise<void>> = {
        // A workspace layout re-read landing at an arbitrary moment.
        restore: async () => {
          abandonWorkspaceLayoutAfterMainSwitch();
          await act(async () => {
            await switchWorkspaceLayout(WORKSPACE);
          });
        },
        // Main presents the mission's orchestrator pane.
        present: async () => {
          await present('live');
        },
        // The operator zooms whatever is on screen at that moment.
        zoom: async () => {
          const target = paneIds()[0];
          if (target) {
            zoomedPaneId = target;
            act(() => {
              useLayoutStore.getState().toggleMaximizePane(target);
            });
          }
        },
        // A worker joins the mission through the spawn channel.
        worker: async () => {
          act(() => {
            useLayoutStore.getState().spawnOrchPane({
              paneId: 'pane-worker',
              adapterId: 'codex',
              orchRequestId: 'grant-worker',
              missionId: 'mission-live',
              role: 'worker',
            });
          });
        },
      };

      for (const step of order) await run[step]();

      // The mission pane may only be absent if it was never presented.
      if (order.includes('present')) {
        expect(paneIds()).toContain('pane-live');
      }
      expect(paneIds()).toContain('pane-worker');
      expectLayoutInvariants();
      // F-521 (2026-09-14): o zoom é a escolha explícita do operador e
      // SOBREVIVE a workers montados depois — o worker entra atrás do
      // orquestrador em modo foco, não rouba o zoom. Apresentação (I4) e
      // restore posteriores têm autoridade própria de foco/layout e podem
      // legitimamente encerrar o zoom; nesses casos só o invariante genérico
      // (zoom → pane vivo) continua valendo, já verificado por
      // expectLayoutInvariants.
      const stepsAfterZoom = order.slice(order.indexOf('zoom') + 1);
      const onlyWorkerAfterZoom =
        stepsAfterZoom.includes('worker') &&
        !stepsAfterZoom.includes('present') &&
        !stepsAfterZoom.includes('restore');
      if (onlyWorkerAfterZoom && zoomedPaneId) {
        expect(useLayoutStore.getState().maximizedPaneId).toBe(zoomedPaneId);
      }
      act(() => root.unmount());
    });
  }
});
