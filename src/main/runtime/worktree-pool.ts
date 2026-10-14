/**
 * A1 — pool em memória de worktrees PRÉ-ALOCADAS por checkout.
 *
 * O maior custo do spawn de writer isolado é materializar a worktree na hora:
 * `git worktree add` (serializado pelo `withWorktreeAddLock`) + clone CoW de
 * node_modules. Aqui 1–2 worktrees já prontas (branch no HEAD + node_modules
 * clonado) ficam de reserva, sem registro durável e sem taskId de pane até a
 * adoção; o spawn só adota e prova, fora do caminho crítico.
 *
 * Esta classe é SÓ coordenação em memória — nenhum Git, nenhum fs, nenhuma
 * dependência do registry. As operações físicas (materializar, provar, remover)
 * são injetadas pelo orquestrador (`isolated-writer-pool.ts`). `reserve` é
 * síncrono e atômico dentro do turno JS: dois writers concorrentes nunca
 * recebem a mesma entrada (o primeiro `reserve` esvazia antes de qualquer
 * `await`).
 */

export interface PooledWorktreeEntry {
  /** Chave do escopo (WorktreeManager.scopeKey). */
  readonly scopeKey: string;
  readonly worktreePath: string;
  readonly branchRef: string;
  /** Commit de onde a worktree nasceu (HEAD da base na pré-alocação). */
  readonly baseSha: string;
  /**
   * F-980: base de onde a worktree nasceu. `undefined` = checkout de
   * coordenação; caso contrário, a pasta isolada da aba.
   */
  readonly baseRootRealPath?: string;
  /** F-1320: ref pedida pelo writer; `undefined` = HEAD da base. */
  readonly baseRef?: string;
  readonly createdAt: number;
}

export interface PooledWorktreeRequest {
  readonly baseRootRealPath?: string;
  readonly baseRef?: string;
}

export interface PooledWorktreeReservation {
  /** Entrada pronta para adoção (já removida do pool). */
  readonly entry?: PooledWorktreeEntry;
  /**
   * Entradas da MESMA base (baseRootRealPath/baseRef) cujo `baseSha` ficou
   * obsoleto (o HEAD da base mudou). Removidas do pool para descarte físico.
   */
  readonly stale: readonly PooledWorktreeEntry[];
}

export interface WorktreePoolOptions {
  /** Teto de worktrees pré-alocadas por escopo. */
  readonly maxPerScope?: number;
  readonly now?: () => number;
}

export class WorktreePool {
  readonly #entries = new Map<string, PooledWorktreeEntry[]>();
  readonly #maxPerScope: number;
  readonly #now: () => number;

  constructor(options: WorktreePoolOptions = {}) {
    const maxPerScope = options.maxPerScope ?? 2;
    if (!Number.isInteger(maxPerScope) || maxPerScope < 0) {
      throw new Error("worktree pool maxPerScope must be a non-negative integer");
    }
    this.#maxPerScope = maxPerScope;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Reserva, atomicamente, uma entrada cujo `baseSha` ainda é o HEAD esperado
   * da base pedida. Entradas da mesma base com `baseSha` diferente (o HEAD
   * mudou desde a pré-alocação) saem como `stale` para descarte físico.
   */
  reserve(
    scopeKey: string,
    request: PooledWorktreeRequest,
    expectedBaseSha: string,
  ): PooledWorktreeReservation {
    const entries = this.#entries.get(scopeKey);
    if (!entries || entries.length === 0) {
      return { stale: [] };
    }
    const sameBase = (entry: PooledWorktreeEntry) =>
      entry.baseRootRealPath === request.baseRootRealPath &&
      entry.baseRef === request.baseRef;
    const remaining: PooledWorktreeEntry[] = [];
    const stale: PooledWorktreeEntry[] = [];
    let match: PooledWorktreeEntry | undefined;
    for (const entry of entries) {
      if (!sameBase(entry)) {
        remaining.push(entry);
        continue;
      }
      if (entry.baseSha !== expectedBaseSha) {
        // O HEAD da base mudou desde a pré-alocação: obsoleta.
        stale.push(entry);
        continue;
      }
      if (match === undefined) {
        match = entry;
      } else {
        // Outra entrada válida da MESMA base: fica para o próximo writer.
        remaining.push(entry);
      }
    }
    if (remaining.length === entries.length) {
      // Nada desta base no pool: nada a mudar.
      return { stale: [] };
    }
    this.#entries.set(scopeKey, remaining.length > 0 ? remaining : []);
    if (remaining.length === 0) this.#entries.delete(scopeKey);
    return Object.freeze({ entry: match, stale: Object.freeze(stale) });
  }

  /** Adiciona uma worktree recém pré-alocada, respeitando o teto por escopo. */
  stage(entry: PooledWorktreeEntry): void {
    if (this.#maxPerScope === 0) return;
    const entries = this.#entries.get(entry.scopeKey) ?? [];
    if (entries.length >= this.#maxPerScope) return;
    this.#entries.set(entry.scopeKey, [...entries, entry]);
  }

  /** Remove uma entrada específica; `true` quando ela estava no pool. */
  discard(scopeKey: string, entry: PooledWorktreeEntry): boolean {
    const entries = this.#entries.get(scopeKey);
    if (!entries) return false;
    const remaining = entries.filter((candidate) => candidate !== entry);
    if (remaining.length === entries.length) return false;
    if (remaining.length === 0) this.#entries.delete(scopeKey);
    else this.#entries.set(scopeKey, remaining);
    return true;
  }

  /** Entradas de um escopo (leitura; usada pela limpeza de shutdown). */
  entriesFor(scopeKey: string): readonly PooledWorktreeEntry[] {
    return Object.freeze([...(this.#entries.get(scopeKey) ?? [])]);
  }

  /** Esvazia o escopo e devolve o que havia, para remoção física. */
  clearScope(scopeKey: string): readonly PooledWorktreeEntry[] {
    const entries = this.#entries.get(scopeKey) ?? [];
    this.#entries.delete(scopeKey);
    return Object.freeze([...entries]);
  }

  get size(): number {
    let total = 0;
    for (const entries of this.#entries.values()) total += entries.length;
    return total;
  }

  /** Só testes: escopos atualmente com entradas. */
  get scopeKeys(): readonly string[] {
    return [...this.#entries.keys()];
  }

  now(): number {
    return this.#now();
  }
}
