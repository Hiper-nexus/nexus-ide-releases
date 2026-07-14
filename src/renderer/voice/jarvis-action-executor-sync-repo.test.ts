import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JarvisContext } from '../../shared/voice-ipc';
import { buildSyncRepoViaPanePrompt } from '../../shared/sync-repo-via-pane';

const {
  confirmCommand,
  layoutState,
  missionWizardState,
  resolveSyncRepoViaPaneTarget,
  submitPromptToPane,
  waitForSession,
} = vi.hoisted(() => ({
  confirmCommand: vi.fn(),
  resolveSyncRepoViaPaneTarget: vi.fn(),
  submitPromptToPane: vi.fn(),
  waitForSession: vi.fn(),
  missionWizardState: {
    open: false,
    close: vi.fn(),
    openForAgentic: vi.fn(),
  },
  layoutState: {
    focusedPaneId: 'pane-agent' as string | null,
    viewKind: 'grid' as string,
    panes: [] as Array<{
      id: string;
      kind: 'shell' | 'cli-agent' | 'browser';
      title: string;
    }>,
    focus: vi.fn(),
    toggleView: vi.fn(),
  },
}));

vi.mock('../state/layout-store', () => ({
  useLayoutStore: {
    getState: () => ({
      root: layoutState.panes,
      focusedPaneId: layoutState.focusedPaneId,
      viewKind: layoutState.viewKind,
      focus: layoutState.focus,
      toggleView: layoutState.toggleView,
    }),
  },
}));
vi.mock('../lib/split-tree', () => ({ listPanes: () => layoutState.panes }));
vi.mock('../state/workspace-store', () => ({
  useWorkspaceStore: { getState: () => ({ current: { path: '/tmp/proj' } }) },
}));
vi.mock('../state/orch-store', () => ({
  useOrchStore: {
    getState: () => ({ squads: [], closeBoard: vi.fn() }),
  },
}));
vi.mock('../state/mission-wizard-store', () => ({
  useMissionWizardStore: { getState: () => missionWizardState },
}));
vi.mock('../state/home-store', () => ({
  useHomeStore: { getState: () => ({ hide: vi.fn() }) },
}));
vi.mock('../state/gamification-store', () => ({
  useGamificationStore: { getState: () => ({ closeProfile: vi.fn() }) },
}));
vi.mock('./voice-store', () => ({
  useVoiceStore: { getState: () => ({ closeSettings: vi.fn() }) },
}));
vi.mock('../state/settings-store', () => ({
  useSettingsStore: {
    getState: () => ({ drawerOpen: false, toggleDrawer: vi.fn() }),
  },
}));
vi.mock('../terminal/terminal-host', () => ({
  submitPromptToPane,
  waitForSession,
  writeToPane: vi.fn(),
}));
vi.mock('../browser/browser-host', () => ({ waitForBrowserPaneCreated: vi.fn() }));
vi.mock('../orch/mission-launcher', () => ({ launchSquadMission: vi.fn() }));
vi.mock('../lib/credential-errors', () => ({ isMissingModelKeyError: () => false }));
vi.mock('../services/mcp-bridge', () => ({
  invokeMcpWithConfirm: vi.fn(),
  mapActionToTool: () => null,
}));
vi.mock('../orch/mission-reopen', () => ({ reopenMission: vi.fn() }));
vi.mock('./send-to-pane-target', () => ({
  isOrchestratorPane: () => false,
  resolveSendToPaneTarget: vi.fn(),
  resolveSyncRepoViaPaneTarget,
}));
vi.mock('../terminal/pane-close-guard', () => ({ requestPaneClose: vi.fn() }));
vi.mock('./terminal-visibility', () => ({
  assessTerminalVisibility: vi.fn(),
  readUiVisibilityState: vi.fn(() => ({})),
}));
vi.mock('./voice-live-ipc', () => ({ logVoiceEvent: vi.fn() }));
vi.mock('./action-evidence', () => ({ waitForActionEvidence: vi.fn(async () => true) }));

import { executeJarvisAction } from './jarvis-action-executor';

const context: JarvisContext = {
  workspace: '/tmp/proj',
  recents: [],
  squads: [],
  panes: ['Claude [agent]'],
  focusedPane: 'Claude [agent]',
  orchestrator: null,
  missions: [],
};

describe('sync_repo_via_pane executor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    layoutState.focusedPaneId = 'pane-agent';
    layoutState.viewKind = 'grid';
    layoutState.panes = [
      { id: 'pane-agent', kind: 'cli-agent', title: 'Claude' },
    ];
    resolveSyncRepoViaPaneTarget.mockReturnValue({
      kind: 'asking-pane',
      paneId: 'pane-agent',
    });
    waitForSession.mockResolvedValue('session-1');
    submitPromptToPane.mockReturnValue(true);
    confirmCommand.mockResolvedValue(true);
    vi.stubGlobal('window', {
      nexus: {
        voice: { confirmCommand, logVoice: vi.fn() },
      },
    });
  });

  it('submits the product pull prompt to the agent pane', async () => {
    const execution = await executeJarvisAction(
      { say: '', action: { type: 'sync_repo_via_pane', mode: 'pull' } },
      context,
    );

    expect(submitPromptToPane).toHaveBeenCalledWith(
      'pane-agent',
      buildSyncRepoViaPanePrompt('pull'),
    );
    expect(layoutState.focus).toHaveBeenCalledWith('pane-agent');
    expect(execution.toolResult).toMatchObject({
      tool: 'sync_repo_via_pane',
      ok: true,
      summary: expect.stringContaining('sync pull'),
    });
    expect(execution.sayText).toMatch(/atualizar o repositório/i);
  });

  it('requires confirmation before push mode', async () => {
    confirmCommand.mockResolvedValueOnce(false);
    const denied = await executeJarvisAction(
      { say: '', action: { type: 'sync_repo_via_pane', mode: 'push' } },
      context,
    );
    expect(submitPromptToPane).not.toHaveBeenCalled();
    expect(denied.toolResult).toMatchObject({ ok: false, summary: 'usuário recusou push' });

    confirmCommand.mockResolvedValueOnce(true);
    const approved = await executeJarvisAction(
      { say: '', action: { type: 'sync_repo_via_pane', mode: 'push' } },
      context,
    );
    expect(confirmCommand).toHaveBeenCalled();
    expect(submitPromptToPane).toHaveBeenCalledWith(
      'pane-agent',
      buildSyncRepoViaPanePrompt('push'),
    );
    expect(approved.toolResult?.ok).toBe(true);
  });

  it('opens agentic mission when no agent pane exists', async () => {
    resolveSyncRepoViaPaneTarget.mockReturnValueOnce({ kind: 'no-agent-pane' });
    const execution = await executeJarvisAction(
      { say: '', action: { type: 'sync_repo_via_pane', mode: 'status' } },
      context,
    );
    expect(missionWizardState.openForAgentic).toHaveBeenCalled();
    expect(submitPromptToPane).not.toHaveBeenCalled();
    expect(execution.toolResult).toMatchObject({ ok: true });
    expect(execution.sayText).toMatch(/missão agêntica/i);
    expect(execution.sayText).toMatch(/status/i);
  });
});
