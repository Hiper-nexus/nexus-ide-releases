import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JarvisAction } from '../../shared/voice-ipc';

const mocks = vi.hoisted(() => ({
  executeJarvisAction: vi.fn(),
  clearJarvisMcpSession: vi.fn(async () => {}),
  liveToolResult: vi.fn(),
  recordJarvisAction: vi.fn(async () => ({})),
  setStatus: vi.fn(),
  setError: vi.fn(),
  cancelLiveFollowUp: vi.fn(),
}));

vi.mock('./jarvis-action-executor', () => ({
  executeJarvisAction: mocks.executeJarvisAction,
}));
vi.mock('./voice-store', () => ({
  useVoiceStore: {
    getState: () => ({
      status: 'routing',
      setStatus: mocks.setStatus,
      setError: mocks.setError,
    }),
  },
}));
vi.mock('../state/gamification-store', () => ({
  useGamificationStore: { getState: () => ({ receive: vi.fn() }) },
}));
vi.mock('./jarvis-screen-context', () => ({ buildJarvisContext: () => ({}) }));
vi.mock('./voice-live-ipc', () => ({
  clearJarvisMcpSession: mocks.clearJarvisMcpSession,
  errMsg: (error: unknown) => error instanceof Error ? error.message : String(error),
  logVoiceEvent: vi.fn(),
  liveStatus: vi.fn(),
  queueLiveContextRefresh: vi.fn(),
}));
vi.mock('./voice-session-state', () => ({
  REALTIME_PROVIDER_AUDIO_ENABLED: true,
  bumpRealtimeNativeToolInFlight: vi.fn(),
  ensureLivePlayer: () => ({ stop: vi.fn() }),
  lastRealtimeNativeToolAt: 0,
  realtimeAudioPlayedCounter: { total: 0 },
  realtimeNativeToolInFlight: 0,
  setLastRealtimeNativeToolAt: vi.fn(),
  setLastRealtimeNativeToolCallId: vi.fn(),
  setSuppressRealtimeAudioOut: vi.fn(),
  turnExecution: {
    currentToken: 1,
    owner: null,
    claimRealtimeTool: () => true,
  },
  wakeMic: { suppressWakeDetection: vi.fn() },
}));
vi.mock('./voice-live-audio-out', () => ({
  openLiveAudioGate: vi.fn(),
  resetPendingRealtimeAudioOut: vi.fn(),
}));
vi.mock('./voice-realtime-gates', () => ({ isRealtimeLive: () => true }));
vi.mock('./voice-playback', () => ({
  stopAllPlayback: vi.fn(),
  bindWakeSuppressor: vi.fn(),
  playAudioBase64: vi.fn(),
}));
vi.mock('./voice-speak-pipeline', () => ({
  speakAndPlayPipelined: vi.fn(async () => ({ ok: true })),
}));
vi.mock('./live-followup', () => ({
  cancelLiveFollowUp: mocks.cancelLiveFollowUp,
}));

import { executeRealtimeToolCall } from './voice-realtime-tools';

function actionFor(tool: string): JarvisAction {
  return { type: 'mcp_tool', tool, args: {} };
}

describe('Realtime MCP result propagation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('window', {
      nexus: {
        voice: { liveToolResult: mocks.liveToolResult },
        gamification: { recordJarvisAction: mocks.recordJarvisAction },
      },
    });
  });

  it.each([
    {
      tool: 'nexus_file_read',
      marker: 'FILE_READ_LIVE_MARKER_91cc',
      result: {
        path: 'src/live-marker.ts',
        content: 'payload:FILE_READ_LIVE_MARKER_91cc',
      },
    },
    {
      tool: 'nexus_pane_read',
      marker: 'PANE_READ_LIVE_MARKER_82dd',
      result: 'pane-tail:PANE_READ_LIVE_MARKER_82dd',
    },
  ])('sends the preserved $tool payload in the Live tool response', async ({
    tool,
    marker,
    result,
  }) => {
    mocks.executeJarvisAction.mockResolvedValueOnce({
      sayText: '',
      toolResult: {
        tool: 'mcp_tool',
        ok: true,
        summary: `${tool} ok`,
        output: result,
      },
    });

    await executeRealtimeToolCall({
      sessionId: 'live-session',
      source: 'realtime',
      callId: `call-${tool}`,
      name: 'nexus_action',
      tool: 'mcp_tool',
      summary: tool,
      args: { action: 'mcp_tool', tool, args: {} },
      at: 1,
    });

    expect(mocks.executeJarvisAction).toHaveBeenCalledWith(
      { say: '', action: actionFor(tool) },
      {},
      expect.objectContaining({
        signal: expect.anything(),
        onEffectMayHaveCommitted: expect.any(Function),
      }),
    );
    expect(mocks.cancelLiveFollowUp).toHaveBeenCalledTimes(1);
    expect(mocks.liveToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        callId: `call-${tool}`,
        output: expect.objectContaining({
          result,
        }),
      }),
    );
    expect(JSON.stringify(mocks.liveToolResult.mock.calls[0]?.[0])).toContain(marker);
  });
});
