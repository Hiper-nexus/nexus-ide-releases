import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneModel, WorkspaceLayout } from '../../shared/types';
import { defaultCanvasLayout } from '../lib/canvas-layout';
import { buildGridTree, listPanes, MAX_LIVE_PANES_SOFT } from '../lib/split-tree';
import {
  detachWorkspaceLayout,
  flushLayout,
  sanitizeWorkspaceLayout,
  setRestoredPanesHandler,
  switchWorkspaceLayout,
  switchWorkspaceLayoutWithFallback,
  useLayoutStore,
} from './layout-store';

const basePane: PaneModel = {
  id: 'pane-a',
  kind: 'shell',
  title: 'Terminal',
};

afterEach(() => {
  setRestoredPanesHandler(null);
  detachWorkspaceLayout();
  vi.unstubAllGlobals();
});

describe('layout-store canvas placement', () => {
  beforeEach(() => {
    const root = buildGridTree([basePane]);
    useLayoutStore.setState({
      root,
      focusedPaneId: basePane.id,
      hydrated: true,
      viewKind: 'canvas',
      canvasNodeLayouts: {},
      canvasViewport: { x: 0, y: 0, zoom: 1 },
    });
  });

  it('places a new terminal beside the focused pane even when its canvas layout is missing', () => {
    const paneId = useLayoutStore.getState().addShellPane();
    const layouts = useLayoutStore.getState().canvasNodeLayouts;
    const focusedLayout = defaultCanvasLayout(0);

    expect(layouts[basePane.id]).toEqual(focusedLayout);
    expect(layouts[paneId].position).toEqual({
      x: focusedLayout.position.x + focusedLayout.size.width + 24,
      y: focusedLayout.position.y,
    });
    expect(layouts[paneId].size).toEqual(focusedLayout.size);
  });
});

describe('layout-store pane maximize', () => {
  beforeEach(() => {
    const panes: PaneModel[] = [
      { id: 'pane-a', kind: 'shell', title: 'A' },
      { id: 'pane-b', kind: 'shell', title: 'B' },
    ];
    useLayoutStore.setState({
      root: buildGridTree(panes),
      focusedPaneId: 'pane-a',
      maximizedPaneId: null,
      hydrated: true,
      viewKind: 'grid',
      canvasNodeLayouts: {},
      canvasViewport: { x: 0, y: 0, zoom: 1 },
    });
  });

  it('toggles one maximized pane without removing the others', () => {
    const beforeIds = listPanes(useLayoutStore.getState().root).map((pane) => pane.id);

    useLayoutStore.getState().toggleMaximizePane('pane-b');

    expect(useLayoutStore.getState().focusedPaneId).toBe('pane-b');
    expect(useLayoutStore.getState().maximizedPaneId).toBe('pane-b');
    expect(listPanes(useLayoutStore.getState().root).map((pane) => pane.id)).toEqual(beforeIds);

    useLayoutStore.getState().toggleMaximizePane('pane-b');

    expect(useLayoutStore.getState().maximizedPaneId).toBeNull();
    expect(listPanes(useLayoutStore.getState().root).map((pane) => pane.id)).toEqual(beforeIds);
  });

  it('clears maximized state when that pane closes', () => {
    useLayoutStore.getState().toggleMaximizePane('pane-b');

    useLayoutStore.getState().close('pane-b', 'test');

    expect(useLayoutStore.getState().maximizedPaneId).toBeNull();
    expect(listPanes(useLayoutStore.getState().root).map((pane) => pane.id)).toEqual(['pane-a']);
  });
});

