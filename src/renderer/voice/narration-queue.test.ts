import { describe, expect, it, vi } from 'vitest';
import {
  NarrationQueue,
  canStartNarration,
  narrationStillOwnsVoice,
  type NarrationVoiceState,
} from './narration-queue';

const freeVoice: NarrationVoiceState = {
  status: 'idle',
  turnBusy: false,
  wakeOpening: false,
  listening: false,
  realtimeTurnActive: false,
  liveAudioPending: false,
  localAudioAudible: false,
  halted: false,
};

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('NarrationQueue', () => {
  it('retains report-back while voice is busy and drains when idle', async () => {
    let idle = false;
    const play = vi.fn(async () => {});
    const queue = new NarrationQueue({ canPlay: () => idle, play });

    queue.enqueue('Worker terminou os testes.');
    await settle();
    expect(play).not.toHaveBeenCalled();
    expect(queue.size).toBe(1);

    idle = true;
    queue.kick();
    await settle();
    expect(play).toHaveBeenCalledWith('Worker terminou os testes.');
    expect(queue.size).toBe(0);
  });

  it('serializes messages and ignores an adjacent duplicate', async () => {
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const played: string[] = [];
    const queue = new NarrationQueue({
      canPlay: () => true,
      play: async (text) => {
        played.push(text);
        if (played.length === 1) await first;
      },
    });

    queue.enqueue('primeiro');
    queue.enqueue('primeiro');
    queue.enqueue('segundo');
    queue.enqueue('segundo');
    await settle();
    expect(played).toEqual(['primeiro']);
    // A duplicated IPC event arriving while the first narration is playing
    // must not enqueue the same audio a second time.
    queue.enqueue('primeiro');
    releaseFirst();
    await settle();
    await settle();
    expect(played).toEqual(['primeiro', 'segundo']);
  });

  it('continues after one narration fails', async () => {
    const onError = vi.fn();
    const play = vi
      .fn<(text: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('tts unavailable'))
      .mockResolvedValue(undefined);
    const queue = new NarrationQueue({ canPlay: () => true, play, onError });

    queue.enqueue('um');
    queue.enqueue('dois');
    await settle();
    await settle();

    expect(play).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe('F-1545 narration vs wake', () => {
  it('does not start while handleWake passes through idle with the turn busy', () => {
    expect(canStartNarration(freeVoice)).toBe(true);
    // handleWake: busy=true + setStatus('idle') antes de a captura abrir.
    expect(canStartNarration({ ...freeVoice, turnBusy: true })).toBe(false);
    expect(canStartNarration({ ...freeVoice, wakeOpening: true })).toBe(false);
    expect(canStartNarration({ ...freeVoice, listening: true })).toBe(false);
    expect(canStartNarration({ ...freeVoice, realtimeTurnActive: true })).toBe(false);
    expect(canStartNarration({ ...freeVoice, liveAudioPending: true })).toBe(false);
    expect(canStartNarration({ ...freeVoice, localAudioAudible: true })).toBe(false);
    expect(canStartNarration({ ...freeVoice, halted: true })).toBe(false);
  });

  it('keeps the voice only while its own speaking status survives synthesis', () => {
    const speaking = { ...freeVoice, status: 'speaking' };
    expect(narrationStillOwnsVoice(speaking)).toBe(true);
    // wake chegou durante a síntese de 5-8 s do relato
    expect(narrationStillOwnsVoice({ ...speaking, status: 'idle' })).toBe(false);
    expect(narrationStillOwnsVoice({ ...speaking, status: 'listening' })).toBe(false);
    expect(narrationStillOwnsVoice({ ...speaking, turnBusy: true })).toBe(false);
    expect(narrationStillOwnsVoice({ ...speaking, wakeOpening: true })).toBe(false);
    expect(narrationStillOwnsVoice({ ...speaking, listening: true })).toBe(false);
    expect(narrationStillOwnsVoice({ ...speaking, liveAudioPending: true })).toBe(false);
    expect(narrationStillOwnsVoice(speaking, true)).toBe(false);
  });

  it('requeues a narration to the front instead of losing it', async () => {
    let free = true;
    const played: string[] = [];
    const queue = new NarrationQueue({
      canPlay: () => free,
      play: async (text) => {
        played.push(text);
        if (played.length === 1) {
          free = false; // wake abriu durante a síntese
          queue.requeue(text);
        }
      },
    });

    queue.enqueue('primeiro relato');
    queue.enqueue('segundo relato');
    await settle();
    await settle();
    expect(played).toEqual(['primeiro relato']);
    expect(queue.size).toBe(2);

    free = true;
    queue.kick();
    await settle();
    await settle();
    await settle();
    expect(played).toEqual(['primeiro relato', 'primeiro relato', 'segundo relato']);
    expect(queue.size).toBe(0);
  });
});
