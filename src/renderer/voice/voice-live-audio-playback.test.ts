/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  play: vi.fn(),
  playbackReport: vi.fn(),
  setStatus: vi.fn(),
  log: vi.fn(),
  resetMuteRescues: vi.fn(),
  suppressWakeDetection: vi.fn(),
  playedTick: vi.fn(() => ({ fire: true, count: 1 })),
  suppressedTick: vi.fn(() => ({ fire: false, count: 0 })),
}));

vi.mock('./voice-store', () => ({
  useVoiceStore: {
    getState: () => ({ setStatus: mocks.setStatus }),
  },
}));

vi.mock('./voice-live-ipc', () => ({ logVoiceEvent: mocks.log }));

vi.mock('./live-mute-rescue', () => ({
  resetLiveMuteRescues: mocks.resetMuteRescues,
}));

vi.mock('./voice-session-state', () => ({
  dropRealtimeAudioOut: false,
  ensureLivePlayer: () => ({ play: mocks.play }),
  pushPendingRealtimeAudioOut: vi.fn(),
  realtimeAudioPlayedCounter: { tick: mocks.playedTick },
  realtimeAudioSuppressedCounter: { tick: mocks.suppressedTick },
  realtimeTurnActive: true,
  resetPendingRealtimeAudioOut: vi.fn(),
  setDropRealtimeAudioOut: vi.fn(),
  setSuppressRealtimeAudioOut: vi.fn(),
  suppressRealtimeAudioOut: false,
  takePendingRealtimeAudioOut: () => [],
  wakeMic: { suppressWakeDetection: mocks.suppressWakeDetection },
}));

import { playRealtimeAudioOut } from './voice-live-audio-out';

describe('Live renderer playback evidence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        voice: { liveAudioPlayback: mocks.playbackReport },
      },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'nexus');
  });

  it('reports started only after WebAudio schedules the exact PCM delivery', async () => {
    let resolvePlayback!: (durationMs: number) => void;
    mocks.play.mockReturnValue(
      new Promise<number>((resolve) => {
        resolvePlayback = resolve;
      }),
    );

    playRealtimeAudioOut({ id: '5e04e44e-c77f-40aa-b65d-36d8b693dddf', pcm16: 'AQI=' });
    await Promise.resolve();
    expect(mocks.playbackReport).not.toHaveBeenCalled();
    expect(mocks.playedTick).not.toHaveBeenCalled();

    resolvePlayback(80);
    await vi.waitFor(() =>
      expect(mocks.playbackReport).toHaveBeenCalledWith({
        id: '5e04e44e-c77f-40aa-b65d-36d8b693dddf',
        outcome: 'started',
        error: undefined,
      }),
    );

    expect(mocks.playedTick).toHaveBeenCalledOnce();
    expect(mocks.setStatus).toHaveBeenCalledWith('speaking');
    expect(mocks.suppressWakeDetection).toHaveBeenCalledOnce();
  });

  it('reports failed and never advances audio evidence when WebAudio rejects', async () => {
    mocks.play.mockRejectedValue(new Error('sink rejected'));

    playRealtimeAudioOut({ id: 'f8a0c64d-b09c-43b0-a3fc-707496efa769', pcm16: 'AQI=' });

    await vi.waitFor(() =>
      expect(mocks.playbackReport).toHaveBeenCalledWith({
        id: 'f8a0c64d-b09c-43b0-a3fc-707496efa769',
        outcome: 'failed',
        error: 'sink rejected',
      }),
    );

    expect(mocks.playedTick).not.toHaveBeenCalled();
    expect(mocks.setStatus).not.toHaveBeenCalled();
  });
});