describe('layout-store maximize vs foco programático', () => {
  const shell: PaneModel = { id: 'shell-1', kind: 'shell', title: 'Terminal' };
  const orch: PaneModel = {
    id: 'm-orch',
    kind: 'cli-agent',
    title: 'orch',
    adapterId: 'claude',
    missionId: 'm1',
    role: 'orchestrator',
  };
  const worker: PaneModel = {
    id: 'm-worker',
    kind: 'cli-agent',
    title: 'worker',
    adapterId: 'codex',
    missionId: 'm1',
    role: 'worker',
  };

  beforeEach(() => {
    useLayoutStore.setState({
      root: buildGridTree([shell]),
      focusedPaneId: shell.id,
      maximizedPaneId: null,
      hydrated: true,
      viewKind: 'grid',
      canvasNodeLayouts: {},
      canvasViewport: { x: 0, y: 0, zoom: 1 },
    });
  });

  it('foco programático derruba um maximize stale cobrindo os panes da missão', () => {
    // Cenário do bug: shell vazio maximizado; a retomada da missão monta os
    // panes reais e foca o orquestrador — o grid renderizava SÓ o shell.
    useLayoutStore.getState().toggleMaximizePane(shell.id);

    useLayoutStore.getState().setPanes([shell, orch, worker]);
    useLayoutStore.getState().focus(orch.id);

    const s = useLayoutStore.getState();
    expect(s.maximizedPaneId).toBeNull();
    expect(s.focusedPaneId).toBe(orch.id);
    expect(listPanes(s.root).map((pane) => pane.id)).toEqual([
      shell.id,
      orch.id,
      worker.id,
    ]);
  });

  it('focar o próprio pane maximizado mantém o maximize', () => {
    useLayoutStore.getState().toggleMaximizePane(shell.id);

    useLayoutStore.getState().focus(shell.id);

    expect(useLayoutStore.getState().maximizedPaneId).toBe(shell.id);
    expect(useLayoutStore.getState().focusedPaneId).toBe(shell.id);
  });

  it('foco comum sem maximize continua só trocando o foco', () => {
    useLayoutStore.getState().setPanes([shell, orch]);

    useLayoutStore.getState().focus(orch.id);

    expect(useLayoutStore.getState().maximizedPaneId).toBeNull();
    expect(useLayoutStore.getState().focusedPaneId).toBe(orch.id);
  });
});

describe('layout-store transient pane recovery', () => {
  it('removes new and legacy PREVC reviewers before hydrate or restore', async () => {
    const reviewerSuffix = 'a1b2c3d4e5f6';
    const durable: PaneModel = {
      id: 'pane-durable',
      kind: 'cli-agent',
      title: 'Executor',
      adapterId: 'codex',
      missionId: 'mission-a',
      role: 'worker',
      agentName: 'executor',
    };
    const transient: PaneModel = {
      id: 'pane-transient-reviewer',
      kind: 'cli-agent',
      title: 'PREVC reviewer',
      adapterId: 'claude',
      missionId: 'mission-a',
      role: 'worker',
      transient: true,
    };
    const legacy: PaneModel = {
      id: 'pane-legacy-reviewer',
      kind: 'cli-agent',
      title: `review-mission-a-1-${reviewerSuffix}`,
      adapterId: 'claude',
      missionId: 'mission-a',
      role: 'worker',
      agentName: `reviewer-claude-1-${reviewerSuffix}`,
    };
    const crashedLayout = {
      root: buildGridTree([durable, transient, legacy]),
      focusedPaneId: legacy.id,
      viewKind: 'canvas' as const,
      canvasNodeLayouts: {
        [durable.id]: defaultCanvasLayout(0),
        [transient.id]: defaultCanvasLayout(1),
        [legacy.id]: defaultCanvasLayout(2),
      },
      canvasViewport: { x: 0, y: 0, zoom: 1 },
    };

    const sanitized = sanitizeWorkspaceLayout(crashedLayout);
    expect(listPanes(sanitized.root).map((pane) => pane.id)).toEqual([
      durable.id,
    ]);
    expect(sanitized.focusedPaneId).toBe(durable.id);
    expect(Object.keys(sanitized.canvasNodeLayouts ?? {})).toEqual([
      durable.id,
    ]);

    const onlyLegacyLayout = {
      ...crashedLayout,
      root: buildGridTree([legacy]),
      focusedPaneId: legacy.id,
      canvasNodeLayouts: {
        [legacy.id]: defaultCanvasLayout(0),
      },
    };
    const save = vi.fn(
      async (_workspacePath: string, _layout: WorkspaceLayout) => undefined,
    );
    const saveSync = vi.fn(
      (_workspacePath: string, _layout: WorkspaceLayout) => undefined,
    );
    const restored = vi.fn();
    vi.stubGlobal('window', {
      nexus: {
        layout: {
          load: vi.fn(async () => onlyLegacyLayout),
          save,
          saveSync,
        },
      },
    });
    setRestoredPanesHandler(restored);

    await switchWorkspaceLayout('/workspace/crashed-prevc-reviewer');

    const restoredPanes = restored.mock.calls[0]?.[0] as PaneModel[];
    expect(restoredPanes).toHaveLength(1);
    expect(restoredPanes[0]).toMatchObject({ kind: 'shell' });
    expect(restoredPanes[0]?.id).not.toBe(legacy.id);
    expect(save).toHaveBeenCalledWith(
      '/workspace/crashed-prevc-reviewer',
      expect.any(Object),
    );

    useLayoutStore.getState().spawnOrchPane({
      paneId: 'pane-live-transient',
      adapterId: 'claude',
      title: 'PREVC live',
      orchRequestId: 'orchspawn-live-transient',
      missionId: 'mission-a',
      role: 'worker',
      transient: true,
    });
    expect(
      listPanes(useLayoutStore.getState().root).map((pane) => pane.id),
    ).toContain('pane-live-transient');

    await new Promise((resolve) => setTimeout(resolve, 350));
    const durableSaves = save.mock.calls.filter(
      ([workspacePath]) =>
        workspacePath === '/workspace/crashed-prevc-reviewer',
    );
    const lastSavedLayout = durableSaves.at(-1)?.[1] as
      | ReturnType<typeof sanitizeWorkspaceLayout>
      | undefined;
    expect(lastSavedLayout).toBeDefined();
    expect(
      listPanes(lastSavedLayout!.root).map((pane) => pane.id),
    ).not.toContain('pane-live-transient');

    flushLayout(true);
    const syncLayout = saveSync.mock.calls.at(-1)?.[1] as
      | ReturnType<typeof sanitizeWorkspaceLayout>
      | undefined;
    expect(syncLayout).toBeDefined();
    expect(listPanes(syncLayout!.root).map((pane) => pane.id)).not.toContain(
      'pane-live-transient',
    );
  });
});

