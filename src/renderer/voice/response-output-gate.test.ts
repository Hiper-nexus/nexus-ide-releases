import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useVoiceStore } from './voice-store';
import {
  isResponseMuted,
  setResponseMuted,
  stopJarvisSpeech,
  powerOffJarvis,
} from './response-output-gate';

vi.mock('./voice-playback', () => ({
  stopAllPlayback: vi.fn(),
}));

vi.mock('./live-followup', () => ({
  cancelLiveFollowUp: vi.fn(),
}));

vi.mock('./live-local-audio-gate', () => ({
  clearLocalAudioGate: vi.fn(),
}));

vi.mock('./voice-live-ipc', () => ({
  logVoiceEvent: vi.fn(),
}));

vi.mock('./voice-session-state', () => ({
  livePlayer: { stop: vi.fn() },
  resetPendingRealtimeAudioOut: vi.fn(),
  setRealtimeTurnActive: vi.fn(),
  setSuppressRealtimeAudioOut: vi.fn(),
}));

describe('response-output-gate', () => {
  beforeEach(() => {
    useVoiceStore.setState({
      responseMuted: false,
      status: 'idle',
      note: null,
    });
    vi.stubGlobal('window', {
      nexus: {
        voice: {
          liveInterrupt: vi.fn(async () => ({})),
          liveStop: vi.fn(async () => ({
            enabled: true,
            sessionId: null,
            status: 'off',
            realtimeReady: false,
            startedAt: null,
            turns: 0,
            lastActivityAt: null,
            error: null,
          })),
          liveHardTeardown: vi.fn(async () => ({
            enabled: true,
            sessionId: null,
            status: 'off',
            realtimeReady: false,
            startedAt: null,
            turns: 0,
            lastActivityAt: null,
            error: null,
          })),
        },
      },
    });
  });

  it('toggles mute in the voice store', () => {
    setResponseMuted(true);
    expect(isResponseMuted()).toBe(true);
    expect(useVoiceStore.getState().responseMuted).toBe(true);
    expect(useVoiceStore.getState().note).toContain('silêncio');
    setResponseMuted(false);
    expect(isResponseMuted()).toBe(false);
  });

  it('stopJarvisSpeech interrupts live output', () => {
    useVoiceStore.setState({ status: 'speaking' });
    stopJarvisSpeech();
    expect(window.nexus.voice.liveInterrupt).toHaveBeenCalledWith('ui-stop');
    expect(useVoiceStore.getState().status).toBe('idle');
  });

  it('powerOffJarvis stops the live session', async () => {
    await powerOffJarvis();
    expect(window.nexus.voice.liveStop).toHaveBeenCalled();
    expect(useVoiceStore.getState().status).toBe('idle');
    expect(useVoiceStore.getState().note).toContain('desligada');
  });

  it('powerOffJarvis falls back to hard teardown when stop fails', async () => {
    vi.mocked(window.nexus.voice.liveStop).mockRejectedValueOnce(
      new Error('voice live session has no owner'),
    );
    await powerOffJarvis();
    expect(window.nexus.voice.liveHardTeardown).toHaveBeenCalled();
  });
});
