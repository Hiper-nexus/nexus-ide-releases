import { describe, expect, it, vi } from 'vitest';
import { LiveQuestionPoller } from './live-question-poller';

describe('question polling physical stop', () => {
  it('cancels the yielded batch before emitting questions after teardown', async () => {
    const emit = vi.fn();
    const source = { poll: () => Array.from({ length: 5000 }, (_, i) => ({ paneId: `p${i}`, questionHash: `q${i}` })) };
    const poller = new LiveQuestionPoller(source, emit);
    poller.start();
    await poller.stop();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(emit).not.toHaveBeenCalled();
  });
  it('deduplicates a live question and releases the flight on stop', async () => {
    const emit = vi.fn();
    const question = { paneId: 'p', questionHash: 'q' };
    const poller = new LiveQuestionPoller({ poll: () => [question, question] }, emit);
    poller.start();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(emit).toHaveBeenCalledExactlyOnceWith(question);
    await poller.stop();
  });
});
