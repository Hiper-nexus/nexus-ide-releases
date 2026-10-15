/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAccessStore } from '../state/access-store';
import { useGamificationStore } from '../state/gamification-store';
import type { Mission } from '../../shared/orch-types';
import type { PaneModel, WorkspaceLayout } from '../../shared/types';
import { buildGridTree, listPanes } from '../lib/split-tree';
import { setActiveWorkspacePath } from '../state/active-workspace';
import {
  detachWorkspaceLayout,
  flushLayout,
  setTerminalSnapshotProvider,
  switchWorkspaceLayout,
  useLayoutStore,
} from '../state/layout-store';
import { useOrchStore } from '../state/orch-store';
import { useMissionInspectorStore } from '../state/mission-inspector-store';
import { useProductNavigationStore } from '../state/product-navigation-store';
import { PaneGrid } from './PaneGrid';

/**
 * THE DEFECT UNDER TEST — the fifth return of "an empty pane covering the
 * mission".
 *
 * I1 says a placeholder never COEXISTS with real content. This state satisfies
 * it: the tree holds exactly one node and it IS the placeholder. So the rule
 * is silent, and the vacancy legitimately owns the whole screen.
 *
 * What makes it read as WORK rather than as a vacancy is everything the
 * `kind: 'shell'` type drags along:
 *   - `terminalScrollback` was persisted into it, so a restore replays a dead
 *     session ("[nexus] process exited (code 0)") and spawns a fresh shell that
 *     prints "sessão anterior encerrada · nova sessão iniciada";
 *   - it renders as a terminal, so it says NOTHING about the mission that is
 *     live in this workspace and has not presented a pane yet (blocked,
 *     awaiting the operator, dispatch aborted).
 *
 * A vacancy must look like a vacancy and explain the workspace's actual state.
 */

const terminal = vi.hoisted(() => ({
  attachHost: vi.fn(),
  blurHost: vi.fn(),
  focusHost: vi.fn(),
  setHostVisibility: vi.fn(),
  reconcileHosts: vi.fn(),
  getPaneSessionId: vi.fn(() => null as string | null),
  getScrollbackExcerpt: vi.fn(() => ''),
  hibernateHost: vi.fn(),
  onPaneSessionChange: vi.fn(() => vi.fn()),
  respawnWithResume: vi.fn(),
  scrollPaneToBottom: vi.fn(),
  submitPromptToPane: vi.fn(() => true),
  wakeHost: vi.fn(),
  applyTerminalSettings: vi.fn(),
}));

vi.mock('../terminal/terminal-host', () => terminal);
vi.mock('../browser/browser-host', () => ({
  attachBrowserPane: vi.fn(),
  reconcileBrowserPanes: vi.fn(),
  waitForBrowserPaneCreated: vi.fn(async () => undefined),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

// jsdom ships no ResizeObserver; react-resizable-panels constructs one the
// moment a split Group mounts. Environment gap, not product behaviour.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

/**
 * Byte-for-byte the row read out of a real install
 * (project-runtime/.../runtime.sqlite3 → workspace_layout.layout_json): ONE
 * structural placeholder carrying the previous session's scrollback.
 */
const PERSISTED_PLACEHOLDER_LAYOUT: WorkspaceLayout = {
  root: {
    kind: 'leaf',
    id: 'leaf-1dcaa2e7',
    pane: {
      id: 'pane-5ba1523f',
      kind: 'shell',
      title: 'shell',
      isStructuralPlaceholder: true,
      terminalScrollback:
        'cleofasrocha@MacBook-Pro-de-Cleofas nexus-ide % \r\n' +
        '[90m[nexus] process exited (code 0)[0m',
    },
  },
  focusedPaneId: 'pane-5ba1523f',
};

const WORKSPACE = '/workspace/vacancy';

function mission(patch: Partial<Mission> = {}): Mission {
  return {
    id: 'mission-live',
    title: 'Publicar a release 0.22.1',
    description: '',
    status: 'blocked',
    milestones: [],
    learnings: '',
    // Timestamps frescos: a vacancy só narra trabalho tocado por ESTA sessão
    // — leftover de boot anterior vira rail, não dono do grid.
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...patch,
  };
}

let saved: WorkspaceLayout | null = null;

function installNexus(): void {
  saved = null;
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    value: {
      layout: {
        load: vi.fn(async () => structuredClone(PERSISTED_PLACEHOLDER_LAYOUT)),
        save: vi.fn(async (_path: string, layout: WorkspaceLayout) => {
          saved = layout;
        }),
        saveSync: vi.fn((_path: string, layout: WorkspaceLayout) => {
          saved = layout;
        }),
      },
    },
  });
}

let host: HTMLElement;
let root: Root;

function render(): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<PaneGrid />));
}

