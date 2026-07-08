import { describe, expect, it, vi } from 'vitest';
import { TURN_MAX_MS, TurnQueue } from './turn-queue';

function harness(canSend = () => true) {
  const sent: string[] = [];
  const queue = new TurnQueue({
    send: (t) => sent.push(t),
    setTimeoutFn: setTimeout,
    clearTimeoutFn: clearTimeout,
    canSend,
  });
  return { queue, sent };
}

describe('TurnQueue', () => {
  it('sends the first turn immediately and marks itself busy', () => {
    const { queue, sent } = harness();
    queue.enqueue('a');
    expect(sent).toEqual(['a']);
    expect(queue.isBusy).toBe(true);
  });

  it('holds concurrent turns until release (one in flight, FIFO)', () => {
    const { queue, sent } = harness();
    queue.enqueue('a');
    queue.enqueue('b');
    queue.enqueue('c');
    expect(sent).toEqual(['a']);
    expect(queue.size).toBe(2);

    queue.release();
    expect(sent).toEqual(['a', 'b']);
    queue.release();
    expect(sent).toEqual(['a', 'b', 'c']);
    queue.release();
    expect(queue.isBusy).toBe(false);
    expect(queue.size).toBe(0);
  });

  it('does not send while the socket cannot accept a turn', () => {
    let open = false;
    const { queue, sent } = harness(() => open);
    queue.enqueue('a');
    expect(sent).toEqual([]);
    expect(queue.size).toBe(1);
    open = true;
    queue.drain();
    expect(sent).toEqual(['a']);
  });

  it('release is a no-op when nothing is in flight', () => {
    const { queue, sent } = harness();
    queue.release();
    expect(sent).toEqual([]);
    expect(queue.isBusy).toBe(false);
  });

  it('TURN_MAX_MS breaker releases a turn that never signals completion', async () => {
    vi.useFakeTimers();
    const { queue, sent } = harness();
    queue.enqueue('a');
    queue.enqueue('b');
    expect(sent).toEqual(['a']);
    // no release() from the server — the breaker must fire.
    await vi.advanceTimersByTimeAsync(TURN_MAX_MS);
    expect(sent).toEqual(['a', 'b']);
    vi.useRealTimers();
  });

  it('reset clears the queue, busy flag, and breaker timer', async () => {
    vi.useFakeTimers();
    const { queue, sent } = harness();
    queue.enqueue('a');
    queue.enqueue('b');
    queue.reset();
    expect(queue.isBusy).toBe(false);
    expect(queue.size).toBe(0);
    // breaker must not fire after reset (no stale release drains 'b').
    await vi.advanceTimersByTimeAsync(TURN_MAX_MS * 2);
    expect(sent).toEqual(['a']);
    vi.useRealTimers();
  });

  it('flush returns queued turns and empties the queue', () => {
    const { queue } = harness(() => false);
    queue.enqueue('a');
    queue.enqueue('b');
    expect(queue.flush()).toEqual(['a', 'b']);
    expect(queue.size).toBe(0);
  });

  it('prepend keeps FIFO order for re-queued turns', () => {
    const { queue, sent } = harness();
    queue.enqueue('live');
    queue.enqueue('c');
    queue.prepend(['a', 'b']);
    queue.release();
    queue.release();
    queue.release();
    expect(sent).toEqual(['live', 'a', 'b', 'c']);
  });

  it('enqueuePriority clears busy and sends wake immediately', () => {
    const { queue, sent } = harness();
    queue.enqueue('stale-narration');
    expect(queue.isBusy).toBe(true);
    queue.enqueuePriority('[wake] diga Olá.');
    expect(sent).toEqual(['stale-narration', '[wake] diga Olá.']);
    expect(queue.size).toBe(0);
    expect(queue.isBusy).toBe(true);
  });

  it('enqueuePriority drops queued turns behind a busy one', () => {
    const { queue, sent } = harness();
    queue.enqueue('a');
    queue.enqueue('b');
    queue.enqueue('c');
    queue.enqueuePriority('[wake] agora');
    expect(sent).toEqual(['a', '[wake] agora']);
    expect(queue.size).toBe(0);
  });
});
