/**
 * Deduplicação de entrada remota por messageId.
 *
 * O outbox durável do mobile reenvia uma mensagem quando o ack se perde (relay
 * caiu, app reiniciou no meio do envio). Sem isso o desktop digitaria o mesmo
 * prompt duas vezes no PTY. Guardamos, por chave (projeto + sessão + messageId),
 * a promessa da primeira entrega: um reenvio — concorrente ou posterior —
 * recebe o mesmo resultado sem escrever de novo.
 *
 * Só entregas confirmadas ficam guardadas: falha (exceção, confirmação negada)
 * ou escrita recusada liberam a chave para o reenvio tentar de verdade.
 */

const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_ENTRIES = 1024;
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

type Entry<T> = { promise: Promise<T>; settledAt: number | null };

export type RemoteInputDedup<T> = {
  run: (
    key: string,
    deliver: () => Promise<T>,
  ) => Promise<{ result: T; deduplicated: boolean }>;
  size: () => number;
};

/** messageId aceito só se for um id opaco curto; qualquer outra coisa é ignorada. */
export function remoteInputMessageId(value: unknown): string | null {
  return typeof value === 'string' && MESSAGE_ID_PATTERN.test(value) ? value : null;
}

export function createRemoteInputDedup<T>(options: {
  /** Uma entrega conta como "já feita" se `isDelivered(result)`. */
  isDelivered: (result: T) => boolean;
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}): RemoteInputDedup<T> {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry<T>>();

  const prune = (): void => {
    const cutoff = now() - ttlMs;
    for (const [key, entry] of entries) {
      if (entry.settledAt !== null && entry.settledAt < cutoff) entries.delete(key);
    }
    // Map preserva a ordem de inserção: o mais antigo sai primeiro.
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  };

  return {
    run: async (key, deliver) => {
      prune();
      const existing = entries.get(key);
      if (existing) {
        const result = await existing.promise;
        return { result, deduplicated: options.isDelivered(result) };
      }
      let settle!: { resolve: (result: T) => void; reject: (error: unknown) => void };
      const entry: Entry<T> = {
        promise: new Promise<T>((resolve, reject) => {
          settle = { resolve, reject };
        }),
        settledAt: null,
      };
      // Quem espera a primeira entrega trata a falha; esta cópia não pode
      // virar unhandledRejection quando ninguém mais está esperando.
      entry.promise.catch(() => undefined);
      // Registrada ANTES de entregar: um reenvio concorrente espera esta entrega.
      entries.set(key, entry);
      prune();
      try {
        const result = await deliver();
        if (options.isDelivered(result)) {
          entry.settledAt = now();
        } else if (entries.get(key) === entry) {
          entries.delete(key);
        }
        settle.resolve(result);
        return { result, deduplicated: false };
      } catch (error) {
        if (entries.get(key) === entry) entries.delete(key);
        settle.reject(error);
        throw error;
      }
    },
    size: () => entries.size,
  };
}
