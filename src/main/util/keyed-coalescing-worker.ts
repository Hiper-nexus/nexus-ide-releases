/**
 * Trabalho por chave que se junta enquanto roda (QLT-03, ideia do
 * `KeyedCoalescingWorker` do T3 Code @ 26285ab; código escrito aqui).
 *
 * `enqueue(chave, valor)` sem rodada em curso na chave agenda uma (depois do
 * turno atual, nunca na pilha de quem pediu). Com rodada em curso, guarda o
 * valor mais novo e garante UMA rodada extra ao fim dela: dez pedidos durante
 * uma rodada viram uma, com o último valor. Serve a trabalho que relê o estado
 * atual (GC de worktrees, repintura de badges), em que a fila inteira é
 * desperdício. Falha de uma rodada vai para `onError` e a próxima segue.
 * `drain()` espera tudo, inclusive as rodadas extras (testes).
 */
export class KeyedCoalescingWorker<K, V> {
  readonly #work: (key: K, value: V) => Promise<void>;
  readonly #onError: (error: unknown, key: K) => void;
  readonly #active = new Map<K, { value: V; again: boolean; done: Promise<void> }>();

  constructor(
    work: (key: K, value: V) => Promise<void>,
    onError: (error: unknown, key: K) => void,
  ) {
    this.#work = work;
    this.#onError = onError;
  }

  enqueue(key: K, value: V): void {
    const active = this.#active.get(key);
    if (active) {
      active.value = value;
      active.again = true;
      return;
    }
    const entry = { value, again: true, done: Promise.resolve() };
    this.#active.set(key, entry);
    entry.done = Promise.resolve().then(async () => {
      while (entry.again) {
        entry.again = false;
        try {
          await this.#work(key, entry.value);
        } catch (error) {
          this.#onError(error, key);
        }
      }
      this.#active.delete(key);
    });
  }

  /** Testes: espera todas as chaves pararem, inclusive o que entrar enquanto espera. */
  async drain(): Promise<void> {
    while (this.#active.size > 0) {
      await Promise.all([...this.#active.values()].map((entry) => entry.done));
    }
  }
}
