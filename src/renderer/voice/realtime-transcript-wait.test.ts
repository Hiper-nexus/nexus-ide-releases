import { describe, expect, it } from 'vitest';
import {
  CLICK_REALTIME_TRANSCRIPT_WAIT_MS,
  LOCAL_SPEECH_REALTIME_TRANSCRIPT_WAIT_MS,
  REALTIME_TRANSCRIPT_WAIT_MS,
  realtimeTranscriptWaitMs,
  WAKE_REALTIME_TRANSCRIPT_WAIT_MS,
} from './realtime-transcript-wait';

describe('realtimeTranscriptWaitMs', () => {
  it('keeps manual and push-to-talk turns snappy', () => {
    expect(realtimeTranscriptWaitMs('manual')).toBe(REALTIME_TRANSCRIPT_WAIT_MS);
    expect(realtimeTranscriptWaitMs('ptt')).toBe(REALTIME_TRANSCRIPT_WAIT_MS);
    expect(realtimeTranscriptWaitMs('reply')).toBe(REALTIME_TRANSCRIPT_WAIT_MS);
  });

  it('gives hands-free wake turns more room to receive a final realtime transcript', () => {
    expect(realtimeTranscriptWaitMs('wake')).toBe(WAKE_REALTIME_TRANSCRIPT_WAIT_MS);
    expect(realtimeTranscriptWaitMs('click')).toBe(CLICK_REALTIME_TRANSCRIPT_WAIT_MS);
  });

  it('falls back quickly when wake/click already has usable local speech', () => {
    expect(realtimeTranscriptWaitMs('wake', { localSpeechUsable: true })).toBe(
      LOCAL_SPEECH_REALTIME_TRANSCRIPT_WAIT_MS,
    );
    expect(realtimeTranscriptWaitMs('click', { localSpeechUsable: true })).toBe(
      LOCAL_SPEECH_REALTIME_TRANSCRIPT_WAIT_MS,
    );
  });

  it('does not shorten manual turns further', () => {
    expect(realtimeTranscriptWaitMs('manual', { localSpeechUsable: true })).toBe(
      REALTIME_TRANSCRIPT_WAIT_MS,
    );
  });

  it('MUTE FIX: when realtime OWNS the turn, keeps the full window despite usable local speech', () => {
    // No Classic STT to hand off to (per-session ownership) → the 1.2s shortcut
    // would only guarantee a timeout into silence. Owner turns wait the full
    // wake/click budget so the realtime transcript can arrive and release audio.
    expect(
      realtimeTranscriptWaitMs('wake', { localSpeechUsable: true, realtimeIsOwner: true }),
    ).toBe(WAKE_REALTIME_TRANSCRIPT_WAIT_MS);
    expect(
      realtimeTranscriptWaitMs('click', { localSpeechUsable: true, realtimeIsOwner: true }),
    ).toBe(CLICK_REALTIME_TRANSCRIPT_WAIT_MS);
  });

  it('MUTE FIX: still shortens when realtime is NOT the owner (Classic will run)', () => {
    expect(
      realtimeTranscriptWaitMs('wake', { localSpeechUsable: true, realtimeIsOwner: false }),
    ).toBe(LOCAL_SPEECH_REALTIME_TRANSCRIPT_WAIT_MS);
  });
});
