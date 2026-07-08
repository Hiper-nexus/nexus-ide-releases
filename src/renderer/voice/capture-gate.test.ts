import { describe, expect, it } from 'vitest';
import { hasUsableLocalSpeech, shouldDiscardBeforeRealtime } from './capture-gate';

const MIN_SPEECH_SEC = 0.25;

describe('capture-gate', () => {
  it('treats local speech below the RMS gate as unusable', () => {
    expect(
      hasUsableLocalSpeech({
        wavBase64: 'wav',
        durationSec: 2,
        heardSpeech: false,
        minSpeechSec: MIN_SPEECH_SEC,
      }),
    ).toBe(false);
  });

  it('does not discard low local RMS before a realtime transcript can arrive', () => {
    expect(
      shouldDiscardBeforeRealtime(
        {
          wavBase64: 'wav',
          durationSec: 2,
          heardSpeech: false,
          minSpeechSec: MIN_SPEECH_SEC,
        },
        { shouldTryRealtime: true, hasQueuedRealtimeTranscript: false },
      ),
    ).toBe(false);
  });

  it('keeps an already queued realtime transcript even without local speech', () => {
    expect(
      shouldDiscardBeforeRealtime(
        {
          wavBase64: '',
          durationSec: 0,
          heardSpeech: false,
          minSpeechSec: MIN_SPEECH_SEC,
        },
        { shouldTryRealtime: false, hasQueuedRealtimeTranscript: true },
      ),
    ).toBe(false);
  });

  it('discards silence when no realtime transcript path is active', () => {
    expect(
      shouldDiscardBeforeRealtime(
        {
          wavBase64: 'wav',
          durationSec: 2,
          heardSpeech: false,
          minSpeechSec: MIN_SPEECH_SEC,
        },
        { shouldTryRealtime: false, hasQueuedRealtimeTranscript: false },
      ),
    ).toBe(true);
  });
});
