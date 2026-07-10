import { describe, expect, it, vi } from 'vitest';
import { NarrationQueue } from './narration-queue';

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
