import { beforeEach, describe, expect, it } from 'vitest';
import {
  classifyLiveRescueSnapshot,
  hasInsufficientLiveMicFrames,
  LIVE_RESCUE_RESPONSE_TIMEOUT_MS,
  liveMuteRescueCount,
  markLiveMuteRescueAttempt,
  markLiveMicFrameOffered,
  MIN_USABLE_LIVE_MIC_FRAMES,
  resetLiveMuteRescues,
  resetOfferedLiveMicFramesThisTurn,
  shouldAttemptLiveMuteRescue,
  offeredLiveMicFramesThisTurn,
  waitForLiveRescueEvidence,
} from './live-mute-rescue';

beforeEach(() => {
  resetLiveMuteRescues();
  resetOfferedLiveMicFramesThisTurn();
});

describe('live mute rescue', () => {
  it('keeps mute fallback inside an interactive latency budget', () => {
    expect(LIVE_RESCUE_RESPONSE_TIMEOUT_MS).toBe(3_500);
  });

  it('treats zero or one socket frame as insufficient Live capture', () => {
    expect(hasInsufficientLiveMicFrames(0)).toBe(true);
    expect(hasInsufficientLiveMicFrames(1)).toBe(true);
    expect(hasInsufficientLiveMicFrames(MIN_USABLE_LIVE_MIC_FRAMES)).toBe(false);

    expect(
      shouldAttemptLiveMuteRescue({
        realtimeIsOwner: true,
        localSpeechUsable: true,
        explicitCapture: true,
        offeredFrames: 0,
      }),
    ).toBe(true);
    expect(
      shouldAttemptLiveMuteRescue({
        realtimeIsOwner: true,
        localSpeechUsable: true,
        explicitCapture: true,
        offeredFrames: 1,
      }),
    ).toBe(true);
    expect(
      shouldAttemptLiveMuteRescue({
        realtimeIsOwner: true,
        localSpeechUsable: true,
        explicitCapture: true,
        offeredFrames: 2,
      }),
    ).toBe(false);
    expect(
      shouldAttemptLiveMuteRescue({
        realtimeIsOwner: true,
        localSpeechUsable: true,
        explicitCapture: false,
        offeredFrames: 0,
      }),
    ).toBe(false);
    // Automatic follow-up expiry never turns ambient audio into rescue text.
    expect(
      shouldAttemptLiveMuteRescue({
        realtimeIsOwner: true,
        localSpeechUsable: true,
        explicitCapture: false,
        offeredFrames: 40,
        captureReason: 'reply',
        followUpAuthorized: false,
      }),
    ).toBe(false);
    expect(
      shouldAttemptLiveMuteRescue({
        realtimeIsOwner: true,
        localSpeechUsable: true,
        explicitCapture: false,
        offeredFrames: 0,
        captureReason: 'reply',
        followUpAuthorized: true,
      }),
    ).toBe(true);
  });

  it('waits for real provider evidence and rejects a superseded turn', async () => {
    let now = 1_000;
    let playedAudioChunks = 4;
    const read = () => ({
      turnToken: 7,
      playedAudioChunks,
      heldAudioChunks: 2,
      toolInFlight: 0,
      lastToolAt: 0,
    });
    const result = await waitForLiveRescueEvidence({
      turnToken: 7,
      startedAt: 1_000,
      playedBaseline: 4,
      heldBaseline: 2,
      read,
      now: () => now,
      delay: async () => {
        now += 50;
        playedAudioChunks += 1;
      },
      timeoutMs: 500,
    });
    expect(result).toBe('audio');

    await expect(
      waitForLiveRescueEvidence({
        turnToken: 8,
        startedAt: 1_000,
        playedBaseline: 0,
        heldBaseline: 0,
        read,
        now: () => now,
        delay: async () => {},
      }),
    ).resolves.toBe('superseded');
  });

  it('classifica uma leitura do provider com a regra única do rescue e da espera do transcript', () => {
    const base = { turnToken: 7, startedAt: 1_000, playedBaseline: 4, heldBaseline: 2 };
    const idle = {
      turnToken: 7,
      playedAudioChunks: 4,
      heldAudioChunks: 2,
      toolInFlight: 0,
      lastToolAt: 0,
    };

    expect(classifyLiveRescueSnapshot(idle, base)).toBeNull();
    // Áudio acima da base do TURNO (tocado ou retido) é resposta do provider.
    expect(classifyLiveRescueSnapshot({ ...idle, playedAudioChunks: 5 }, base)).toBe('audio');
    expect(classifyLiveRescueSnapshot({ ...idle, heldAudioChunks: 3 }, base)).toBe('audio');
    // Tool: em curso, disparada depois do início, ou ainda dona do turno.
    expect(classifyLiveRescueSnapshot({ ...idle, toolInFlight: 1 }, base)).toBe('tool');
    expect(classifyLiveRescueSnapshot({ ...idle, lastToolAt: 1_000 }, base)).toBe('tool');
    expect(classifyLiveRescueSnapshot({ ...idle, lastToolAt: 999 }, base)).toBeNull();
    expect(classifyLiveRescueSnapshot({ ...idle, toolOwnsTurn: true }, base)).toBe('tool');
    expect(classifyLiveRescueSnapshot({ ...idle, toolOwnsTurn: false }, base)).toBeNull();
    // Tool vence áudio (a tool é prova definitiva); outro turno vence tudo.
    expect(
      classifyLiveRescueSnapshot({ ...idle, playedAudioChunks: 9, toolInFlight: 1 }, base),
    ).toBe('tool');
    expect(
      classifyLiveRescueSnapshot({ ...idle, turnToken: 8, toolInFlight: 1, playedAudioChunks: 9 }, base),
    ).toBe('superseded');
  });

  it('o áudio que o provider tocou ANTES do fim da captura conta com a base do turno', async () => {
    // Regressão: server_vad responde antes do endpoint local. Com a base lida
    // no fim da captura (4 chunks já tocados), nenhum chunk novo chegava e o
    // wait estourava em 'timeout' -> Classic. Com a base do turno (0) é áudio.
    const read = () => ({
      turnToken: 7,
      playedAudioChunks: 4,
      heldAudioChunks: 0,
      toolInFlight: 0,
      lastToolAt: 0,
    });
    let now = 5_000;
    const fromCaptureEnd = await waitForLiveRescueEvidence({
      turnToken: 7,
      startedAt: 5_000,
      playedBaseline: 4,
      heldBaseline: 0,
      read,
      now: () => now,
      delay: async (ms) => {
        now += ms;
      },
      timeoutMs: 500,
    });
    expect(fromCaptureEnd).toBe('timeout');

    now = 5_000;
    const fromTurnStart = await waitForLiveRescueEvidence({
      turnToken: 7,
      startedAt: 5_000,
      playedBaseline: 0,
      heldBaseline: 0,
      read,
      now: () => now,
      delay: async (ms) => {
        now += ms;
      },
      timeoutMs: 500,
    });
    expect(fromTurnStart).toBe('audio');
    expect(now).toBe(5_000); // evidência imediata, sem gastar o orçamento
  });

  it('bounds consecutive rescue attempts and tracks socket frames', () => {
    expect(markLiveMuteRescueAttempt()).toBe(1);
    expect(markLiveMuteRescueAttempt()).toBe(2);
    expect(liveMuteRescueCount()).toBe(2);
    expect(
      shouldAttemptLiveMuteRescue({
        realtimeIsOwner: true,
        localSpeechUsable: true,
        explicitCapture: true,
        offeredFrames: 0,
      }),
    ).toBe(false);
    markLiveMicFrameOffered();
    markLiveMicFrameOffered();
    expect(offeredLiveMicFramesThisTurn()).toBe(2);
  });
});
