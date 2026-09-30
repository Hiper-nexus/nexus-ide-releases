import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProductDestination } from '../state/product-navigation-store';
import { useCloseWorkspaceStore } from '../components/CloseWorkspaceDialog';
import { buildGridTree, listPanes } from '../lib/split-tree';
import { useGamificationStore } from '../state/gamification-store';
import { useLayoutStore } from '../state/layout-store';
import { useOrchStore } from '../state/orch-store';
import { useProductNavigationStore } from '../state/product-navigation-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { currentScreenSnapshot } from './jarvis-screen-context';
import { useVoiceStore } from './voice-store';

vi.mock('../terminal/terminal-host', () => ({
  getPaneSessionId: vi.fn((paneId: string) =>
    paneId.startsWith('shell-') ? `session-${paneId}` : null,
  ),
}));

const WORKSPACE = {
  path: '/workspace/navigation',
  name: 'Navigation',
  lastOpenedAt: 1,
};

function seedPane(id: string): void {
  useLayoutStore.setState({
    root: buildGridTree([{ id, kind: 'shell', title: 'Terminal' }]),
    focusedPaneId: id,
    maximizedPaneId: null,
    hydrated: true,
  });
}

beforeEach(() => {
  useWorkspaceStore.setState({
    current: WORKSPACE,
    recents: [],
    hydrated: true,
  });
  useOrchStore.setState({
    missions: [],
    squads: [],
    missionSummaries: [],
    paneMissions: {},
  } as never);
  useGamificationStore.setState({ profileOpen: false } as never);
  useVoiceStore.setState({ settingsOpen: false } as never);
  useCloseWorkspaceStore.setState({ open: false });
  useProductNavigationStore.setState({
    destination: { kind: 'terminal' },
    settingsReturnDestination: null,
  });
  seedPane('shell-origin');
});

describe('Jarvis product destination context after final-pane close', () => {
  it.each([
    [
      'Mission Setup',
      { kind: 'mission-setup' },
      /mission setup|preparar missão/i,
    ],
    [
      'Mission Board',
      { kind: 'mission', missionId: 'mission-a', surface: 'board' },
      /mission board.*mission-a|quadro da missão.*mission-a/i,
    ],
    ['Task Board', { kind: 'task-board' }, /task board|quadro de tarefas/i],
    ['Memory', { kind: 'memory' }, /memory|memória/i],
    [
      'Settings',
      { kind: 'settings', section: 'providers' },
      /settings.*providers|configurações.*providers/i,
    ],
  ] as const)(
    'keeps %s as the visible and spoken destination when the last pane closes',
    (_label, destination, expectedContext) => {
      useProductNavigationStore.setState({
        destination: destination as ProductDestination,
        settingsReturnDestination: null,
      });
      const paneId = listPanes(useLayoutStore.getState().root)[0]!.id;

      useLayoutStore.getState().close(paneId, 'runtime');

      expect(useProductNavigationStore.getState().destination).toEqual(
        destination,
      );
      expect(currentScreenSnapshot().context).toMatch(expectedContext);
      seedPane(`shell-${String(destination.kind)}`);
    },
  );

  it('keeps Terminal on the canonical vacancy after its last pane closes', () => {
    useProductNavigationStore.getState().openTerminal();
    const paneId = listPanes(useLayoutStore.getState().root)[0]!.id;

    useLayoutStore.getState().close(paneId, 'user');

    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'terminal',
    });
    expect(listPanes(useLayoutStore.getState().root)).toEqual([
      expect.objectContaining({ isStructuralPlaceholder: true }),
    ]);
    expect(currentScreenSnapshot().context).toMatch(/terminal.*vaga|terminal vacancy/i);
  });

  it.each([
    [{ kind: 'launcher' }, /launcher/i],
    [
      { kind: 'mission', missionId: 'mission-a', surface: 'terminals' },
      /mission terminals.*mission-a|terminais da missão.*mission-a/i,
    ],
  ] as const)(
    'derives Jarvis context from destination %o without a legacy surface flag',
    (destination, expectedContext) => {
      useProductNavigationStore.setState({
        destination: destination as ProductDestination,
        settingsReturnDestination: null,
      });

      expect(currentScreenSnapshot().context).toMatch(expectedContext);
    },
  );
});
