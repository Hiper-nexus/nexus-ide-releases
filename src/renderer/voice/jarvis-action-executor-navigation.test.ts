import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JarvisAction, JarvisContext, JarvisReply } from '../../shared/voice-ipc';

const {
  addShellPane,
  claimStructuralPlaceholder,
  closeProfile,
  closeVoiceSettings,
  focusPane,
  layoutState,
  orchState,
  waitForSession,
  workspaceState,
} = vi.hoisted(() => ({
  addShellPane: vi.fn(() => 'pane-added'),
  claimStructuralPlaceholder: vi.fn(),
  closeProfile: vi.fn(),
  closeVoiceSettings: vi.fn(),
  focusPane: vi.fn(),
  waitForSession: vi.fn(),
  layoutState: {
    focusedPaneId: 'pane-terminal' as string | null,
    viewKind: 'grid' as 'grid' | 'canvas',
    panes: [] as Array<{
      id: string;
      kind: 'shell' | 'cli-agent' | 'browser';
      title: string;
      orchRequestId?: string;
      missionId?: string;
    }>,
  },
  orchState: {
    missions: [] as Array<Record<string, unknown>>,
    squads: [] as Array<Record<string, unknown>>,
  },
  workspaceState: {
    current: null as { path: string } | null,
  },
}));

vi.mock('../state/layout-store', () => ({
  useLayoutStore: {
    getState: () => ({
      root: layoutState.panes,
      focusedPaneId: layoutState.focusedPaneId,
      viewKind: layoutState.viewKind,
      addShellPane,
      claimStructuralPlaceholder,
      focus: focusPane,
      toggleView: vi.fn(),
    }),
  },
}));
vi.mock('../lib/split-tree', () => ({ listPanes: () => layoutState.panes }));
vi.mock('../state/workspace-store', () => ({
  useWorkspaceStore: { getState: () => workspaceState },
}));
vi.mock('../state/orch-store', () => ({
  useOrchStore: { getState: () => orchState },
}));
vi.mock('../state/gamification-store', () => ({
  useGamificationStore: { getState: () => ({ closeProfile }) },
}));
vi.mock('./voice-store', () => ({
  useVoiceStore: { getState: () => ({ closeSettings: closeVoiceSettings }) },
}));
vi.mock('../state/session-state-store', () => ({
  useSessionStateStore: { getState: () => ({ paneStates: new Map() }) },
}));
vi.mock('../terminal/terminal-host', () => ({
  submitPromptToPane: vi.fn(),
  submitPromptToPaneConfirmed: vi.fn(),
  waitForSession,
  writeToPane: vi.fn(),
}));
vi.mock('./terminal-visibility', () => ({
  assessTerminalVisibility: () => ({ visible: true, reasons: [] }),
  readUiVisibilityState: () => ({}),
}));
vi.mock('../browser/browser-host', () => ({
  waitForBrowserPaneCreated: vi.fn(),
}));
vi.mock('../lib/credential-errors', () => ({
  isMissingModelKeyError: () => false,
}));
vi.mock('../services/mcp-bridge', () => ({
  invokeMcpWithConfirm: vi.fn(),
  mapActionToTool: vi.fn(() => null),
}));
vi.mock('../orch/mission-reopen', () => ({
  reopenMission: vi.fn(),
  livePaneIdsForMission: vi.fn(() => []),
}));
vi.mock('./send-to-pane-target', () => ({
  isOrchestratorPane: () => false,
  resolveSendToPaneTarget: vi.fn(),
  resolveSyncRepoViaPaneTarget: vi.fn(),
}));
vi.mock('../terminal/pane-close-guard', () => ({ requestPaneClose: vi.fn() }));
vi.mock('./voice-live-ipc', () => ({ logVoiceEvent: vi.fn() }));

import { useMissionSetupStore } from '../state/mission-setup-store';
import { useProductNavigationStore } from '../state/product-navigation-store';
import { executeJarvisAction } from './jarvis-action-executor';

