import { describe, expect, it } from 'vitest';
import { voiceHudStatusFromLiveState } from './live-hud-state';
import type { JarvisLiveState } from '../../shared/voice-ipc';

const base: JarvisLiveState = {
  enabled: true,
  sessionId: 'live-1',
  status: 'listening',
  realtimeReady: true,
  startedAt: 1,
  lastActiveAt: 1,
  turns: 0,
  pendingMic: false,
};

describe('voiceHudStatusFromLiveState', () => {
  it('does not close the HUD when realtime goes dormant during local capture', () => {
    expect(
      voiceHudStatusFromLiveState({ ...base, status: 'dormant' }, true),
    ).toBeNull();
  });

  it('closes the HUD when dormant arrives after capture ended', () => {
    expect(
      voiceHudStatusFromLiveState({ ...base, status: 'dormant' }, false),
    ).toBe('idle');
  });

  it('mirrors speaking and active listening states', () => {
    expect(
      voiceHudStatusFromLiveState({ ...base, status: 'speaking' }, true),
    ).toBe('speaking');
    expect(voiceHudStatusFromLiveState(base, true)).toBe('listening');
  });
});