describe('layout-store workspace load failure', () => {
  it('retries once and hydrates a safe shell instead of trapping the app on boot', async () => {
    const save = vi.fn(async () => undefined);
    const load = vi.fn(async () => {
      throw new Error('layout unavailable');
    });
    vi.stubGlobal('window', {
      nexus: {
        layout: {
          load,
          save,
          saveSync: vi.fn(),
        },
      },
    });
    useLayoutStore.setState({ hydrated: false });

    await expect(
      switchWorkspaceLayoutWithFallback('/workspace/unavailable'),
    ).rejects.toThrow('layout unavailable');

    expect(load).toHaveBeenCalledTimes(2);
    expect(useLayoutStore.getState().hydrated).toBe(true);
    expect(listPanes(useLayoutStore.getState().root)).toHaveLength(1);
    useLayoutStore.getState().addShellPane();
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(save).not.toHaveBeenCalled();
  });

  it('detaches persistence so outgoing panes cannot be saved under the failed target', async () => {
    const save = vi.fn(async () => undefined);
    vi.stubGlobal('window', {
      nexus: {
        layout: {
          load: vi.fn(async () => {
            throw new Error('layout unavailable');
          }),
          save,
          saveSync: vi.fn(),
        },
      },
    });

    await expect(
      switchWorkspaceLayout('/workspace/unavailable'),
    ).rejects.toThrow('layout unavailable');

    useLayoutStore.getState().addShellPane();
    await new Promise((resolve) => setTimeout(resolve, 350));

    expect(save).not.toHaveBeenCalled();
  });
});

describe('layout-store orch spawn ceiling', () => {
  function seedPanes(count: number): void {
    const panes: PaneModel[] = Array.from({ length: count }, (_, i) => ({
      id: `pane-${i}`,
      kind: 'shell',
      title: `T${i}`,
    }));
    useLayoutStore.setState({
      root: buildGridTree(panes),
      focusedPaneId: 'pane-0',
      hydrated: true,
      viewKind: 'grid',
      canvasNodeLayouts: {},
      canvasViewport: { x: 0, y: 0, zoom: 1 },
    });
  }

  const orchSpawn = () =>
    useLayoutStore.getState().spawnOrchPane({
      paneId: 'pane-orch-new',
      adapterId: 'claude',
      title: 'worker',
      orchRequestId: 'orchspawn-ceiling',
      missionId: 'mission-ceiling',
      role: 'worker',
    });

  it('admits orch spawns up to the soft ceiling (orchestrator + 8 workers + user panes)', () => {
    seedPanes(MAX_LIVE_PANES_SOFT - 1);
    expect(orchSpawn()).toBe('pane-orch-new');
    expect(listPanes(useLayoutStore.getState().root)).toHaveLength(
      MAX_LIVE_PANES_SOFT,
    );
  });

  it('refuses orch spawns at the soft ceiling', () => {
    seedPanes(MAX_LIVE_PANES_SOFT);
    expect(orchSpawn).toThrow(`Limite de panes (${MAX_LIVE_PANES_SOFT})`);
  });
});
