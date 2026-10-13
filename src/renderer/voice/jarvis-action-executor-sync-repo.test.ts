import { useAccessStore } from '../state/access-store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JarvisContext } from '../../shared/voice-ipc';
import { buildSyncRepoViaPanePrompt } from '../../shared/sync-repo-via-pane';

const {
  confirmCommand,
  layoutState,
  paneStates,
  resolveSyncRepoViaPaneTarget,
  submitPromptToPane,
  submitPromptToPaneConfirmed,
  waitForSession,
} = vi.hoisted(() => ({
  confirmCommand: vi.fn(),
  resolveSyncRepoViaPaneTarget: vi.fn(),
  submitPromptToPane: vi.fn(),
  submitPromptToPaneConfirmed: vi.fn(),
  waitForSession: vi.fn(),
  paneStates: new Map<string, string>(),
  layoutState: {
    focusedPaneId: 'pane-agent' as string | null,
    panes: [] as Array<{
      id: string;
      kind: 'shell' | 'cli-agent' | 'browser';
      title: string;
      adapterId?: string;
      model?: string;
    }>,
    focus: vi.fn(),
    spawnAgent: vi.fn((adapterId: string, model: string) => {
      const pane = {
        id: `pane-spawned-${layoutState.panes.length + 1}`,
        kind: 'cli-agent' as const,
        title: adapterId,
        adapterId,
        model,
      };
      layoutState.panes.push(pane);
      layoutState.focusedPaneId = pane.id;
    }),
  },
}));

