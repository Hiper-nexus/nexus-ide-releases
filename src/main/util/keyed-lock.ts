/**
 * Uma operação assíncrona por chave de cada vez, na ordem de chegada (QLT-02,
 * ideia do `KeyedLock` do T3 Code @ 26285ab; código escrito aqui).
 *
 * Substitui o mesmo encadeamento de promessas que estava copiado à mão em
 * cinco lugares (checkpoint oculto, salvaguarda da worktree, ledger e
 * write-back do modo design, refresh incremental da orientação). A falha de
 * uma operação chega só a quem a pediu; a fila da chave segue. A chave sai do
 * mapa quando a fila dela esvazia — a cópia do write-back nunca saía e
 * acumulava uma promessa por sessão de design para sempre.
 */
export class KeyedLock<K = string> {
  readonly #tails = new Map<K, Promise<void>>();

  /** Roda `operation` depois de todas as anteriores da mesma chave. */
  run<T>(key: K, operation: () => Promise<T>): Promise<T> {
    // A cauda nunca rejeita: a operação roda mesmo que a anterior tenha falhado.
    const result = (this.#tails.get(key) ?? Promise.resolve()).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(key, tail);
    void tail.then(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    });
    return result;
  }

  /** Chaves com operação na fila ou rodando. */
  get size(): number {
    return this.#tails.size;
  }

  /** Testes: espera a fila de todas as chaves esvaziar, inclusive o que entrar enquanto espera. */
  async idle(): Promise<void> {
    while (this.#tails.size > 0) await Promise.all([...this.#tails.values()]);
  }
}
