import { useAccessStore } from '../state/access-store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JarvisContext } from '../../shared/voice-ipc';

const {
  focusPane,
  layoutState,
  paneStates,
  spawnAgent,
  submitPromptToPane,
  submitPromptToPaneConfirmed,
  waitForSession,
} = vi.hoisted(() => ({
  focusPane: vi.fn(),
  spawnAgent: vi.fn(() => 'pane-novo'),
  submitPromptToPane: vi.fn(),
  submitPromptToPaneConfirmed: vi.fn(),
  waitForSession: vi.fn(),
  paneStates: new Map<string, string>(),
  layoutState: {
    focusedPaneId: 'pane-claude' as string | null,
    panes: [] as Array<{
      id: string;
      kind: 'shell' | 'cli-agent' | 'browser';
      title: string;
      adapterId?: string;
      model?: string;
    }>,
  },
}));

vi.mock('../state/layout-store', () => ({
  useLayoutStore: {
    getState: () => ({
      root: layoutState.panes,
      focusedPaneId: layoutState.focusedPaneId,
      focus: focusPane,
      spawnAgent,
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
    paneId === 'pane-claude' ? 'sess-claude' : null,
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
  resolveSyncRepoViaPaneTarget: vi.fn(),
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

describe('open_agent executor (F-1431)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    layoutState.focusedPaneId = 'pane-claude';
    layoutState.panes = [
      { id: 'pane-claude', kind: 'cli-agent', title: 'Claude', adapterId: 'claude' },
    ];
    paneStates.clear();
    waitForSession.mockResolvedValue('session-1');
  });

  it('abre pane NOVO mesmo com um Claude vivo e ocupado da mesma CLI', async () => {
    paneStates.set('pane-claude', 'busy');
    const execution = await executeJarvisAction(
      { say: '', action: { type: 'open_agent', agentId: 'claude', model: '' } },
      context,
    );

    expect(spawnAgent).toHaveBeenCalledTimes(1);
    expect(spawnAgent).toHaveBeenCalledWith('claude', '', {});
    expect(execution.toolResult).toMatchObject({ ok: true });
    expect(execution.toolResult?.output).toMatchObject({
      paneId: 'pane-novo',
      agentId: 'claude',
    });
  });

  it('abre pane NOVO com um Claude vivo e ocioso da mesma CLI', async () => {
    paneStates.set('pane-claude', 'idle');
    const execution = await executeJarvisAction(
      { say: '', action: { type: 'open_agent', agentId: 'claude', model: '' } },
      context,
    );

    expect(spawnAgent).toHaveBeenCalledTimes(1);
    expect(execution.sayText).toMatch(/aberto/i);
  });
});

beforeEach(() => { useAccessStore.setState({ canUseApp: true, maxAgents: null }); });