vi.mock('../state/layout-store', () => ({
  useLayoutStore: {
    getState: () => ({
      root: layoutState.panes,
      focusedPaneId: layoutState.focusedPaneId,
      focus: layoutState.focus,
      spawnAgent: layoutState.spawnAgent,
    }),
  },
}));
vi.mock('../lib/split-tree', () => ({ listPanes: () => layoutState.panes }));
vi.mock('../state/workspace-store', () => ({
  useWorkspaceStore: { getState: () => ({ current: { path: '/tmp/proj' } }) },
}));
vi.mock('../state/orch-store', () => ({
  useOrchStore: {
    getState: () => ({ squads: [] }),
  },
}));
vi.mock('../state/gamification-store', () => ({
  useGamificationStore: { getState: () => ({ closeProfile: vi.fn() }) },
}));
vi.mock('./voice-store', () => ({
  useVoiceStore: { getState: () => ({ closeSettings: vi.fn() }) },
}));
vi.mock('../terminal/terminal-host', () => ({
  getPaneSessionId: (paneId: string) =>
    paneId === 'pane-agent' ? 'sess-agent' : null,
  submitPromptToPane,
  submitPromptToPaneConfirmed,
  waitForSession,
  writeToPane: vi.fn(),
}));
vi.mock('../state/session-state-store', () => ({
  useSessionStateStore: {
    getState: () => ({ paneStates }),
  },
}));
vi.mock('../browser/browser-host', () => ({ waitForBrowserPaneCreated: vi.fn() }));
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
    layoutState.panes = [
      { id: 'pane-agent', kind: 'cli-agent', title: 'Claude' },
    ];
    resolveSyncRepoViaPaneTarget.mockReturnValue({
      kind: 'asking-pane',
      paneId: 'pane-agent',
    });
    waitForSession.mockResolvedValue('session-1');
    submitPromptToPane.mockReturnValue(true);
    submitPromptToPaneConfirmed.mockResolvedValue(true);
    paneStates.clear();
    confirmCommand.mockResolvedValue(true);
    vi.stubGlobal('window', {
      nexus: {
        adapters: {
          list: vi.fn(async () => [
            {
              id: 'codex',
              label: 'Codex',
              installed: true,
              enabled: true,
              models: { default: 'gpt-5.6-luna', list: ['gpt-5.6-luna'] },
            },
          ]),
        },
        voice: { confirmCommand, logVoice: vi.fn() },
      },
    });
  });

  it('submits the product pull prompt to the agent pane with delivery confirm', async () => {
    const execution = await executeJarvisAction(
      { say: '', action: { type: 'sync_repo_via_pane', mode: 'pull' } },
      context,
    );

    expect(submitPromptToPaneConfirmed).toHaveBeenCalledWith(
      'pane-agent',
      buildSyncRepoViaPanePrompt('pull'),
      'session-1',
    );
    expect(layoutState.focus).toHaveBeenCalledWith('pane-agent');
    expect(execution.toolResult).toMatchObject({
      tool: 'sync_repo_via_pane',
      ok: true,
      summary: expect.stringContaining('sync pull'),
    });
    expect(execution.sayText).toMatch(/atualizar o repositório/i);
  });

  it('refuses sync when the agent pane is busy', async () => {
    paneStates.set('pane-agent', 'busy');
    const execution = await executeJarvisAction(
      { say: '', action: { type: 'sync_repo_via_pane', mode: 'pull' } },
      context,
    );
    expect(submitPromptToPaneConfirmed).not.toHaveBeenCalled();
    expect(execution.toolResult).toMatchObject({
      ok: false,
      summary: expect.stringContaining('ocupado'),
    });
    expect(execution.sayText).toMatch(/ocupado/i);
  });

  it('requires confirmation before push mode', async () => {
    confirmCommand.mockResolvedValueOnce(false);
    const denied = await executeJarvisAction(
      { say: '', action: { type: 'sync_repo_via_pane', mode: 'push' } },
      context,
    );
    expect(submitPromptToPaneConfirmed).not.toHaveBeenCalled();
    expect(denied.toolResult).toMatchObject({ ok: false, summary: 'usuário recusou push' });

    confirmCommand.mockResolvedValueOnce(true);
    const approved = await executeJarvisAction(
      { say: '', action: { type: 'sync_repo_via_pane', mode: 'push' } },
      context,
    );
    expect(confirmCommand).toHaveBeenCalled();
    expect(submitPromptToPaneConfirmed).toHaveBeenCalledWith(
      'pane-agent',
      buildSyncRepoViaPanePrompt('push'),
      'session-1',
    );
    expect(approved.toolResult?.ok).toBe(true);
  });

  it('opens one plain agent pane when no agent pane exists, never a mission', async () => {
    resolveSyncRepoViaPaneTarget.mockReturnValueOnce({ kind: 'no-agent-pane' });
    layoutState.panes = [{ id: 'pane-shell', kind: 'shell', title: 'shell' }];
    layoutState.focusedPaneId = 'pane-shell';
    const execution = await executeJarvisAction(
      { say: '', action: { type: 'sync_repo_via_pane', mode: 'status' } },
      context,
    );
    expect(layoutState.spawnAgent).toHaveBeenCalledWith('codex', 'gpt-5.6-luna');
    expect(submitPromptToPaneConfirmed).toHaveBeenCalledWith(
      'pane-spawned-2',
      buildSyncRepoViaPanePrompt('status'),
      'session-1',
    );
    expect(submitPromptToPane).not.toHaveBeenCalled();
    expect(execution.toolResult).toMatchObject({ ok: true });
    expect(execution.sayText).toMatch(/agente único/i);
    expect(execution.sayText).toMatch(/status/i);
  });

  // F-1431: o sync de repositório nunca digita num pane de agente que já
  // existia — mesmo vivo, mesmo ocupado. Nasce um pane novo.
  it('no-agent-pane com agente vivo ocupado nasce pane novo e não digita no existente', async () => {
    resolveSyncRepoViaPaneTarget.mockReturnValueOnce({ kind: 'no-agent-pane' });
    layoutState.panes = [
      { id: 'pane-agent', kind: 'cli-agent', title: 'Claude', adapterId: 'claude' },
    ];
    paneStates.set('pane-agent', 'busy');
    const execution = await executeJarvisAction(
      { say: '', action: { type: 'sync_repo_via_pane', mode: 'status' } },
      context,
    );

    expect(layoutState.spawnAgent).toHaveBeenCalledWith('codex', 'gpt-5.6-luna');
    expect(submitPromptToPaneConfirmed).not.toHaveBeenCalledWith(
      'pane-agent',
      expect.anything(),
      expect.anything(),
    );
    expect(submitPromptToPaneConfirmed).toHaveBeenCalledWith(
      'pane-spawned-2',
      buildSyncRepoViaPanePrompt('status'),
      'session-1',
    );
    expect(execution.toolResult).toMatchObject({ ok: true });
  });
});

beforeEach(() => { useAccessStore.setState({ canUseApp: true, maxAgents: null }); });
