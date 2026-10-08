import { describe, expect, it } from 'vitest';
import { KeyedCoalescingWorker } from './keyed-coalescing-worker';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('KeyedCoalescingWorker (QLT-03)', () => {
  it('pedidos durante uma rodada viram UMA rodada extra, com o valor mais novo', async () => {
    const gate = deferred();
    const rounds: number[] = [];
    const worker = new KeyedCoalescingWorker<string, number>(async (_key, value) => {
      rounds.push(value);
      if (rounds.length === 1) await gate.promise;
    }, () => {});
    worker.enqueue('pane', 1);
    await new Promise((resolve) => setImmediate(resolve));
    for (let value = 2; value <= 10; value += 1) worker.enqueue('pane', value);
    gate.resolve();
    await worker.drain();
    expect(rounds).toEqual([1, 10]);
  });

  it('não roda na pilha de quem pediu', async () => {
    const rounds: string[] = [];
    const worker = new KeyedCoalescingWorker<string, string>(async (_key, value) => { rounds.push(value); }, () => {});
    worker.enqueue('a', 'x');
    expect(rounds).toEqual([]);
    await worker.drain();
    expect(rounds).toEqual(['x']);
  });

  it('chaves diferentes não se juntam nem se esperam', async () => {
    const gate = deferred();
    const seen: string[] = [];
    const worker = new KeyedCoalescingWorker<string, string>(async (key, value) => {
      seen.push(`${key}:${value}`);
      if (key === 'a') await gate.promise;
    }, () => {});
    worker.enqueue('a', '1');
    worker.enqueue('b', '1');
    await new Promise((resolve) => setImmediate(resolve));
    expect(seen).toEqual(['a:1', 'b:1']);
    gate.resolve();
    await worker.drain();
  });

  it('falha vai para onError e o pedido seguinte roda', async () => {
    const errors: unknown[] = [];
    const rounds: number[] = [];
    const worker = new KeyedCoalescingWorker<string, number>(async (_key, value) => {
      rounds.push(value);
      if (value === 1) throw new Error('quebrou');
    }, (error) => errors.push(error));
    worker.enqueue('a', 1);
    await worker.drain();
    worker.enqueue('a', 2);
    await worker.drain();
    expect(rounds).toEqual([1, 2]);
    expect(errors).toHaveLength(1);
  });
});
