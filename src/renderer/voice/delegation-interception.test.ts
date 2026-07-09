/**
 * Integração da interceptação C3 em runJarvisTurn (follow-up 3i): módulo REAL
 * de delegation-confirm + runJarvisTurn real; TODOS os efeitos (stores, IPC,
 * TTS, pane) são mocks. Prova: dispatch escreve no pane e pula o cérebro;
 * cancel não escreve; drop avisa no HUD e SEGUE pro cérebro.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type React from 'react';

const setStatus = vi.fn();
const setSpoken = vi.fn();
const setNote = vi.fn();
const storeState = {
  setStatus,
  setSpoken,
  setNote,
  status: 'idle',
  info: undefined,
} as Record<string, unknown>;

vi.mock('./voice-store', () => ({
  useVoiceStore: { getState: () => storeState },
}));
vi.mock('../state/gamification-store', () => ({
  useGamificationStore: { getState: () => ({ receive: vi.fn() }) },
}));
const writeToPane = vi.fn(() => true);
vi.mock('../terminal/terminal-host', () => ({
  writeToPane: (...a: unknown[]) => writeToPane(...(a as [])),
  getPaneSessionId: vi.fn(() => null),
}));
vi.mock('../state/layout-store', () => ({
  useLayoutStore: { getState: () => ({ focusedPaneId: null, root: null }) },
}));
vi.mock('../state/session-state-store', () => ({
  useSessionStateStore: { subscribe: vi.fn(() => () => {}) },
}));
vi.mock('./jarvis-screen-context', () => ({
  buildJarvisContext: () => ({}),
  findOrchestratorPane: () => null,
}));
const logVoiceEvent = vi.fn();
const liveEndTurn = vi.fn();
vi.mock('./voice-live-ipc', () => ({
  liveEndTurn: (...a: unknown[]) => liveEndTurn(...(a as [])),
  liveStatus: vi.fn(),
  logVoiceEvent: (...a: unknown[]) => logVoiceEvent(...(a as [])),
  queueLiveContextRefresh: vi.fn(),
}));
vi.mock('./voice-session-state', () => ({
  activeCaptureReason: 'reply',
  jarvisHistory: [],
  jarvisLastTurnAt: 0,
  livePlayer: null,
  realtimeTurnActive: false,
  setJarvisHistory: vi.fn(),
  setJarvisLastTurnAt: vi.fn(),
  setSuppressRealtimeAudioOut: vi.fn(),
  turnExecution: { currentToken: 1, claim: vi.fn(() => true), owner: null },
  wakeMic: { suppressWakeDetection: vi.fn() },
}));
vi.mock('./voice-realtime-gates', () => ({
  isJarvisLiveEnabled: () => false,
  isRealtimeLive: () => false,
  canAttemptRealtime: () => false,
}));
vi.mock('./voice-speak-pipeline', () => ({
  speakAndPlayPipelined: vi.fn(async () => ({ ok: true, cancelled: false, playedMs: 100 })),
  withTimeout: <T,>(p: Promise<T>) => p,
}));
vi.mock('./voice-realtime-tools', () => ({
  executeJarvisActionForTurn: vi.fn(async (reply: { say: string }) => ({
    sayText: reply.say,
    toolResult: null,
  })),
  speakViaLiveProvider: vi.fn(async () => false),
}));
vi.mock('./jarvis-reply-loop', () => ({
  delay: async () => {},
  noteAutoReplyOpened: vi.fn(),
  shouldReopenJarvisListening: () => false,
}));
vi.mock('./voice-echo-guard', () => ({
  buildReplyAutoStop: vi.fn(),
  REPLY_MIN_LISTEN_MS: 0,
}));
vi.mock('./voice-suppression-window', () => ({
  estimatedSpeechMs: () => 0,
  playbackWakeSuppressionMs: () => 0,
  replyReopenDelayMs: () => 0,
  TTS_TAIL_GUARD_MS: 0,
}));
vi.mock('./response-echo', () => ({ stripPromptEcho: (b: string) => b }));

import { runJarvisTurn, type RunJarvisTurnDeps } from './voice-run-jarvis-turn';
import {
  clearPendingDelegation,
  peekPendingDelegation,
  setPendingDelegation,
} from './delegation-confirm';
import type { VoiceCapture } from './voice-capture';

const brain = vi.fn(async () => ({ say: 'resposta do cérebro', action: { type: 'none' } }));

const deps: RunJarvisTurnDeps = {
  beginListening: vi.fn(async () => {}),
  isListening: () => false,
  finishAndProcess: vi.fn(async () => {}),
};

function busyRef(): React.MutableRefObject<boolean> {
  return { current: true };
}

async function turn(transcript: string): Promise<void> {
  await runJarvisTurn(transcript, {} as VoiceCapture, busyRef(), 1, deps);
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPendingDelegation();
  vi.stubGlobal('window', {
    nexus: {
      voice: {
        liveInterrupt: vi.fn(async () => {}),
        recordEcho: vi.fn(async () => {}),
        jarvis: brain,
      },
      gamification: { recordJarvisAction: vi.fn(async () => ({})) },
    },
  });
});

const pending = () =>
  setPendingDelegation({ targetPaneId: 'pane-orq', text: 'Fix login bug', createdAt: Date.now() });

describe('interceptação C3 em runJarvisTurn (follow-up 3i)', () => {
  it('"sim" com pendência → escreve no pane alvo e NUNCA chama o cérebro', async () => {
    pending();
    await turn('sim');
    expect(writeToPane).toHaveBeenCalledWith('pane-orq', 'Fix login bug\n');
    expect(brain).not.toHaveBeenCalled();
    expect(peekPendingDelegation(Date.now())).toBeNull();
  });

  it('"não, cancela" com pendência → não escreve, não chama o cérebro', async () => {
    pending();
    await turn('não, cancela');
    expect(writeToPane).not.toHaveBeenCalled();
    expect(brain).not.toHaveBeenCalled();
    expect(logVoiceEvent).toHaveBeenCalledWith(
      'info',
      'jarvis.delegationCancelled',
      expect.any(String),
      expect.any(Object),
    );
  });

  it('outro assunto com pendência → drop AVISADO no HUD e o turno segue pro cérebro', async () => {
    pending();
    await turn('abre o navegador pra mim');
    expect(writeToPane).not.toHaveBeenCalled();
    expect(setNote).toHaveBeenCalledWith(expect.stringContaining('descartada'));
    expect(logVoiceEvent).toHaveBeenCalledWith(
      'info',
      'jarvis.delegationDropped',
      expect.any(String),
      expect.any(Object),
    );
    expect(brain).toHaveBeenCalledTimes(1);
    expect(peekPendingDelegation(Date.now())).toBeNull();
  });

  it('sem pendência, "sim" é turno normal → cérebro chamado', async () => {
    await turn('sim');
    expect(brain).toHaveBeenCalledTimes(1);
    expect(writeToPane).not.toHaveBeenCalled();
  });
});
