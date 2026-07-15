import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classicSuppressedByRealtimeOwner,
  shouldFallbackClassicAfterRealtimeMute,
} from './realtime-ownership';

describe('classicSuppressedByRealtimeOwner — DEFECT 1: per-SESSION ownership', () => {
  it('suppresses Classic on a wake turn while realtime is live (owner)', () => {
    expect(
      classicSuppressedByRealtimeOwner({ captureReason: 'wake', isRealtimeLive: true }),
    ).toBe(true);
  });

  it('suppresses Classic on a click turn while realtime is live', () => {
    expect(
      classicSuppressedByRealtimeOwner({ captureReason: 'click', isRealtimeLive: true }),
    ).toBe(true);
  });

  it('does NOT suppress when realtime is not live (legit degradation → Classic)', () => {
    expect(
      classicSuppressedByRealtimeOwner({ captureReason: 'wake', isRealtimeLive: false }),
    ).toBe(false);
  });

  it('P1: suppresses reply follow-on while Live owns (no Classic racer)', () => {
    expect(
      classicSuppressedByRealtimeOwner({ captureReason: 'reply', isRealtimeLive: true }),
    ).toBe(true);
  });

  it('P1: suppresses manual/ptt while Live owns the session', () => {
    expect(
      classicSuppressedByRealtimeOwner({ captureReason: 'manual', isRealtimeLive: true }),
    ).toBe(true);
    expect(
      classicSuppressedByRealtimeOwner({ captureReason: 'ptt', isRealtimeLive: true }),
    ).toBe(true);
  });
});

describe('Live mute degradation', () => {
  it('falls back for explicit user captures but not ambient reply follow-ups', () => {
    for (const captureReason of ['wake', 'click', 'manual', 'ptt'] as const) {
      expect(shouldFallbackClassicAfterRealtimeMute(captureReason)).toBe(true);
    }
    expect(shouldFallbackClassicAfterRealtimeMute('reply')).toBe(false);
  });

  it('finishAndProcess keeps reply mute idle and degrades explicit captures', () => {
    const source = fs.readFileSync(
      path.join(__dirname, 'voice-finish-and-process.ts'),
      'utf-8',
    );
    expect(source).toContain(
      'const explicitCapture = shouldFallbackClassicAfterRealtimeMute',
    );
    expect(source).toContain('shouldAttemptLiveMuteRescue');
    expect(source).toContain('jarvis.replyMuteIdle');
    expect(source).toContain('jarvis.realtimeMuteDegraded');
  });

  it('wires a silent authorized Live rescue into the Classic fallback path', () => {
    const source = fs.readFileSync(
      path.join(__dirname, 'voice-finish-and-process.ts'),
      'utf-8',
    );
    expect(source).toContain('liveAnswerOutcomeFromEvidence(evidence)');
    expect(source).toContain('rescueShouldDegradeToClassic = true');
    expect(source).toContain('!rescueShouldDegradeToClassic');
  });

  it('requires answer evidence before final-transcript Live ownership commits', () => {
    const source = fs.readFileSync(
      path.join(__dirname, 'voice-finish-and-process.ts'),
      'utf-8',
    );
    const providerGate = source.indexOf(
      'shouldLetRealtimeProviderAnswer(transcript',
    );
    const evidenceWait = source.indexOf(
      'const answerEvidence = await waitForLiveRescueEvidence',
      providerGate,
    );
    const classicBridge = source.indexOf(
      "await quiesceLiveForClassic('classic-live-bridge')",
      evidenceWait,
    );
    const evidenceBlock = source.slice(evidenceWait, classicBridge);

    expect(providerGate).toBeGreaterThanOrEqual(0);
    expect(evidenceWait).toBeGreaterThan(providerGate);
    expect(classicBridge).toBeGreaterThan(evidenceWait);
    expect(evidenceBlock).toContain('playedBaseline: playedChunksBaseline');
    expect(evidenceBlock).toContain('heldBaseline: heldChunksBaseline');
    expect(evidenceBlock).toContain('liveAnswerOutcomeFromEvidence(answerEvidence)');
    expect(evidenceBlock).toContain('jarvis.liveProviderMuteDegraded');
  });

  it('keeps Gemini warm until local STT proves a muted wake is meaningful', () => {
    const source = fs.readFileSync(
      path.join(__dirname, 'voice-finish-and-process.ts'),
      'utf-8',
    );
    const muteIdx = source.indexOf('quiesceLiveBeforeClassic = true;');
    const discardIdx = source.indexOf(
      'if (isDiscardableTranscript(transcript, { inConversation }))',
      muteIdx,
    );
    const suppressIdx = source.indexOf('setSuppressRealtimeAudioOut(true);', muteIdx);
    const endTurnIdx = source.indexOf('setRealtimeTurnActive(false);', muteIdx);
    const quiesceIdx = source.indexOf("await quiesceLiveForClassic('classic-action-bridge-timeout');");
    expect(muteIdx).toBeGreaterThanOrEqual(0);
    expect(discardIdx).toBeGreaterThan(muteIdx);
    expect(suppressIdx).toBeGreaterThan(discardIdx);
    expect(endTurnIdx).toBeGreaterThan(discardIdx);
    expect(quiesceIdx).toBeGreaterThan(discardIdx);
    expect(source).toContain("cancelMutedLiveValidation('classic-validation-discarded')");
  });
});