function text(): string {
  return host.textContent ?? '';
}

function buttonWith(label: string): HTMLButtonElement {
  const match = [...host.querySelectorAll('button')].find((button) =>
    button.textContent?.includes(label),
  );
  if (!match) {
    throw new Error(
      `no button matching "${label}" — buttons: ${[
        ...host.querySelectorAll('button'),
      ]
        .map((button) => JSON.stringify(button.textContent))
        .join(', ')}`,
    );
  }
  return match as HTMLButtonElement;
}

function seedPlaceholderOnly(): PaneModel {
  const pane: PaneModel = {
    id: 'pane-5ba1523f',
    kind: 'shell',
    title: 'shell',
    isStructuralPlaceholder: true,
  };
  useLayoutStore.setState({
    root: buildGridTree([pane]),
    focusedPaneId: pane.id,
    maximizedPaneId: null,
    hydrated: true,
  });
  return pane;
}

function livePane(): PaneModel {
  return listPanes(useLayoutStore.getState().root)[0]!;
}

describe('a SOLITARY structural placeholder is a vacancy, not a session', () => {
  beforeEach(() => {
    useGamificationStore.setState({ sober: false });
    useAccessStore.setState({ canUseApp: true, loading: false, maxAgents: null, cloudSync: true, blockedReason: null });
    installNexus();
    setActiveWorkspacePath(WORKSPACE);
    useOrchStore.setState({ missions: [], paneMissions: {} });
    useMissionInspectorStore.setState({
      missionId: null,
      tab: 'agent',
      selectedAgentId: null,
    });
    useProductNavigationStore.setState({
      destination: { kind: 'terminal' },
      settingsReturnDestination: null,
    });
  });

  afterEach(() => {
    act(() => root?.unmount());
    setTerminalSnapshotProvider(null);
    detachWorkspaceLayout();
    setActiveWorkspacePath(null);
    Reflect.deleteProperty(window, 'nexus');
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  /**
   * I6 (read side). The dead session's output is what made the vacancy look
   * like work: on restore, `attachHost` replays it and the operator reads a
   * terminal that was "doing something".
   */
  it('I6: restoring the persisted layout strips the dead session residue from the vacancy', async () => {
    await act(async () => {
      await switchWorkspaceLayout(WORKSPACE);
    });

    const pane = livePane();
    expect(pane.id).toBe('pane-5ba1523f');
    expect(pane.isStructuralPlaceholder).toBe(true);
    expect(pane.terminalScrollback).toBeUndefined();
  });

  /** I6 (write side): a vacancy may not be re-poisoned on the next save. */
  it('I6: a vacancy is never saved with terminal scrollback', async () => {
    await act(async () => {
      await switchWorkspaceLayout(WORKSPACE);
    });
    setTerminalSnapshotProvider(() => ({
      data: 'saída viva de um shell qualquer',
      cols: 96,
    }));

    flushLayout(true);

    const savedPane = listPanes(saved!.root)[0]!;
    expect(savedPane.isStructuralPlaceholder).toBe(true);
    expect(savedPane.terminalScrollback).toBeUndefined();
  });

  it('renders a vacancy surface instead of a terminal — no terminal slot is mounted', () => {
    seedPlaceholderOnly();

    render();

    expect(host.querySelector('.pane__terminal')).toBeNull();
    expect(terminal.attachHost).not.toHaveBeenCalled();

    act(() => root.unmount());
  });

  /**
   * THE REPORTED SCENE: a mission is live in this workspace and has presented
   * no pane. A shell prompt is the worst possible answer. The area names the
   * STATE (not the briefing), says WHY it stopped, and offers the action.
   */
  it('a live mission that presented no pane becomes the content of the grid', () => {
    useOrchStore.setState({
      missions: [
        mission({
          status: 'blocked',
          description: 'A missão parou.\n[NEXUS_TASK_DISPATCH_BLOCKED]',
        }),
      ],
    });
    seedPlaceholderOnly();

    render();

    expect(host.querySelector('.empty-state__title')?.textContent).toBe(
      'Missão em pausa',
    );
    // Ensina o porquê e oferece o próximo passo (DESIGN.md §5).
    expect(text()).toMatch(/despacho|bloque|parou/i);
    const detail = buttonWith('Ver a missão');
    act(() => detail.click());
    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'mission',
      missionId: 'mission-live',
      surface: 'board',
    });
    expect(useMissionInspectorStore.getState().tab).toBe('activity');

    act(() => root.unmount());
  });

  it('objetivo com URL não vira cartaz no empty state (F-011)', () => {
    useOrchStore.setState({
      missions: [
        mission({
          title:
            'https://admin.wordnet.com.vc/admin/conteudo aqui dentro deste painel. nao ta legal a ui nao ta. de forma facil de entender tipo e aqui que vai ter toda parte de gestao',
        }),
      ],
    });
    seedPlaceholderOnly();
    render();
    expect(host.querySelector('.empty-state__title')?.textContent).toBe(
      'Missão em pausa',
    );
    expect(text()).not.toMatch(/https:\/\/admin\.wordnet\.com\.vc/u);
    expect(text()).not.toMatch(/Motivo não registrado/u);
    expect(text()).not.toContain('aqui dentro deste painel');
    expect(text()).toMatch(/Atividade|quadro/i);
    act(() => root.unmount());
  });

  it('missão em curso pinta montagem, não o objetivo (F-011)', () => {
    useOrchStore.setState({
      missions: [mission({ status: 'running', title: 'Refatorar o grid' })],
    });
    seedPlaceholderOnly();
    render();
    expect(host.querySelector('.empty-state__title')?.textContent).toBe(
      'Montando a equipe',
    );
    expect(text()).not.toContain('Refatorar o grid');
    act(() => root.unmount());
  });

  it('with no live mission it teaches what the area is and how to use it', () => {
    seedPlaceholderOnly();

    render();

    expect(text()).toContain('Vaga livre');
    // "Nada aqui" sem CTA é bug (DESIGN.md §5).
    expect(buttonWith('Abrir terminal aqui')).toBeTruthy();

    act(() => root.unmount());
  });

  it('opens canonical Mission Setup from an idle vacancy', () => {
    seedPlaceholderOnly();
    render();

    act(() => buttonWith('Começar uma missão').click());

    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'mission-setup',
    });

    act(() => root.unmount());
  });

  /** The operator must still get a real terminal the moment they ask for one. */
  it('the CTA claims the vacancy and a real terminal takes its place', () => {
    seedPlaceholderOnly();
    render();

    act(() => buttonWith('Abrir terminal aqui').click());

    expect(livePane().isStructuralPlaceholder).toBeUndefined();
    expect(host.querySelector('.pane__terminal')).not.toBeNull();
    expect(terminal.attachHost).toHaveBeenCalled();
    expect(useLayoutStore.getState().focusedPaneId).toBe('pane-5ba1523f');

    act(() => root.unmount());
  });

  it('closing the final Terminal pane leaves an actionable PaneVacancy on Terminal', () => {
    const pane: PaneModel = {
      id: 'pane-final',
      kind: 'shell',
      title: 'Terminal',
    };
    useLayoutStore.setState({
      root: buildGridTree([pane]),
      focusedPaneId: pane.id,
      maximizedPaneId: null,
      hydrated: true,
    });
    useProductNavigationStore.getState().openTerminal();
    render();

    act(() => useLayoutStore.getState().close(pane.id, 'user'));

    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'terminal',
    });
    expect(buttonWith('Abrir terminal aqui')).toBeTruthy();
    expect(livePane().isStructuralPlaceholder).toBe(true);

    act(() => buttonWith('Abrir terminal aqui').click());
    expect(livePane().isStructuralPlaceholder).toBeUndefined();

    act(() => root.unmount());
  });

  /**
   * Clicking INTO the terminal used to claim the vacancy (a mousedown listener
   * on the xterm element). With no terminal mounted, that affordance has to
   * live on the vacancy surface itself or the claim path silently disappears.
   */
  it('clicking the vacancy surface claims it, exactly as clicking into the terminal did', () => {
    seedPlaceholderOnly();
    render();

    const surface = host.querySelector('.pane--vacancy .pane__vacancy');
    expect(surface).not.toBeNull();
    act(() => (surface as HTMLElement).click());

    expect(livePane().isStructuralPlaceholder).toBeUndefined();

    act(() => root.unmount());
  });

  /**
   * Same lie, smaller: "Fim", "Dormir" and "Cmds" are SESSION operations on a
   * pane that has no session. The layout group stays — splitting a vacancy is
   * one of the ways the operator claims it.
   */
  it('the vacancy toolbar drops session controls and keeps the layout ones', () => {
    seedPlaceholderOnly();

    render();

    const labels = [...host.querySelectorAll('button')].map(
      (button) => button.textContent ?? '',
    );
    expect(labels).not.toContain('Fim');
    expect(labels).not.toContain('Dormir');
    expect(labels).not.toContain('Cmds');
    expect(buttonWith('Dividir à direita')).toBeTruthy();

    act(() => root.unmount());
  });

  it('splitting the vacancy claims it — the operator gets two real terminals', () => {
    seedPlaceholderOnly();
    render();

    act(() => buttonWith('Dividir à direita').click());

    const panes = listPanes(useLayoutStore.getState().root);
    expect(panes).toHaveLength(2);
    expect(panes.every((pane) => pane.isStructuralPlaceholder === undefined)).toBe(
      true,
    );

    act(() => root.unmount());
  });

  it('keeps the focused idle vacancy quiet when sober mode is enabled', () => {
    seedPlaceholderOnly();
    useGamificationStore.setState({ sober: true });
    render();
    expect(host.querySelector('.spill-corner')).toBeNull();
  });

  it('shows the fizz overlay on the focused idle vacancy', () => {
    seedPlaceholderOnly();
    render();

    const spill = host.querySelector('.spill-corner');
    expect(spill).not.toBeNull();
    expect(spill?.getAttribute('aria-hidden')).toBe('true');

    act(() => root.unmount());
  });

  /** I1 is untouched: real content still evicts the vacancy outright. */
  it('a presented mission pane still REPLACES the vacancy (I1 unchanged)', () => {
    seedPlaceholderOnly();
    useLayoutStore.getState().setPanes([
      {
        id: 'pane-orq',
        kind: 'cli-agent',
        title: 'orq',
        adapterId: 'codex',
        missionId: 'mission-live',
      },
    ]);

    render();

    expect(listPanes(useLayoutStore.getState().root).map((p) => p.id)).toEqual([
      'pane-orq',
    ]);
    expect(host.querySelector('.pane--vacancy')).toBeNull();
    expect(host.querySelector('.pane__terminal')).not.toBeNull();

    act(() => root.unmount());
  });
});
