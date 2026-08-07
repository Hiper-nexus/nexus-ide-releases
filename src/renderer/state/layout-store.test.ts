import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneModel, WorkspaceLayout } from '../../shared/types';
import { defaultCanvasLayout } from '../lib/canvas-layout';
import { buildGridTree, listPanes, MAX_LIVE_PANES_SOFT } from '../lib/split-tree';
import {
  detachWorkspaceLayout,
  enforceLayoutInvariants,
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

type LayoutSeed = Parameters<typeof enforceLayoutInvariants>[1];

/**
 * Seed a fixture THROUGH the write seam.
 *
 * `useLayoutStore.setState` bypasses enforceLayoutInvariants, so a fixture
 * written that way can install a state the store itself forbids and then
 * "prove" behaviour on a tree production can never reach. Every fixture below
 * goes through the same rule the store applies to a real write.
 */
function seedLayout(partial: LayoutSeed): void {
  useLayoutStore.setState(
    enforceLayoutInvariants(useLayoutStore.getState(), partial),
  );
}

/**
 * Raw seed, deliberately OUTSIDE the seam. Only for states that PREDATE the
 * invariant (a layout persisted by an older release) or that exist to prove
 * the store repairs them. Never use it for a fixture the store could produce.
 */
function seedPreInvariantLayout(partial: LayoutSeed): void {
  useLayoutStore.setState(partial);
}

afterEach(() => {
  setRestoredPanesHandler(null);
  detachWorkspaceLayout();
  vi.unstubAllGlobals();
});

describe('layout-store canvas placement', () => {
  beforeEach(() => {
    const root = buildGridTree([basePane]);
    seedLayout({
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
    seedLayout({
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
    seedLayout({
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
    seedLayout({ hydrated: false });

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
    seedLayout({
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

describe('layout-store orch spawn vs structural placeholder', () => {
  const placeholder: PaneModel = {
    id: 'pane-placeholder',
    kind: 'shell',
    title: 'shell',
    isStructuralPlaceholder: true,
  };

  function seed(panes: PaneModel[]): void {
    seedLayout({
      root: buildGridTree(panes),
      focusedPaneId: panes[0]?.id ?? null,
      maximizedPaneId: null,
      hydrated: true,
      viewKind: 'grid',
      canvasNodeLayouts: {},
      canvasViewport: { x: 0, y: 0, zoom: 1 },
    });
  }

  const spawn = () =>
    useLayoutStore.getState().spawnOrchPane({
      paneId: 'pane-orch',
      adapterId: 'claude',
      title: 'orquestrador',
      orchRequestId: 'orchspawn-placeholder',
      missionId: 'mission-launch',
      role: 'orchestrator',
    });

  it('replaces a lone structural placeholder instead of splitting beside it', () => {
    seed([placeholder]);

    expect(spawn()).toBe('pane-orch');

    const panes = listPanes(useLayoutStore.getState().root);
    expect(panes.map((pane) => pane.id)).toEqual(['pane-orch']);
    expect(panes[0]).toMatchObject({
      kind: 'cli-agent',
      missionId: 'mission-launch',
      role: 'orchestrator',
    });
    expect(useLayoutStore.getState().focusedPaneId).toBe('pane-orch');
  });

  it('clears a stale maximize so the spawned pane is not covered by the empty shell', () => {
    seed([placeholder]);
    useLayoutStore.getState().toggleMaximizePane(placeholder.id);

    spawn();

    expect(useLayoutStore.getState().maximizedPaneId).toBeNull();
    expect(listPanes(useLayoutStore.getState().root).map((pane) => pane.id)).toEqual([
      'pane-orch',
    ]);
  });

  it('keeps a shell the operator claimed (marker cleared)', () => {
    seed([{ ...placeholder, isStructuralPlaceholder: undefined }]);

    spawn();

    expect(listPanes(useLayoutStore.getState().root).map((pane) => pane.id)).toEqual([
      'pane-placeholder',
      'pane-orch',
    ]);
  });

  it('reclaims an unclaimed placeholder that was already stranded beside real panes', () => {
    // Previously this store KEPT the placeholder whenever it was not alone —
    // the rule only fired for a lone one. That is precisely how the ghost tile
    // became permanent: the first real pane stranded the placeholder, and from
    // then on no path would ever remove it. A placeholder is a vacancy, so it
    // exists only while nothing real does. An operator who actually uses that
    // terminal claims it first (Home deck, split, ＋Terminal, or clicking into
    // it), which is covered by the test above.
    const agent: PaneModel = {
      id: 'pane-agent',
      kind: 'cli-agent',
      title: 'agent',
      adapterId: 'codex',
    };
    // Seeded OUTSIDE the seam on purpose: the invariant now forbids this state,
    // so `seed()` would repair it before the test ran. It still reaches the
    // store from a layout persisted by a release that predates the rule.
    seedPreInvariantLayout({
      root: buildGridTree([placeholder, agent]),
      focusedPaneId: placeholder.id,
      maximizedPaneId: null,
      hydrated: true,
      viewKind: 'grid',
      canvasNodeLayouts: {},
      canvasViewport: { x: 0, y: 0, zoom: 1 },
    });

    spawn();

    expect(
      listPanes(useLayoutStore.getState().root).map((pane) => pane.id).sort(),
    ).toEqual(['pane-agent', 'pane-orch']);
  });
});

describe('enforceLayoutInvariants (the rule itself)', () => {
  const placeholder: PaneModel = {
    id: 'pane-vacancy',
    kind: 'shell',
    title: 'shell',
    isStructuralPlaceholder: true,
  };
  const agent: PaneModel = {
    id: 'pane-agent',
    kind: 'cli-agent',
    title: 'orq',
    adapterId: 'codex',
    missionId: 'mission-1',
  };

  it('leaves a lone placeholder alone — a vacancy is legal while nothing real exists', () => {
    const root = buildGridTree([placeholder]);
    const next = enforceLayoutInvariants(
      { root: buildGridTree([placeholder]), focusedPaneId: null, maximizedPaneId: null },
      { root },
    );
    expect(listPanes(next.root!).map((pane) => pane.id)).toEqual(['pane-vacancy']);
  });

  it('reclaims the vacancy the moment real content shares the tree', () => {
    const next = enforceLayoutInvariants(
      { root: buildGridTree([placeholder]), focusedPaneId: 'pane-vacancy', maximizedPaneId: null },
      { root: buildGridTree([placeholder, agent]) },
    );
    expect(listPanes(next.root!).map((pane) => pane.id)).toEqual(['pane-agent']);
    // Focus followed the pane that survived; it may never name a dead pane.
    expect(next.focusedPaneId).toBe('pane-agent');
  });

  it('ends a zoom when the write mounts a pane the operator has not seen', () => {
    const next = enforceLayoutInvariants(
      { root: buildGridTree([agent]), focusedPaneId: 'pane-agent', maximizedPaneId: 'pane-agent' },
      { root: buildGridTree([agent, { ...agent, id: 'pane-worker', missionId: 'mission-1' }]) },
    );
    expect(next.maximizedPaneId).toBeNull();
  });

  it('keeps a zoom when the write only removes panes', () => {
    const worker: PaneModel = { ...agent, id: 'pane-worker' };
    const next = enforceLayoutInvariants(
      { root: buildGridTree([agent, worker]), focusedPaneId: 'pane-agent', maximizedPaneId: 'pane-agent' },
      { root: buildGridTree([agent]) },
    );
    expect(next.maximizedPaneId).toBe('pane-agent');
  });

  it('is a no-op for writes that do not touch the tree', () => {
    const partial = { hydrated: true } as const;
    expect(
      enforceLayoutInvariants(
        { root: buildGridTree([agent]), focusedPaneId: 'pane-agent', maximizedPaneId: 'pane-agent' },
        partial,
      ),
    ).toBe(partial);
  });

  // M1 — a write WITHOUT a root still moves the two pointers INTO the tree.
  // Skipping the whole rule for those writes is what let a phantom id survive.
  it('normalizes focus against the live tree when the write carries no root', () => {
    const next = enforceLayoutInvariants(
      { root: buildGridTree([agent]), focusedPaneId: 'pane-agent', maximizedPaneId: null },
      { focusedPaneId: 'pane-that-left-the-tree' },
    );
    expect(next.focusedPaneId).toBe('pane-agent');
  });

  it('drops a zoom naming a pane outside the tree when the write carries no root', () => {
    const next = enforceLayoutInvariants(
      { root: buildGridTree([agent]), focusedPaneId: 'pane-agent', maximizedPaneId: null },
      { maximizedPaneId: 'pane-that-left-the-tree' },
    );
    expect(next.maximizedPaneId).toBeNull();
  });

  it('keeps a legitimate rootless focus/zoom write untouched', () => {
    const worker: PaneModel = { ...agent, id: 'pane-worker' };
    const next = enforceLayoutInvariants(
      { root: buildGridTree([agent, worker]), focusedPaneId: 'pane-agent', maximizedPaneId: null },
      { focusedPaneId: 'pane-worker', maximizedPaneId: 'pane-worker' },
    );
    expect(next.focusedPaneId).toBe('pane-worker');
    expect(next.maximizedPaneId).toBe('pane-worker');
  });
});

describe('layout-store focus vs. panes that are not there', () => {
  it('focus() ignores an id that names no pane in the tree', () => {
    seedLayout({
      root: buildGridTree([basePane]),
      focusedPaneId: basePane.id,
      maximizedPaneId: null,
      hydrated: true,
      viewKind: 'grid',
      canvasNodeLayouts: {},
      canvasViewport: { x: 0, y: 0, zoom: 1 },
    });

    useLayoutStore.getState().focus('pane-that-left-the-tree');

    expect(useLayoutStore.getState().focusedPaneId).toBe(basePane.id);
  });
});

describe('layout-store split pivot vs. the id it hands back', () => {
  const live: PaneModel = { id: 'pane-live', kind: 'shell', title: 'live' };

  beforeEach(() => {
    // Defense in depth: `splitPane` returns the tree UNCHANGED when the pivot
    // is not in it, and the caller spawns a PTY on the returned id — so the id
    // must never name a pane that was not inserted. Seeded raw because the
    // store itself may no longer produce a phantom focus.
    seedPreInvariantLayout({
      root: buildGridTree([live]),
      focusedPaneId: 'pane-that-left-the-tree',
      maximizedPaneId: null,
      hydrated: true,
      viewKind: 'grid',
      canvasNodeLayouts: {},
      canvasViewport: { x: 0, y: 0, zoom: 1 },
    });
  });

  it('addShellPane never returns the id of a pane it failed to insert', () => {
    const paneId = useLayoutStore.getState().addShellPane();

    expect(
      listPanes(useLayoutStore.getState().root).map((pane) => pane.id),
    ).toContain(paneId);
  });

  it('addBrowserPane never returns the id of a pane it failed to insert', () => {
    const paneId = useLayoutStore.getState().addBrowserPane('about:blank');

    expect(
      listPanes(useLayoutStore.getState().root).map((pane) => pane.id),
    ).toContain(paneId);
  });
});

describe('layout-store persistence key vs. the tree it owns', () => {
  it('never writes the outgoing tree under the incoming workspace key', async () => {
    const save = vi.fn(
      async (_workspacePath: string, _layout: WorkspaceLayout) => undefined,
    );
    let releaseLoad: () => void = () => undefined;
    const load = vi.fn(async (path: string) => {
      if (path === '/workspace/b') {
        await new Promise<void>((resolve) => {
          releaseLoad = resolve;
        });
      }
      return null;
    });
    vi.stubGlobal('window', {
      nexus: { layout: { load, save, saveSync: vi.fn() } },
    });

    await switchWorkspaceLayout('/workspace/a');
    expect(useLayoutStore.getState().hydrated).toBe(true);

    // The switch adopts the new persistence key BEFORE the load resolves; the
    // tree in memory is still A's. An operator action in that window must not
    // be saved as B's workspace composition.
    const switching = switchWorkspaceLayout('/workspace/b');
    useLayoutStore.getState().addShellPane();
    await new Promise((resolve) => setTimeout(resolve, 350));

    expect(save.mock.calls.map(([path]) => path)).not.toContain('/workspace/b');

    releaseLoad();
    await switching;
  });
});

describe('layout-store test fixtures go through the seam', () => {
  it('seedLayout cannot install a state the store forbids', () => {
    const placeholder: PaneModel = {
      id: 'pane-vacancy',
      kind: 'shell',
      title: 'shell',
      isStructuralPlaceholder: true,
    };
    const agent: PaneModel = {
      id: 'pane-agent',
      kind: 'cli-agent',
      title: 'orq',
      adapterId: 'codex',
    };

    seedLayout({
      root: buildGridTree([placeholder, agent]),
      focusedPaneId: placeholder.id,
      maximizedPaneId: null,
      hydrated: true,
      viewKind: 'grid',
      canvasNodeLayouts: {},
      canvasViewport: { x: 0, y: 0, zoom: 1 },
    });

    expect(
      listPanes(useLayoutStore.getState().root).map((pane) => pane.id),
    ).toEqual(['pane-agent']);
    expect(useLayoutStore.getState().focusedPaneId).toBe('pane-agent');
  });
});

describe('layout-store reclaimAsOperatorShell', () => {
  it('converts a dead mission agent pane into a plain shell', () => {
    const agent: PaneModel = {
      id: 'pane-maestro',
      kind: 'cli-agent',
      title: 'Maestro',
      adapterId: 'claude',
      model: 'sonnet',
      role: 'orchestrator',
      missionId: 'mission-dead',
      agentName: 'Maestro',
    };
    seedLayout({
      root: buildGridTree([agent]),
      focusedPaneId: agent.id,
      maximizedPaneId: null,
      hydrated: true,
      viewKind: 'grid',
      canvasNodeLayouts: {},
      canvasViewport: { x: 0, y: 0, zoom: 1 },
    });

    const reclaimed = useLayoutStore
      .getState()
      .reclaimAsOperatorShell(agent.id);

    expect(reclaimed).toMatchObject({
      id: 'pane-maestro',
      kind: 'shell',
      title: 'shell',
    });
    expect(reclaimed?.adapterId).toBeUndefined();
    expect(reclaimed?.missionId).toBeUndefined();
    expect(reclaimed?.role).toBeUndefined();
    expect(listPanes(useLayoutStore.getState().root)[0]?.kind).toBe('shell');
  });
});
