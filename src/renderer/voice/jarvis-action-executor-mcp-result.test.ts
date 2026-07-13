import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JarvisContext, JarvisReply } from '../../shared/voice-ipc';

const {
  invokeMcpWithConfirm,
  layoutState,
  missionWizardState,
  resolveSendToPaneTarget,
  setPendingDelegation,
  submitPromptToPane,
  waitForSession,
  writeToPane,
} = vi.hoisted(() => ({
  invokeMcpWithConfirm: vi.fn(),
  resolveSendToPaneTarget: vi.fn(),
  setPendingDelegation: vi.fn(),
  submitPromptToPane: vi.fn(),
  waitForSession: vi.fn(),
  writeToPane: vi.fn(),
  missionWizardState: {
    openForAgentic: vi.fn(),
  },
  layoutState: {
    focusedPaneId: null as string | null,
    panes: [] as Array<{ id: string; kind: 'shell' | 'cli-agent' | 'browser'; title: string }>,
  },
}));

vi.mock('../state/layout-store', () => ({
  useLayoutStore: {
    getState: () => ({
      root: layoutState.panes,
      focusedPaneId: layoutState.focusedPaneId,
    }),
  },
}));
vi.mock('../lib/split-tree', () => ({ listPanes: () => layoutState.panes }));
vi.mock('../state/workspace-store', () => ({
  useWorkspaceStore: { getState: vi.fn() },
}));
vi.mock('../state/orch-store', () => ({ useOrchStore: { getState: vi.fn() } }));
vi.mock('../state/mission-wizard-store', () => ({
  useMissionWizardStore: { getState: () => missionWizardState },
}));
vi.mock('../state/home-store', () => ({ useHomeStore: { getState: vi.fn() } }));
vi.mock('../state/gamification-store', () => ({
  useGamificationStore: { getState: vi.fn() },
}));
vi.mock('./voice-store', () => ({ useVoiceStore: { getState: vi.fn() } }));
vi.mock('../state/settings-store', () => ({
  useSettingsStore: { getState: vi.fn() },
}));
vi.mock('../terminal/terminal-host', () => ({
  submitPromptToPane,
  waitForSession,
  writeToPane,
}));
vi.mock('../browser/browser-host', () => ({ waitForBrowserPaneCreated: vi.fn() }));
vi.mock('../orch/mission-launcher', () => ({ launchSquadMission: vi.fn() }));
vi.mock('../lib/credential-errors', () => ({ isMissingModelKeyError: () => false }));
vi.mock('./voice-playback', () => ({
  playAudioBase64: vi.fn(),
  stopAllPlayback: vi.fn(),
  bindWakeSuppressor: vi.fn(),
}));
vi.mock('../services/mcp-bridge', async (importActual) => ({
  ...(await importActual<typeof import('../services/mcp-bridge')>()),
  invokeMcpWithConfirm,
}));
vi.mock('../orch/mission-reopen', () => ({
  reopenMission: vi.fn(),
  livePaneIdsForMission: vi.fn(() => []),
}));
vi.mock('./delegation-confirm', () => ({
  delegationConfirmPrompt: vi.fn(),
  setPendingDelegation,
}));
vi.mock('./send-to-pane-target', () => ({
  isOrchestratorPane: () => false,
  resolveSendToPaneTarget,
}));
vi.mock('../terminal/pane-close-guard', () => ({ requestPaneClose: vi.fn() }));

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

function mcpReply(tool: string): JarvisReply {
  return {
    say: '',
    action: { type: 'mcp_tool', tool, args: {} },
  };
}

