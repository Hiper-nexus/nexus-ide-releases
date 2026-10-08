import { describe, expect, it } from 'vitest';
import { KeyedLock } from './keyed-lock';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('KeyedLock (QLT-02)', () => {
  it('mesma chave roda em série, na ordem de chegada; chaves diferentes não se esperam', async () => {
    const lock = new KeyedLock();
    const log: string[] = [];
    const gate = deferred();
    const first = lock.run('a', async () => { log.push('a1:start'); await gate.promise; log.push('a1:end'); });
    const second = lock.run('a', async () => { log.push('a2'); });
    const other = lock.run('b', async () => { log.push('b1'); });
    await other;
    expect(log).toEqual(['a1:start', 'b1']);
    gate.resolve();
    await Promise.all([first, second]);
    expect(log).toEqual(['a1:start', 'b1', 'a1:end', 'a2']);
  });

  it('a falha chega só a quem pediu e a fila da chave segue', async () => {
    const lock = new KeyedLock();
    const failed = lock.run('a', async () => { throw new Error('quebrou'); });
    const next = lock.run('a', async () => 'depois');
    await expect(failed).rejects.toThrow('quebrou');
    await expect(next).resolves.toBe('depois');
  });

  it('a chave sai do mapa quando a fila esvazia (sem acumular uma promessa por chave)', async () => {
    const lock = new KeyedLock();
    for (let index = 0; index < 50; index += 1) {
      await lock.run(`sessao-${index}`, async () => index);
    }
    // Sem `idle()`: com a chave presa ele nunca voltaria.
    await new Promise((resolve) => setImmediate(resolve));
    expect(lock.size).toBe(0);
  });

  it('idle espera também o que entra na fila enquanto espera', async () => {
    const lock = new KeyedLock();
    const done: string[] = [];
    void lock.run('a', async () => {
      done.push('primeira');
      void lock.run('b', async () => { done.push('encadeada'); });
    });
    await lock.idle();
    expect(done).toEqual(['primeira', 'encadeada']);
    expect(lock.size).toBe(0);
  });
});