const context: JarvisContext = {
  workspace: '/tmp/nexus',
  recents: [],
  squads: [],
  panes: [],
  focusedPane: null,
  orchestrator: null,
  missions: [],
};

async function execute(action: JarvisAction) {
  const reply: JarvisReply = { say: '', action };
  return executeJarvisAction(reply, context);
}

beforeEach(() => {
  vi.clearAllMocks();
  layoutState.focusedPaneId = 'pane-terminal';
  layoutState.viewKind = 'grid';
  layoutState.panes = [
    { id: 'pane-terminal', kind: 'shell', title: 'Terminal' },
  ];
  orchState.missions = [];
  orchState.squads = [];
  workspaceState.current = { path: '/tmp/nexus' };
  waitForSession.mockResolvedValue('session-terminal');
  useProductNavigationStore.setState({
    destination: { kind: 'terminal' },
    settingsReturnDestination: null,
  });
});

describe('Jarvis product navigation', () => {
  it.each([
    ['new_mission', { type: 'new_mission' as const }, { kind: 'mission-setup' }],
    [
      'new_agentic_mission',
      {
        type: 'new_agentic_mission' as const,
        intent: 'Corrigir o login',
      },
      { kind: 'mission-setup' },
    ],
    ['open_board', { type: 'open_board' as const }, { kind: 'task-board' }],
    ['open_settings', { type: 'open_settings' as const }, { kind: 'settings' }],
  ])('routes %s through the canonical destination', async (_label, action, expected) => {
    if (_label === 'new_agentic_mission') {
      useMissionSetupStore.setState({
        entryContext: { kind: 'pet-studio', revision: 1 },
      } as never);
    }
    const result = await execute(action);

    expect(result.toolResult?.ok).toBe(true);
    expect(useProductNavigationStore.getState().destination).toEqual(expected);
    if (_label === 'new_agentic_mission') {
      expect(
        Reflect.get(useMissionSetupStore.getState(), 'entryContext'),
      ).toBeNull();
      expect(useMissionSetupStore.getState().draft.objective).toBe(
        'Corrigir o login',
      );
      expect(useMissionSetupStore.getState().draft.step).toBe('team');
    }
  });

  it('does not approve a Pet Studio roster as an ordinary voice mission', async () => {
    const workspacePath = '/tmp/nexus-confirm-pet';
    const setup = useMissionSetupStore.getState();
    setup.setWorkspace(workspacePath);
    setup.resetWorkspace(workspacePath);
    expect(
      useMissionSetupStore.getState().beginPetStudioReview({
        objective: 'Gerar o pet',
        title: 'Pet temporário',
        referenceImagePath: `${workspacePath}/.nexus/attachments/pet.png`,
      }),
    ).not.toBeNull();

    const result = await execute({ type: 'confirm_squad' });

    expect(result.toolResult?.ok).toBe(false);
    expect(useMissionSetupStore.getState().entryContext).toBeNull();
    expect(useMissionSetupStore.getState().draft.roster).toHaveLength(0);
  });

  it('makes Terminal the visible destination while preserving terminal creation', async () => {
    useProductNavigationStore.getState().openTaskBoard();

    const result = await execute({ type: 'open_terminal' });

    expect(result.toolResult?.ok).toBe(true);
    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'terminal',
    });
    expect(waitForSession).toHaveBeenCalledWith('pane-terminal', 5_000);
  });

  it('keeps an existing mission pane in its named mission terminals', async () => {
    layoutState.panes = [
      {
        id: 'pane-terminal',
        kind: 'shell',
        title: 'Terminal',
        missionId: 'mission-release',
      },
    ];
    useProductNavigationStore.getState().openTaskBoard();

    const result = await execute({ type: 'open_terminal' });

    expect(result.toolResult?.ok).toBe(true);
    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'mission',
      missionId: 'mission-release',
      surface: 'terminals',
    });
  });
});