describe('Jarvis MCP result propagation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    layoutState.focusedPaneId = null;
    layoutState.panes = [];
    vi.stubGlobal('window', {
      nexus: { voice: { logVoice: vi.fn() } },
    });
  });

  it('reads the actual focused terminal through nexus_pane_read', async () => {
    layoutState.focusedPaneId = 'pane-terminal';
    layoutState.panes = [
      { id: 'pane-terminal', kind: 'shell', title: 'Terminal principal' },
    ];
    invokeMcpWithConfirm.mockResolvedValueOnce({
      ok: true,
      tool: 'nexus_pane_read',
      result: 'TEST_OUTPUT_MARKER',
    });

    const execution = await executeJarvisAction(
      { say: '', action: { type: 'read_pane' } },
      context,
    );

    expect(invokeMcpWithConfirm).toHaveBeenCalledWith(
      'nexus_pane_read',
      { paneId: 'pane-terminal', lines: 200 },
      expect.objectContaining({ signal: undefined }),
    );
    expect(execution.toolResult).toEqual({
      tool: 'read_pane',
      ok: true,
      summary: 'nexus_pane_read ok',
      output: 'TEST_OUTPUT_MARKER',
    });
  });

  it('reads the visible Nexus surface through local AX + OCR without a cloud image', async () => {
    const contextView = {
      capturedAt: '2026-07-10T15:00:00.000Z',
      ax: {
        status: 'ok',
        tree: {
          tag: 'body',
          role: null,
          aria: {},
          text: null,
          children: [
            {
              tag: 'h1',
              role: 'heading',
              aria: {},
              text: 'Nova Missão',
              children: [],
            },
          ],
        },
      },
      ocr: { status: 'ok', text: 'Modo Agêntico', confidence: 95 },
      screenshot: {
        status: 'ok',
        format: 'png',
        width: 1280,
        height: 720,
        capturedAt: '2026-07-10T15:00:00.000Z',
        sourceId: 'window:nexus:1',
        hasImage: true,
        cloudAllowed: false,
      },
      llmPrompt: 'unused',
    } as const;
    const readView = vi.fn(async () => contextView);
    vi.stubGlobal('window', { nexus: { vision: { context: readView } } });

    const execution = await executeJarvisAction(
      { say: 'Vou ler a tela.', action: { type: 'read_current_view' } },
      context,
    );

    expect(readView).toHaveBeenCalledWith({
      includeScreenshot: true,
      includeOcr: true,
      allowCloudImage: false,
    });
    expect(execution.sayText).toContain('Nova Missão');
    expect(execution.toolResult).toMatchObject({
      tool: 'read_current_view',
      ok: true,
      summary: expect.stringContaining('localmente'),
    });
    expect(JSON.stringify(execution.toolResult?.output)).toContain('Modo Agêntico');
  });

  it('opens the mission wizard directly in agentic mode', async () => {
    const execution = await executeJarvisAction(
      {
        say: '',
        action: { type: 'new_agentic_mission', intent: 'auditar os logs da Jarvis' },
      },
      context,
    );

    expect(missionWizardState.openForAgentic).toHaveBeenCalledWith('auditar os logs da Jarvis');
    expect(execution.toolResult).toMatchObject({
      tool: 'new_agentic_mission',
      ok: true,
    });
  });

  it('dispatches a routine delegation immediately without a confirmation round trip', async () => {
    resolveSendToPaneTarget.mockReturnValueOnce({
      kind: 'delegation',
      orchestratorPaneId: 'pane-orq',
    });
    waitForSession.mockResolvedValueOnce('session-orq');
    submitPromptToPane.mockReturnValueOnce(true);

    const execution = await executeJarvisAction(
      { say: '', action: { type: 'send_to_pane', text: 'corrigir o login' } },
      context,
    );

    expect(submitPromptToPane).toHaveBeenCalledWith(
      'pane-orq',
      expect.stringContaining('Objective: corrigir o login'),
    );
    expect(setPendingDelegation).not.toHaveBeenCalled();
    expect(execution.expectReply).not.toBe(true);
    expect(execution.toolResult).toMatchObject({
      tool: 'send_to_pane',
      ok: true,
      summary: expect.stringContaining('submetida ao pane'),
    });
  });

  it('reroutes a structured mission mislabeled as run_command to the orchestrator', async () => {
    resolveSendToPaneTarget.mockReturnValueOnce({
      kind: 'delegation',
      orchestratorPaneId: 'pane-orq',
    });
    waitForSession.mockResolvedValueOnce('session-orq');
    submitPromptToPane.mockReturnValueOnce(true);
    const mission = [
      'Objective: Investigate the scheduling bug.',
      'Execution requirements:',
      '- Inspect logs and source code.',
      'Acceptance criteria:',
      '- Identify the trigger.',
    ].join('\n');

    const execution = await executeJarvisAction(
      { say: '', action: { type: 'run_command', command: mission } },
      context,
    );

    expect(submitPromptToPane).toHaveBeenCalledWith('pane-orq', mission);
    expect(execution.toolResult).toMatchObject({ tool: 'send_to_pane', ok: true });
  });

  it('reads the actual focused browser page through nexus_browser_read', async () => {
    layoutState.focusedPaneId = 'pane-browser';
    layoutState.panes = [
      { id: 'pane-browser', kind: 'browser', title: 'Nexus docs' },
    ];
    invokeMcpWithConfirm.mockResolvedValueOnce({
      ok: true,
      tool: 'nexus_browser_read',
      result: { title: 'Nexus docs', bodyText: 'BROWSER_PAGE_MARKER' },
    });

    const execution = await executeJarvisAction(
      { say: '', action: { type: 'read_pane' } },
      context,
    );

    expect(invokeMcpWithConfirm).toHaveBeenCalledWith(
      'nexus_browser_read',
      { paneId: 'pane-browser', maxChars: 20_000, maxElements: 200 },
      expect.objectContaining({ signal: undefined }),
    );
    expect(execution.toolResult).toEqual({
      tool: 'read_pane',
      ok: true,
      summary: 'nexus_browser_read ok',
      output: { title: 'Nexus docs', bodyText: 'BROWSER_PAGE_MARKER' },
    });
  });

  it.each([
    {
      tool: 'nexus_file_read',
      marker: 'FILE_READ_MARKER_7b16',
      result: {
        path: 'src/marker.ts',
        content: 'payload:FILE_READ_MARKER_7b16',
      },
    },
    {
      tool: 'nexus_pane_read',
      marker: 'PANE_READ_MARKER_4a92',
      result: 'pane-tail:PANE_READ_MARKER_4a92',
    },
  ])('preserves the real $tool result in toolResult.output', async ({
    tool,
    marker,
    result,
  }) => {
    invokeMcpWithConfirm.mockResolvedValueOnce({
      ok: true,
      tool,
      result,
    });

    const execution = await executeJarvisAction(mcpReply(tool), context);

    expect(execution.toolResult).toMatchObject({
      tool: 'mcp_tool',
      ok: true,
    });
    expect(execution.toolResult?.output).toEqual(result);
    expect(JSON.stringify(execution.toolResult?.output)).toContain(marker);
  });

  it('redacts secrets and bounds oversized MCP results before exposing them to Live', async () => {
    const secret = 'sk-super-secret-value-1234567890';
    const envSecret = 'plain-database-password-value';
    invokeMcpWithConfirm.mockResolvedValueOnce({
      ok: true,
      tool: 'nexus_file_read',
      result: {
        marker: 'SAFE_MARKER',
        apiKey: secret,
        content:
          `const token = "${secret}";\n` +
          `NEXUS_DATABASE_PASSWORD=${envSecret}\n` +
          'x'.repeat(30_000),
      },
    });

    const execution = await executeJarvisAction(
      mcpReply('nexus_file_read'),
      context,
    );
    const serialized = JSON.stringify(execution.toolResult?.output);

    expect(serialized).toContain('SAFE_MARKER');
    expect(serialized).toContain('[REDACTED]');
    expect(serialized).toContain('[TRUNCATED]');
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(envSecret);
    expect(serialized.length).toBeLessThanOrEqual(16_500);
  });

  it('threads cancellation control into the MCP confirmation/invoke boundary', async () => {
    const abort = new AbortController();
    const onEffectMayHaveCommitted = vi.fn();
    invokeMcpWithConfirm.mockImplementationOnce(
      async (_tool, _args, control) => {
        expect(control?.signal).toBe(abort.signal);
        control?.onEffectMayHaveCommitted?.();
        return { ok: true, tool: 'nexus_file_read', result: { ok: true } };
      },
    );

    await executeJarvisAction(mcpReply('nexus_file_read'), context, {
      signal: abort.signal,
      onEffectMayHaveCommitted,
    });

    expect(onEffectMayHaveCommitted).toHaveBeenCalledOnce();
  });

  it('does not enter MCP execution when the Live call was already cancelled', async () => {
    const abort = new AbortController();
    abort.abort();

    await expect(
      executeJarvisAction(mcpReply('nexus_file_read'), context, {
        signal: abort.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(invokeMcpWithConfirm).not.toHaveBeenCalled();
  });
});
