import { useOrchStore } from './orch-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneModel, WorkspaceLayout } from '../../shared/types';
import { paneScopeResolver } from '../lib/pane-spaces';
import {
  buildGridTree,
  initialTree,
  isStructuralPlaceholderPane,
  listPanes,
  MAX_LIVE_PANES_SOFT,
  updatePane,
} from '../lib/split-tree';
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

  it('mantém o pane maximizado em foco quando a orquestração abre um novo pane (F-521)', () => {
    useLayoutStore.getState().toggleMaximizePane('pane-a');

    const workerId = useLayoutStore.getState().spawnOrchPane({
      orchRequestId: 'req-focus-1',
      paneId: 'pane-worker',
      adapterId: 'codex',
      model: 'gpt-5.6-sol',
      title: 'Worker 1',
      missionId: 'm-focus',
      role: 'worker',
    });

    expect(workerId).toBe('pane-worker');
    expect(listPanes(useLayoutStore.getState().root).map((pane) => pane.id)).toEqual(
      expect.arrayContaining(['pane-a', 'pane-b', 'pane-worker']),
    );
    // O orquestrador maximizado permanece em foco — o worker entra no grid
    // por trás, sem roubar o zoom.
    expect(useLayoutStore.getState().maximizedPaneId).toBe('pane-a');
    expect(useLayoutStore.getState().focusedPaneId).toBe('pane-a');
  });

  it('mantém o foco do operador quando um agente abre um worker de fundo', () => {
    // O operador trabalha em pane-b; o orquestrador (pane-a) abre um helper.
    // O TerminalWorkspace segue focusedPaneId até a aba do pane, então foco
    // roubado aqui tirava o operador da aba em que ele estava.
    useLayoutStore.getState().focus('pane-b');

    const workerId = useLayoutStore.getState().spawnOrchPane({
      orchRequestId: 'req-focus-2',
      paneId: 'pane-worker-2',
      adapterId: 'codex',
      title: 'Worker 2',
      role: 'worker',
      parentPaneId: 'pane-a',
    });

    expect(listPanes(useLayoutStore.getState().root).map((pane) => pane.id)).toContain(workerId);
    expect(useLayoutStore.getState().focusedPaneId).toBe('pane-b');
    expect(useLayoutStore.getState().maximizedPaneId).toBeNull();
  });

  it('foca o novo orquestrador quando não há maximize ativo', () => {
    const orchestratorId = useLayoutStore.getState().spawnOrchPane({
      orchRequestId: 'req-focus-3',
      paneId: 'pane-orchestrator-3',
      adapterId: 'codex',
      title: 'Orquestrador',
      missionId: 'm-focus-3',
      role: 'orchestrator',
    });

    expect(useLayoutStore.getState().focusedPaneId).toBe(orchestratorId);
    expect(useLayoutStore.getState().maximizedPaneId).toBeNull();
  });

  it('toggles stageFocusMode on and off when multiple panes exist', () => {
    expect(useLayoutStore.getState().stageFocusMode).toBe(false);

    useLayoutStore.getState().toggleStageFocus('pane-b');
    expect(useLayoutStore.getState().stageFocusMode).toBe(true);
    expect(useLayoutStore.getState().focusedPaneId).toBe('pane-b');

    useLayoutStore.getState().toggleStageFocus();
    expect(useLayoutStore.getState().stageFocusMode).toBe(false);
  });

  it('clears stageFocusMode when closing leaves only one pane', () => {
    useLayoutStore.getState().toggleStageFocus('pane-b');
    expect(useLayoutStore.getState().stageFocusMode).toBe(true);

    useLayoutStore.getState().close('pane-b', 'test');
    expect(useLayoutStore.getState().stageFocusMode).toBe(false);
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

  it('setPanes preserva o pane focado atual se ele continuar na lista de panes', () => {
    useLayoutStore.getState().setPanes([shell, orch]);
    useLayoutStore.getState().focus(orch.id);
    expect(useLayoutStore.getState().focusedPaneId).toBe(orch.id);

    // Atualização de panes com worker adicional não rouba o foco do orquestrador
    useLayoutStore.getState().setPanes([shell, orch, worker]);
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
    const crashedLayout: WorkspaceLayout = {
      root: buildGridTree([durable, transient, legacy]),
      focusedPaneId: legacy.id,
    };

    const sanitized = sanitizeWorkspaceLayout(crashedLayout);
    expect(listPanes(sanitized.root).map((pane) => pane.id)).toEqual([
      durable.id,
    ]);
    expect(sanitized.focusedPaneId).toBe(durable.id);

    const onlyLegacyLayout: WorkspaceLayout = {
      root: buildGridTree([legacy]),
      focusedPaneId: legacy.id,
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

  it('F-521: mantém o zoom quando o write monta um pane novo (worker entra atrás do orquestrador em foco)', () => {
    const next = enforceLayoutInvariants(
      { root: buildGridTree([agent]), focusedPaneId: 'pane-agent', maximizedPaneId: 'pane-agent' },
      { root: buildGridTree([agent, { ...agent, id: 'pane-worker', missionId: 'mission-1' }]) },
    );
    // Política invertida em 2026-09-14: panes de orquestração abrem POR TRÁS
    // do pane maximizado — derrubar o zoom punia o operador em modo foco.
    expect(next.maximizedPaneId).toBe('pane-agent');
  });

  it('F-521: encerra o zoom quando o write pede explicitamente (foco deliberado no pane novo)', () => {
    const next = enforceLayoutInvariants(
      { root: buildGridTree([agent]), focusedPaneId: 'pane-agent', maximizedPaneId: 'pane-agent' },
      {
        root: buildGridTree([agent, { ...agent, id: 'pane-worker', missionId: 'mission-1' }]),
        focusedPaneId: 'pane-worker',
        maximizedPaneId: null,
      },
    );
    expect(next.maximizedPaneId).toBeNull();
    expect(next.focusedPaneId).toBe('pane-worker');
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

  it('spawnAgent never returns the id of a pane it failed to insert', () => {
    const paneId = useLayoutStore.getState().spawnAgent('claude', 'opus');

    expect(paneId).toBeDefined();
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

  it('não grava a árvore que sobrou quando o load vence a corrida da debounce', async () => {
    // A ordenação perigosa é a NORMAL: `layout.load` é SQLite + IPC local e
    // resolve em milissegundos, bem antes dos 300 ms da debounce. O teste
    // acima prende o load e só o libera DEPOIS da debounce — cobre a ordenação
    // segura, por isso passa sem proteger nada.
    //
    // Aqui o load resolve rápido: o ramo `treeVersion !== versionAtStart`
    // carimba `layoutWorkspacePath = '/workspace/b'` SEM hidratar (a árvore
    // viva ainda é a de A) e, 300 ms depois, a debounce grava os panes de A
    // sob a chave de B. É o "pane fantasma": terminal de um workspace
    // aparecendo dentro de outro.
    const save = vi.fn(
      async (_workspacePath: string, _layout: WorkspaceLayout) => undefined,
    );
    const load = vi.fn(async (path: string) => {
      if (path === '/workspace/b') {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return null;
    });
    vi.stubGlobal('window', {
      nexus: { layout: { load, save, saveSync: vi.fn() } },
    });

    await switchWorkspaceLayout('/workspace/a');
    expect(useLayoutStore.getState().hydrated).toBe(true);

    const switching = switchWorkspaceLayout('/workspace/b');
    const paneDeA = useLayoutStore.getState().addShellPane();
    await new Promise((resolve) => setTimeout(resolve, 400));
    await switching;

    // O invariante é sobre o CONTEÚDO, não sobre a chamada: gravar sob B é
    // legítimo depois que a posse é do B. Gravar os PANES DE A sob B, não.
    const idsDeA = new Set([paneDeA]);
    for (const [path, layout] of save.mock.calls) {
      if (path !== '/workspace/b') continue;
      for (const pane of listPanes(layout.root)) {
        expect(idsDeA.has(pane.id)).toBe(false);
      }
    }
  });

  it('não deixa a persistência do workspace novo presa depois da corrida', async () => {
    // Denunciar a posse sem restabelecê-la faz `ownsPersistedLayout` dar false
    // para sempre, e aí `persist`/`flushLayout` PULAM toda gravação deste
    // workspace — o operador perderia os terminais dele em silêncio, que é
    // exatamente o sintoma que estamos consertando.
    const save = vi.fn(
      async (_workspacePath: string, _layout: WorkspaceLayout) => undefined,
    );
    const load = vi.fn(async (path: string) => {
      if (path === '/workspace/b') {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return null;
    });
    vi.stubGlobal('window', {
      nexus: { layout: { load, save, saveSync: vi.fn() } },
    });

    await switchWorkspaceLayout('/workspace/a');
    const switching = switchWorkspaceLayout('/workspace/b');
    useLayoutStore.getState().addShellPane();
    await new Promise((resolve) => setTimeout(resolve, 400));
    await switching;

    // Uma mutação NOVA, já fora da janela da troca, tem de voltar a gravar.
    save.mockClear();
    useLayoutStore.getState().addShellPane();
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(save.mock.calls.map(([path]) => path)).toContain('/workspace/b');
  });

  it('a missão do workspace que SAI nunca atravessa para o que entra', async () => {
    // Campo 23/09: missão de um projeto aparecendo no grid de outro. Basta
    // QUALQUER mutação da árvore cair durante a leitura do layout de B (um
    // pane fechando, um spawn) para o ramo da corrida hidratar B carregando
    // os panes de missão da árvore viva — e a árvore viva ainda é a de A.
    const missionPaneA: PaneModel = {
      id: 'pane-mission-a',
      kind: 'cli-agent',
      title: 'orquestrador de A',
      adapterId: 'claude',
      missionId: 'mission-a',
      role: 'orchestrator',
    };
    const layoutA: WorkspaceLayout = {
      root: buildGridTree([missionPaneA]),
      focusedPaneId: missionPaneA.id,
    };
    let releaseB: () => void = () => undefined;
    const load = vi.fn(async (path: string) => {
      if (path === '/workspace/a') return layoutA;
      await new Promise<void>((resolve) => {
        releaseB = resolve;
      });
      return null;
    });
    vi.stubGlobal('window', {
      nexus: { layout: { load, save: vi.fn(async () => undefined), saveSync: vi.fn() } },
    });

    await switchWorkspaceLayout('/workspace/a');
    expect(
      listPanes(useLayoutStore.getState().root).map((pane) => pane.id),
    ).toContain(missionPaneA.id);

    const switching = switchWorkspaceLayout('/workspace/b');
    // A missão lançada em B durante a leitura é a razão de ser do ramo: ela
    // tem de sobreviver à hidratação de B.
    useLayoutStore.getState().spawnOrchPane({
      paneId: 'pane-mission-b',
      adapterId: 'claude',
      title: 'orquestrador de B',
      orchRequestId: 'orchspawn-mission-b',
      missionId: 'mission-b',
      role: 'orchestrator',
    });
    releaseB();
    await switching;

    const idsInB = listPanes(useLayoutStore.getState().root).map(
      (pane) => pane.id,
    );
    expect(idsInB).not.toContain(missionPaneA.id);
    expect(idsInB).toContain('pane-mission-b');
    expect(useLayoutStore.getState().focusedPaneId).not.toBe(missionPaneA.id);
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

/**
 * NÚMERO do pane através do store: atribuição na criação, sobrevivência ao
 * restart (hidratação), e a ausência de duplicata numa mistura de criar/fechar.
 *
 * A identidade continua sendo o `id` — o número é adição. Estes testes existem
 * porque o modo de falha que importa é falar "pane 5" e acertar outro pane.
 */
describe('layout-store números de pane', () => {
  function numbersOf(): (number | undefined)[] {
    return listPanes(useLayoutStore.getState().root).map(
      (pane) => pane.paneNumber,
    );
  }

  beforeEach(() => {
    useLayoutStore.getState().hydrate(null);
  });

  it('workspace novo numera a partir de 1', () => {
    // Compara CONJUNTO, não sequência: `numbersOf` devolve a ordem do layout, e
    // um split insere o pane novo no meio da árvore. Número é identidade;
    // posição é o ⌘1-9, que é outro namespace.
    expect(numbersOf()).toEqual([1]);
    useLayoutStore.getState().addShellPane();
    useLayoutStore.getState().addShellPane();
    expect([...numbersOf()].sort()).toEqual([1, 2, 3]);
  });

  it('todo pane criado recebe número, e nunca dois iguais', () => {
    const store = useLayoutStore.getState();
    store.addShellPane();
    store.spawnAgent('codex', 'gpt-5');
    store.addBrowserPane('https://example.com');
    const numbers = numbersOf();
    expect(numbers.every((value) => typeof value === 'number')).toBe(true);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('o número persistido volta ao MESMO pane depois do restart', () => {
    // Layout como o disco o guardou: números fora de ordem, de propósito.
    const saved: WorkspaceLayout = {
      root: buildGridTree([
        { id: 'pane-x', kind: 'shell', title: 'x', paneNumber: 3 },
        { id: 'pane-y', kind: 'shell', title: 'y', paneNumber: 1 },
      ]),
      focusedPaneId: 'pane-x',
    };
    useLayoutStore.getState().hydrate(saved);
    const panes = listPanes(useLayoutStore.getState().root);
    expect(panes.find((pane) => pane.id === 'pane-x')?.paneNumber).toBe(3);
    expect(panes.find((pane) => pane.id === 'pane-y')?.paneNumber).toBe(1);
  });

  it('layout antigo SEM número abre normal e recebe o menor livre', () => {
    // Workspace gravado por versão anterior à numeração: nada pode quebrar.
    const legacy: WorkspaceLayout = {
      root: buildGridTree([
        { id: 'pane-legado-a', kind: 'shell', title: 'a' },
        { id: 'pane-legado-b', kind: 'shell', title: 'b' },
      ]),
      focusedPaneId: null,
    };
    useLayoutStore.getState().hydrate(legacy);
    const panes = listPanes(useLayoutStore.getState().root);
    expect(panes).toHaveLength(2);
    expect(panes.map((pane) => pane.paneNumber).sort()).toEqual([1, 2]);
  });

  it('mistura de criar e fechar não duplica número e reusa o menor livre', () => {
    const first = useLayoutStore.getState().addShellPane();
    const second = useLayoutStore.getState().addShellPane();
    expect([...numbersOf()].sort()).toEqual([1, 2, 3]);
    useLayoutStore.getState().close(second, 'test');
    useLayoutStore.getState().close(first, 'test');
    const numbers = numbersOf();
    expect(new Set(numbers).size).toBe(numbers.length);
    // Os números 2 e 3 voltaram para a fila: o próximo pane pega o menor.
    useLayoutStore.getState().addShellPane();
    const after = numbersOf();
    expect(new Set(after).size).toBe(after.length);
    expect(Math.min(...(after as number[]))).toBe(1);
    expect(after).toContain(2);
  });

  it('hidratar outro workspace não deixa vazar os números do anterior', () => {
    useLayoutStore.getState().hydrate({
      root: buildGridTree([
        { id: 'pane-antigo', kind: 'shell', title: 'antigo', paneNumber: 9 },
      ]),
      focusedPaneId: null,
    });
    expect(numbersOf()).toEqual([9]);
    useLayoutStore.getState().hydrate({
      root: buildGridTree([{ id: 'pane-novo', kind: 'shell', title: 'novo' }]),
      focusedPaneId: null,
    });
    expect(numbersOf()).toEqual([1]);
  });
});

describe('layout-store spawnAgent continuity', () => {
  beforeEach(() => {
    useLayoutStore.getState().hydrate(null);
  });

  it('stashes the handoff pack on the new pane without binding missionId', async () => {
    const { takePendingContinuity } = await import(
      '../orch/stranded-mission-handoff'
    );
    const paneId = useLayoutStore.getState().spawnAgent('claude', 'opus', {
      accountId: 'acc-good',
      continuityPack: '[NEXUS FAILOVER HANDOFF]\ncontinue Radar BI',
    });
    expect(paneId).toBeTruthy();
    const pane = listPanes(useLayoutStore.getState().root).find(
      (candidate) => candidate.id === paneId,
    );
    expect(pane?.accountId).toBe('acc-good');
    expect(pane?.missionId).toBeUndefined();
    expect(takePendingContinuity(paneId!)).toContain('Radar BI');
    expect(takePendingContinuity(paneId!)).toBeUndefined();
  });
});

describe('layout-store role assignment and promotion', () => {
  it('setPaneRole turns the target pane into orchestrator and others into worker', () => {
    const pane1: PaneModel = { id: 'p1', kind: 'shell', title: 'term 1' };
    const pane2: PaneModel = { id: 'p2', kind: 'shell', title: 'term 2' };
    seedLayout({
      root: buildGridTree([pane1, pane2]),
      focusedPaneId: pane1.id,
      maximizedPaneId: null,
      hydrated: true,
    });

    useLayoutStore.getState().setPaneRole('p1', 'orchestrator');
    let panes = listPanes(useLayoutStore.getState().root);
    expect(panes.find((p) => p.id === 'p1')?.role).toBe('orchestrator');

    // Promove p2: p2 vira orchestrator e p1 vira worker
    useLayoutStore.getState().setPaneRole('p2', 'orchestrator');
    panes = listPanes(useLayoutStore.getState().root);
    expect(panes.find((p) => p.id === 'p2')?.role).toBe('orchestrator');
    expect(panes.find((p) => p.id === 'p1')?.role).toBe('worker');
  });

  it('setPaneRole na aba B não rebaixa o orquestrador da aba A', () => {
    // Campo 27/09: "tornar orquestrador" num terminal de outra aba trocava o
    // orquestrador geral. Cada aba tem o seu coordenador.
    useOrchStore.setState({ paneMissions: {} });
    seedLayout({
      root: buildGridTree([
        { id: 'a1', kind: 'cli-agent', title: 'A1', spaceId: 'space-a', spaceTitle: 'A' },
        { id: 'a2', kind: 'cli-agent', title: 'A2', spaceId: 'space-a', spaceTitle: 'A' },
        { id: 'b1', kind: 'cli-agent', title: 'B1', spaceId: 'space-b', spaceTitle: 'B' },
      ]),
      focusedPaneId: 'a1',
      maximizedPaneId: null,
      hydrated: true,
    });

    useLayoutStore.getState().setPaneRole('a1', 'orchestrator');
    useLayoutStore.getState().setPaneRole('b1', 'orchestrator');
    let roles = new Map(listPanes(useLayoutStore.getState().root).map((p) => [p.id, p.role]));
    expect(roles.get('a1')).toBe('orchestrator');
    expect(roles.get('b1')).toBe('orchestrator');

    // Dentro da MESMA aba continua uma coroa só.
    useLayoutStore.getState().setPaneRole('a2', 'orchestrator');
    roles = new Map(listPanes(useLayoutStore.getState().root).map((p) => [p.id, p.role]));
    expect(roles.get('a2')).toBe('orchestrator');
    expect(roles.get('a1')).toBe('worker');
    expect(roles.get('b1')).toBe('orchestrator');
  });

  it('missão leve adotada na aba B tira a coroa local da B e mantém a da A', () => {
    useOrchStore.setState({ paneMissions: {} });
    seedLayout({
      root: buildGridTree([
        { id: 'a1', kind: 'cli-agent', title: 'A1', spaceId: 'space-a', spaceTitle: 'A', role: 'orchestrator' },
        { id: 'b1', kind: 'cli-agent', title: 'B1', spaceId: 'space-b', spaceTitle: 'B', role: 'orchestrator' },
        { id: 'b2', kind: 'cli-agent', title: 'B2', spaceId: 'space-b', spaceTitle: 'B' },
      ]),
      focusedPaneId: 'b2',
      maximizedPaneId: null,
      hydrated: true,
    });

    useLayoutStore.getState().promoteMissionPaneRole('mB', 'b2');

    const roles = new Map(listPanes(useLayoutStore.getState().root).map((p) => [p.id, p.role]));
    expect(roles.get('b2')).toBe('orchestrator');
    expect(roles.get('b1')).toBe('worker');
    expect(roles.get('a1')).toBe('orchestrator');
  });

  it('missão criada pelo Main (broadcast vincula antes de refletir) também tira a coroa local', () => {
    useOrchStore.setState({ paneMissions: { b2: 'mB' } });
    seedLayout({
      root: buildGridTree([
        { id: 'b1', kind: 'cli-agent', title: 'B1', spaceId: 'space-b', spaceTitle: 'B', role: 'orchestrator' },
        { id: 'b2', kind: 'cli-agent', title: 'B2', spaceId: 'space-b', spaceTitle: 'B' },
      ]),
      focusedPaneId: 'b2',
      maximizedPaneId: null,
      hydrated: true,
    });

    useLayoutStore.getState().reflectMissionLeader('mB', 'b2');

    const panes = new Map(listPanes(useLayoutStore.getState().root).map((p) => [p.id, p]));
    expect(panes.get('b2')).toMatchObject({ role: 'orchestrator', missionId: 'mB', missionHost: true });
    expect(panes.get('b1')?.role).toBe('worker');
  });

  it('coroar um pane solto não o faz migrar para a aba de outro coordenador', () => {
    useOrchStore.setState({ paneMissions: {} });
    seedLayout({
      root: buildGridTree([
        { id: 'a1', kind: 'cli-agent', title: 'A1', spaceId: 'space-a', spaceTitle: 'A', role: 'orchestrator' },
        { id: 'b1', kind: 'cli-agent', title: 'B1', spaceId: 'space-b', spaceTitle: 'B', role: 'orchestrator' },
        { id: 'solto', kind: 'cli-agent', title: 'Solto' },
        { id: 'solto2', kind: 'shell', title: 'Shell' },
      ]),
      focusedPaneId: 'solto',
      maximizedPaneId: null,
      hydrated: true,
    });
    const scopeNow = () => {
      const panes = listPanes(useLayoutStore.getState().root);
      const scopeOf = paneScopeResolver(panes, {});
      return new Map(panes.map((p) => [p.id, scopeOf(p)]));
    };
    expect(scopeNow().get('solto')).toBe('space:space-a');

    useLayoutStore.getState().setPaneRole('solto', 'orchestrator');

    const scopes = scopeNow();
    expect(scopes.get('solto')).toBe('space:space-a');
    expect(scopes.get('solto2')).toBe('space:space-a');
    const roles = new Map(listPanes(useLayoutStore.getState().root).map((p) => [p.id, p.role]));
    expect(roles.get('a1')).toBe('worker');
    expect(roles.get('b1')).toBe('orchestrator');
  });

  it('helper do orquestrador da missão da aba B nasce na B sem tirar o foco da A', () => {
    useOrchStore.setState({ paneMissions: { b1: 'mB' } });
    seedLayout({
      root: buildGridTree([
        { id: 'a1', kind: 'cli-agent', title: 'A1', spaceId: 'space-a', spaceTitle: 'A', role: 'orchestrator' },
        {
          id: 'b1', kind: 'cli-agent', title: 'B1', spaceId: 'space-b', spaceTitle: 'B',
          missionId: 'mB', missionHost: true, role: 'orchestrator',
        },
      ]),
      focusedPaneId: 'a1',
      maximizedPaneId: null,
      hydrated: true,
    });

    useLayoutStore.getState().spawnOrchPane({
      paneId: 'b-helper',
      adapterId: 'codex',
      orchRequestId: 'req-b',
      missionId: 'mB',
      role: 'worker',
      parentPaneId: 'b1',
    });

    const state = useLayoutStore.getState();
    expect(state.focusedPaneId).toBe('a1');
    const panes = listPanes(state.root);
    const scopeOf = paneScopeResolver(panes, useOrchStore.getState().paneMissions);
    const helper = panes.find((p) => p.id === 'b-helper')!;
    expect(scopeOf(helper)).toBe('space:space-b');
    expect(panes.find((p) => p.id === 'a1')?.role).toBe('orchestrator');
    expect(panes.find((p) => p.id === 'b1')?.role).toBe('orchestrator');
  });

  it('promoteMissionPaneRole binds missionId and promotes target', () => {
    const pane1: PaneModel = { id: 'p1', kind: 'cli-agent', title: 'agent 1' };
    const pane2: PaneModel = { id: 'p2', kind: 'cli-agent', title: 'agent 2' };
    seedLayout({
      root: buildGridTree([pane1, pane2]),
      focusedPaneId: pane1.id,
      maximizedPaneId: null,
      hydrated: true,
    });

    useLayoutStore.getState().promoteMissionPaneRole('mission-alpha', 'p1');
    const panes = listPanes(useLayoutStore.getState().root);
    const p1 = panes.find((p) => p.id === 'p1');
    expect(p1?.role).toBe('orchestrator');
    expect(p1?.missionId).toBe('mission-alpha');
  });
});

// ── F-527: promoção não contamina panes fora da missão ───────────────────────

describe('promoteMissionPaneRole — isolamento entre missões (F-527)', () => {
  it('não rebaixa nem re-rotula panes sem vínculo ou de outra missão', () => {
    useLayoutStore.setState({
      root: buildGridTree([
        {
          id: 'pane-m1-orch',
          kind: 'cli-agent',
          title: 'Orquestrador M1',
          adapterId: 'codex',
          missionId: 'mission-1',
          role: 'orchestrator',
        },
        {
          id: 'pane-m1-worker',
          kind: 'cli-agent',
          title: 'Worker M1',
          adapterId: 'codex',
          missionId: 'mission-1',
          role: 'worker',
        },
        {
          id: 'pane-m2-worker',
          kind: 'cli-agent',
          title: 'Worker M2',
          adapterId: 'agy',
          missionId: 'mission-2',
          role: 'orchestrator',
        },
        {
          id: 'pane-solto',
          kind: 'shell',
          title: 'Shell do operador',
        },
      ]),
    });

    useLayoutStore.getState().promoteMissionPaneRole('mission-1', 'pane-m1-worker');

    const panes = new Map(
      listPanes(useLayoutStore.getState().root).map((p) => [p.id, p]),
    );
    // Missão 1: promovido vira orquestrador; o orquestrador anterior cai a worker.
    expect(panes.get('pane-m1-worker')?.role).toBe('orchestrator');
    expect(panes.get('pane-m1-orch')?.role).toBe('worker');
    // Missão 2 intocada — o orquestrador dela NÃO é rebaixado.
    expect(panes.get('pane-m2-worker')?.role).toBe('orchestrator');
    expect(panes.get('pane-m2-worker')?.missionId).toBe('mission-2');
    // Pane solto intocado — nem role, nem vínculo inventado.
    expect(panes.get('pane-solto')?.role).toBeUndefined();
    expect(panes.get('pane-solto')?.missionId).toBeUndefined();
  });
});

describe('layout-store stage focus mode', () => {
  it('locks stagePaneId and allows promoting companion with setStagePane', () => {
    useLayoutStore.setState({
      root: buildGridTree([
        { id: 'pane-1', kind: 'shell', title: 'Main' },
        { id: 'pane-2', kind: 'shell', title: 'Worker' },
      ]),
      stageFocusMode: false,
      stagePaneId: null,
      focusedPaneId: 'pane-1',
    });

    useLayoutStore.getState().toggleStageFocus('pane-1');
    expect(useLayoutStore.getState().stageFocusMode).toBe(true);
    expect(useLayoutStore.getState().stagePaneId).toBe('pane-1');

    // Focando outro pane NÃO muda stagePaneId (evita swap involuntário e tremor)
    useLayoutStore.getState().focus('pane-2');
    expect(useLayoutStore.getState().focusedPaneId).toBe('pane-2');
    expect(useLayoutStore.getState().stagePaneId).toBe('pane-1');

    // Promoção deliberada via setStagePane
    useLayoutStore.getState().setStagePane('pane-2');
    expect(useLayoutStore.getState().stagePaneId).toBe('pane-2');
    expect(useLayoutStore.getState().focusedPaneId).toBe('pane-2');

    // Desligar stage focus limpa stagePaneId
    useLayoutStore.getState().toggleStageFocus();
    expect(useLayoutStore.getState().stageFocusMode).toBe(false);
    expect(useLayoutStore.getState().stagePaneId).toBeNull();
  });
});

// ── F-560: o ESPAÇO do operador acompanha o pane ────────────────────────────

describe('espaço do pane (F-560)', () => {
  it('persists a wizard mission space regardless of metadata arrival order and shares it with manual panes', () => {
    useLayoutStore.setState({ root: initialTree(), focusedPaneId: null, hydrated: true });
    const layout = useLayoutStore.getState();
    const host = layout.spawnOrchPane({ paneId: 'pane-wizard', adapterId: 'codex', missionId: 'mission-wizard', role: 'orchestrator', orchRequestId: 'request-wizard' });
    useOrchStore.setState({ missions: [{ id: 'mission-wizard', title: 'Nova entrega', intentContract: { workspaceBinding: { version: 1, spaceId: 'space-wizard' } } } as import('../../shared/orch-types').Mission] });
    const marked = listPanes(useLayoutStore.getState().root).find(p => p.id === host)!;
    expect(marked).toMatchObject({ spaceId: 'space-wizard', isolateSpace: true, missionHost: true });
    layout.split(host, 'row');
    const manual = layout.addShellPane();
    layout.assignPaneSpace(manual, 'space-wizard', 'Nova entrega');
    const members = listPanes(useLayoutStore.getState().root).filter(p => p.spaceId === 'space-wizard');
    expect(members).toHaveLength(3);
    expect(members.every(p => p.isolateSpace)).toBe(true);
    expect(members.filter(p => p.id !== host).every(p => !p.missionId)).toBe(true);
    useOrchStore.setState({ missions: [] });
  });

  it('new isolated tabs pass isolation to added/split panes without migrating legacy tabs', () => {
    useLayoutStore.setState({ root: initialTree(), focusedPaneId: null, hydrated: true });
    const store = useLayoutStore.getState();
    const legacy = store.addShellPane();
    store.assignPaneSpace(legacy, 'space-legacy', 'Antiga');
    const first = store.addShellPane();
    store.assignPaneSpace(first, 'space-new', 'Nova', true);
    const extra = store.addShellPane();
    store.assignPaneSpace(extra, 'space-new', 'Nova');
    store.split(first, 'row');
    const panes = listPanes(useLayoutStore.getState().root);
    expect(panes.find(p => p.id === legacy)?.isolateSpace).toBeUndefined();
    expect(panes.filter(p => p.spaceId === 'space-new')).toHaveLength(3);
    expect(panes.filter(p => p.spaceId === 'space-new').every(p => p.isolateSpace)).toBe(true);
  });
  beforeEach(() => {
    useLayoutStore.setState({
      root: initialTree(),
      focusedPaneId: null,
      maximizedPaneId: null,
      hydrated: true,
    });
  });

  it('assignPaneSpace carimba o pane solto', () => {
    const store = useLayoutStore.getState();
    const paneId = store.addShellPane();
    useLayoutStore.getState().assignPaneSpace(paneId, 'space-1', 'Meus terminais');

    const pane = listPanes(useLayoutStore.getState().root).find(
      (item) => item.id === paneId,
    );
    expect(pane?.spaceId).toBe('space-1');
    expect(pane?.spaceTitle).toBe('Meus terminais');
  });

  it('assignPaneSpace NÃO rouba um pane que já pertence a uma missão', () => {
    const paneId = useLayoutStore.getState().addShellPane();
    useLayoutStore.setState({
      root: updatePane(useLayoutStore.getState().root, paneId, {
        missionId: 'mission-1',
      }),
    });

    useLayoutStore.getState().assignPaneSpace(paneId, 'space-1', 'Meus terminais');

    const pane = listPanes(useLayoutStore.getState().root).find(
      (item) => item.id === paneId,
    );
    expect(pane?.missionId).toBe('mission-1');
    expect(pane?.spaceId).toBeUndefined();
  });

  it('dividir um pane de espaço mantém o irmão no MESMO espaço', () => {
    const paneId = useLayoutStore.getState().addShellPane();
    useLayoutStore.getState().assignPaneSpace(paneId, 'space-1', 'Meus terminais 2');

    useLayoutStore.getState().split(paneId, 'row');

    const panes = listPanes(useLayoutStore.getState().root);
    const created = panes.filter((pane) => pane.spaceId === 'space-1');
    expect(created).toHaveLength(2);
    expect(
      created.every((pane) => pane.spaceTitle === 'Meus terminais 2'),
    ).toBe(true);
  });

  it('dividir um pane de missão não inventa espaço nenhum', () => {
    const paneId = useLayoutStore.getState().addShellPane();
    useLayoutStore.setState({
      root: updatePane(useLayoutStore.getState().root, paneId, {
        missionId: 'mission-1',
        spaceId: 'space-antigo',
      }),
    });

    useLayoutStore.getState().split(paneId, 'row');

    const created = listPanes(useLayoutStore.getState().root).filter(
      (pane) => pane.id !== paneId && !isStructuralPlaceholderPane(pane),
    );
    expect(created.every((pane) => pane.spaceId === undefined)).toBe(true);
  });
});

describe('split não herda espaço de pane com vínculo OBSERVADO de missão (F-560)', () => {
  it('pane em paneMissions é tratado como missão, o irmão não herda o espaço', async () => {
    const { useOrchStore } = await import('./orch-store');
    useLayoutStore.setState({
      root: initialTree(),
      focusedPaneId: null,
      maximizedPaneId: null,
      hydrated: true,
    });
    const paneId = useLayoutStore.getState().addShellPane();
    useLayoutStore.setState({
      root: updatePane(useLayoutStore.getState().root, paneId, {
        spaceId: 'space-antigo',
        spaceTitle: 'Meus terminais',
      }),
    });
    useOrchStore.setState({ paneMissions: { [paneId]: 'mission-viva' } });

    useLayoutStore.getState().split(paneId, 'row');

    const sibling = listPanes(useLayoutStore.getState().root).find(
      (pane) => pane.id !== paneId && !isStructuralPlaceholderPane(pane),
    );
    expect(sibling?.spaceId).toBeUndefined();
    useOrchStore.setState({ paneMissions: {} });
  });
});

describe('renamePaneSpace — renomear a aba do espaço inteiro', () => {
  function seedSpace(): void {
    seedLayout({
      root: buildGridTree([
        {
          id: 'pane-1',
          kind: 'shell',
          title: 'Terminal 1',
          spaceId: 'space-1',
          spaceTitle: 'Meus terminais',
        },
        {
          id: 'pane-2',
          kind: 'shell',
          title: 'Terminal 2',
          spaceId: 'space-1',
          spaceTitle: 'Meus terminais',
        },
        {
          id: 'pane-outro',
          kind: 'shell',
          title: 'Outro',
          spaceId: 'space-2',
          spaceTitle: 'Meus terminais 2',
        },
      ]),
      focusedPaneId: 'pane-1',
      maximizedPaneId: null,
      hydrated: true,
    });
  }

  it('renomeia todos os panes carimbados com o espaço, sem tocar nos outros', () => {
    seedSpace();

    useLayoutStore.getState().renamePaneSpace('space-1', 'Build da API');

    const panes = listPanes(useLayoutStore.getState().root);
    const doEspaco = panes.filter((pane) => pane.spaceId === 'space-1');
    expect(doEspaco).toHaveLength(2);
    expect(doEspaco.every((pane) => pane.spaceTitle === 'Build da API')).toBe(
      true,
    );
    expect(
      panes.find((pane) => pane.spaceId === 'space-2')?.spaceTitle,
    ).toBe('Meus terminais 2');
  });

  it('pane adotado por missão não é recarimbado — a aba dele é a da missão', () => {
    seedSpace();
    useLayoutStore.setState({
      root: updatePane(useLayoutStore.getState().root, 'pane-1', {
        missionId: 'mission-1',
      }),
    });

    useLayoutStore.getState().renamePaneSpace('space-1', 'Build da API');

    const panes = listPanes(useLayoutStore.getState().root);
    expect(panes.find((pane) => pane.id === 'pane-1')?.spaceTitle).toBe(
      'Meus terminais',
    );
    expect(panes.find((pane) => pane.id === 'pane-2')?.spaceTitle).toBe(
      'Build da API',
    );
  });

  it('título vazio ou só espaços é ignorado', () => {
    seedSpace();

    useLayoutStore.getState().renamePaneSpace('space-1', '   ');

    const doEspaco = listPanes(useLayoutStore.getState().root).filter(
      (pane) => pane.spaceId === 'space-1',
    );
    expect(doEspaco.every((pane) => pane.spaceTitle === 'Meus terminais')).toBe(
      true,
    );
  });
});

describe('layout-store — a missão mora na aba do pane que a começou', () => {
  it('adotar um pane do operador como líder o marca anfitrião da missão', () => {
    const operatorPane: PaneModel = {
      id: 'pane-operador',
      kind: 'cli-agent',
      title: 'claude',
      adapterId: 'claude',
      spaceId: 'space-api',
      spaceTitle: 'API',
    };
    seedLayout({
      root: buildGridTree([operatorPane]),
      focusedPaneId: operatorPane.id,
      maximizedPaneId: null,
      hydrated: true,
    });

    useLayoutStore.getState().reflectMissionLeader('mission-epic', operatorPane.id);

    expect(listPanes(useLayoutStore.getState().root)[0]).toMatchObject({
      role: 'orchestrator',
      missionId: 'mission-epic',
      missionHost: true,
      spaceId: 'space-api',
    });
  });

  it('troca de coroa explícita devolve o anfitrião anterior à mão do operador na hora', () => {
    const hostA: PaneModel = {
      id: 'pane-a', kind: 'cli-agent', title: 'claude', adapterId: 'claude',
      spaceId: 'space-api', spaceTitle: 'API',
      role: 'orchestrator', missionId: 'mission-epic', missionHost: true,
    };
    const paneB: PaneModel = {
      id: 'pane-b', kind: 'cli-agent', title: 'codex', adapterId: 'codex',
      spaceId: 'space-api', spaceTitle: 'API',
    };
    const helper: PaneModel = {
      id: 'helper-a', kind: 'cli-agent', title: 'helper', adapterId: 'codex',
      role: 'worker', missionId: 'mission-epic',
    };
    useOrchStore.setState({ paneMissions: { 'pane-a': 'mission-epic', 'helper-a': 'mission-epic' } });
    seedLayout({
      root: buildGridTree([hostA, paneB, helper]),
      focusedPaneId: hostA.id,
      maximizedPaneId: null,
      hydrated: true,
    });

    useLayoutStore.getState().reflectMissionLeader('mission-epic', paneB.id);

    const byId = new Map(listPanes(useLayoutStore.getState().root).map((pane) => [pane.id, pane]));
    expect(byId.get('pane-b')).toMatchObject({ role: 'orchestrator', missionId: 'mission-epic', missionHost: true });
    const previous = byId.get('pane-a')!;
    expect(previous.role).toBeUndefined();
    expect(previous.missionId).toBeUndefined();
    expect(previous.missionHost).toBeUndefined();
    expect(previous.spaceId).toBe('space-api');
    expect(useOrchStore.getState().paneMissions['pane-a']).toBeUndefined();
    // O helper nascido na missão continua worker dela.
    expect(byId.get('helper-a')).toMatchObject({ role: 'worker', missionId: 'mission-epic' });
    useOrchStore.setState({ paneMissions: {} });
  });

  it('o pane que o motor abriu para a missão não hospeda nada', () => {
    const maestro: PaneModel = {
      id: 'pane-maestro',
      kind: 'cli-agent',
      title: 'Maestro',
      adapterId: 'codex',
      missionId: 'mission-epic',
      orchRequestId: 'orchspawn-1',
    };
    seedLayout({
      root: buildGridTree([maestro]),
      focusedPaneId: maestro.id,
      maximizedPaneId: null,
      hydrated: true,
    });

    useLayoutStore.getState().reflectMissionLeader('mission-epic', maestro.id);

    expect(listPanes(useLayoutStore.getState().root)[0]).not.toHaveProperty(
      'missionHost',
    );
  });

  it('dar nome à aba Terminais transforma os panes dela num espaço — anfitrião incluso', () => {
    const shell: PaneModel = { id: 'pane-shell', kind: 'shell', title: 'shell' };
    const host: PaneModel = {
      id: 'pane-host',
      kind: 'cli-agent',
      title: 'claude',
      role: 'orchestrator',
      missionId: 'mission-epic',
      missionHost: true,
    };
    const worker: PaneModel = {
      id: 'pane-worker',
      kind: 'cli-agent',
      title: 'codex',
      missionId: 'mission-epic',
    };
    const named: PaneModel = {
      id: 'pane-named',
      kind: 'shell',
      title: 'shell',
      spaceId: 'space-outro',
      spaceTitle: 'Outro',
    };
    seedLayout({
      root: buildGridTree([shell, host, worker, named]),
      focusedPaneId: shell.id,
      maximizedPaneId: null,
      hydrated: true,
    });

    expect(useLayoutStore.getState().nameLooseSpace('space-epic', '  Epic 22  ')).toBe(true);

    const byId = new Map(
      listPanes(useLayoutStore.getState().root).map((pane) => [pane.id, pane]),
    );
    expect(byId.get('pane-shell')).toMatchObject({ spaceId: 'space-epic', spaceTitle: 'Epic 22' });
    expect(byId.get('pane-host')).toMatchObject({ spaceId: 'space-epic', spaceTitle: 'Epic 22' });
    // O worker segue a casa da missão (o anfitrião) — não recebe carimbo.
    expect(byId.get('pane-worker')).not.toHaveProperty('spaceId');
    expect(byId.get('pane-named')).toMatchObject({ spaceId: 'space-outro' });
  });
});

describe('spawnOrchPane — helper nasce na aba do pai (C3/B1)', () => {
  beforeEach(() => {
    seedLayout({
      root: buildGridTree([
        { ...basePane, id: 'pane-parent', kind: 'cli-agent', spaceId: 'space-b', spaceTitle: 'Feature B' },
        { ...basePane, id: 'pane-other' },
      ]),
      focusedPaneId: 'pane-parent',
    });
  });

  it('herda spaceId/spaceTitle do pai e guarda a rota', () => {
    const id = useLayoutStore.getState().spawnOrchPane({
      orchRequestId: 'req-child',
      paneId: 'pane-child',
      adapterId: 'codex',
      parentPaneId: 'pane-parent',
      spawnRoute: { source: 'heuristic', jevUnavailable: 'no-key' },
    });
    const child = listPanes(useLayoutStore.getState().root).find((p) => p.id === id)!;
    expect(child).toMatchObject({
      spaceId: 'space-b',
      spaceTitle: 'Feature B',
      spawnRoute: { source: 'heuristic', jevUnavailable: 'no-key' },
    });
  });

  it('pai ausente: nasce como hoje (sem espaço)', () => {
    const id = useLayoutStore.getState().spawnOrchPane({
      orchRequestId: 'req-orphan',
      paneId: 'pane-orphan',
      adapterId: 'codex',
      parentPaneId: 'pane-gone',
    });
    const child = listPanes(useLayoutStore.getState().root).find((p) => p.id === id)!;
    expect(child.spaceId).toBeUndefined();
  });

  it('pai de missão não passa espaço; pane de missão nunca herda', () => {
    seedLayout({
      root: buildGridTree([
        { ...basePane, id: 'pane-parent', kind: 'cli-agent', missionId: 'm1', spaceId: 'space-old' },
      ]),
      focusedPaneId: 'pane-parent',
    });
    const id = useLayoutStore.getState().spawnOrchPane({
      orchRequestId: 'req-m',
      paneId: 'pane-m',
      adapterId: 'codex',
      parentPaneId: 'pane-parent',
    });
    expect(listPanes(useLayoutStore.getState().root).find((p) => p.id === id)!.spaceId).toBeUndefined();
  });

  it('spawnRoute não sobrevive ao schema persistido', async () => {
    const { layoutNodeSchema } = await import('../../shared/ipc');
    const parsed = layoutNodeSchema.parse({
      kind: 'leaf',
      id: 'n1',
      pane: { id: 'p', kind: 'cli-agent', title: 't', spawnRoute: { source: 'jev' } },
    }) as unknown as { pane: Record<string, unknown> };
    expect(parsed.pane.spawnRoute).toBeUndefined();
  });
});
