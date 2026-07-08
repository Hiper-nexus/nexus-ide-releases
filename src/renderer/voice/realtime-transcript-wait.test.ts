import { describe, expect, it } from 'vitest';
import {
  CLICK_REALTIME_TRANSCRIPT_WAIT_MS,
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
});
