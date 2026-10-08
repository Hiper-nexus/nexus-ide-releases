import { describe, expect, it, vi } from 'vitest';
import { createRemoteInputDedup, remoteInputMessageId } from './remote-input-dedup';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('createRemoteInputDedup', () => {
  it('entrega uma vez e responde o reenvio do mesmo messageId sem escrever de novo', async () => {
    const dedup = createRemoteInputDedup<boolean>({ isDelivered: (ok) => ok });
    const write = vi.fn(async () => true);

    await expect(dedup.run('p\0s\0m-1', write)).resolves.toEqual({
      result: true,
      deduplicated: false,
    });
    await expect(dedup.run('p\0s\0m-1', write)).resolves.toEqual({
      result: true,
      deduplicated: true,
    });
    expect(write).toHaveBeenCalledTimes(1);

    await dedup.run('p\0s\0m-2', write);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('um reenvio concorrente espera a primeira entrega em vez de escrever junto', async () => {
    const dedup = createRemoteInputDedup<boolean>({ isDelivered: (ok) => ok });
    const gate = deferred<boolean>();
    const write = vi.fn(() => gate.promise);

    const first = dedup.run('k', write);
    const replay = dedup.run('k', write);
    gate.resolve(true);

    await expect(first).resolves.toEqual({ result: true, deduplicated: false });
    await expect(replay).resolves.toEqual({ result: true, deduplicated: true });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('não guarda falha nem escrita recusada: o reenvio tenta de verdade', async () => {
    const dedup = createRemoteInputDedup<boolean>({ isDelivered: (ok) => ok });
    const denied = vi.fn(async () => {
      throw new Error('not authorized: desktop confirmation required or denied');
    });
    await expect(dedup.run('k', denied)).rejects.toThrow('not authorized');

    const refused = vi.fn(async () => false);
    await expect(dedup.run('k', refused)).resolves.toEqual({
      result: false,
      deduplicated: false,
    });

    const write = vi.fn(async () => true);
    await expect(dedup.run('k', write)).resolves.toEqual({
      result: true,
      deduplicated: false,
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(dedup.size()).toBe(1);
  });

  it('esquece entregas depois do TTL e respeita o teto de entradas', async () => {
    let now = 1_000;
    const dedup = createRemoteInputDedup<boolean>({
      isDelivered: (ok) => ok,
      ttlMs: 100,
      maxEntries: 2,
      now: () => now,
    });
    const write = vi.fn(async () => true);

    await dedup.run('a', write);
    now += 101;
    await expect(dedup.run('a', write)).resolves.toMatchObject({ deduplicated: false });

    await dedup.run('b', write);
    await dedup.run('c', write);
    expect(dedup.size()).toBe(2);
    // 'a' (o mais antigo) saiu pelo teto; 'c' ainda deduplica.
    await expect(dedup.run('c', write)).resolves.toMatchObject({ deduplicated: true });
  });
});

describe('remoteInputMessageId', () => {
  it('aceita só ids opacos curtos', () => {
    expect(remoteInputMessageId('8f14e45f-ceea-4e7b-a3c1-111111111111')).toBe(
      '8f14e45f-ceea-4e7b-a3c1-111111111111',
    );
    expect(remoteInputMessageId('')).toBeNull();
    expect(remoteInputMessageId('a'.repeat(129))).toBeNull();
    expect(remoteInputMessageId('has space')).toBeNull();
    expect(remoteInputMessageId(42)).toBeNull();
  });
});
