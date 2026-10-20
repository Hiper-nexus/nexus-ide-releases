/**
 * A1 — orquestrador do pool de worktrees pré-alocadas.
 *
 * Junta o `WorktreePool` (coordenação em memória) ao registro durável e ao
 * Git. `tryAdopt` adota do pool ou devolve `null` (o chamador cai no caminho
 * atual de alocação); `scheduleReplenish` repõe a reserva EM SEGUNDO PLANO,
 * depois do turno atual, sem disputar o `withWorktreeAddLock` com spawns
 * ativos. Fail-closed em toda prova: na dúvida, caminho atual.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  POOL_BRANCH_REF_PREFIX,
  type WorktreeRecord,
} from '../runtime/worktree-contract';
import { WorktreePool, type PooledWorktreeEntry } from '../runtime/worktree-pool';
import { materializeGitWorktree } from '../runtime/worktree-cow';
import {
  readRepositorySnapshotAsync,
  readLinkedBaseSnapshotAsync,
  resolveBaseRefAsync,
} from '../runtime/worktree-manager-git';
import { AsyncProcessGitRunner, type AsyncGitRunner } from '../runtime/git-command';
import {
  requireWorktreeRuntimeRegistry,
  worktreeRuntimeRegistryGeneration,
} from '../runtime/worktree-runtime-registry';
import { KeyedCoalescingWorker } from '../util/keyed-coalescing-worker';
import { getOrchSettings } from '../persistence/settings-store';
import { currentStorageHygienePolicy } from '../storage-hygiene/hygiene-policy';

export const WORKTREE_POOL_MAX_PER_SCOPE = 2;

/** F-980/A1: base de onde o writer nasce (HEAD do checkout ou HEAD da aba). */
export interface IsolatedWriterPoolRequest {
  readonly baseRootRealPath?: string;
  readonly baseRef?: string;
}

export interface PoolBaseResolution {
  /** Commit de onde a worktree do pool nasce (HEAD da base, ou baseRef resolvido). */
  readonly headSha: string;
  /** Checkout de coordenação: fonte do `git worktree add` e do clone CoW. */
  readonly repositoryRoot: string;
}

/**
 * Operações físicas que o orquestrador delega. A implementação real usa o
 * registry durável + Git; os testes injetam um backend fake (sem Git real).
 */
export interface IsolatedWriterPoolBackend {
  scopeKey(scope: ProjectExecutionScope): string;
  worktreesRoot(scope: ProjectExecutionScope): string;
  resolveBase(
    scope: ProjectExecutionScope,
    request: IsolatedWriterPoolRequest,
  ): Promise<PoolBaseResolution>;
  /** Materializa uma worktree do pool no `headSha` (branch + clone CoW). */
  materialize(
    scope: ProjectExecutionScope,
    base: PoolBaseResolution,
  ): Promise<PooledWorktreeEntry>;
  /** Prova + CAS: adota a worktree do pool como writer de pane. */
  claim(
    scope: ProjectExecutionScope,
    missionId: string,
    entry: PooledWorktreeEntry,
  ): Promise<WorktreeRecord>;
  /** Remove fisicamente uma worktree do pool nunca adotada. */
  remove(scope: ProjectExecutionScope, entry: PooledWorktreeEntry): Promise<void>;
  /** Worktrees do pool órfãs no disco (branch `nexus-pool/…`), para a limpeza de boot. */
  listPooledWorktrees(
    scope: ProjectExecutionScope,
  ): Promise<ReadonlyArray<{ readonly worktreePath: string; readonly branchRef: string }>>;
}

/** Desligável por configuração (orch) E por env var em tempo de execução. */
export function worktreePoolEnabled(): boolean {
  if (process.env.VITEST) return false;
  if (process.env.NEXUS_WORKTREE_POOL === '0') return false;
  try {
    return getOrchSettings().worktreePoolEnabled !== false;
  } catch {
    return true;
  }
}

export class IsolatedWriterPoolOrchestrator {
  readonly #backend: IsolatedWriterPoolBackend;
  readonly #pool: WorktreePool;
  readonly #enabled: () => boolean;
  /** scopeKey → escopo (para a limpeza de shutdown remover no checkout certo). */
  readonly #scopes = new Map<string, ProjectExecutionScope>();
  /** Escopos cuja limpeza de boot já rodou (uma vez por processo). */
  readonly #bootCleaned = new Set<string>();
  readonly #bootCleanups = new Map<string, Promise<void>>();
  readonly #replenish: KeyedCoalescingWorker<
    string,
    { readonly scope: ProjectExecutionScope; readonly request: IsolatedWriterPoolRequest }
  >;

  constructor(
    backend: IsolatedWriterPoolBackend,
    options: { readonly enabled?: () => boolean } = {},
  ) {
    this.#backend = backend;
    this.#pool = new WorktreePool({ maxPerScope: WORKTREE_POOL_MAX_PER_SCOPE });
    this.#enabled = options.enabled ?? worktreePoolEnabled;
    this.#replenish = new KeyedCoalescingWorker(
      async (_scopeKey, { scope, request }) => {
        // Fora do caminho crítico: mais uma janela para os spawns ativos.
        await new Promise((resolve) => setImmediate(resolve));
        await this.preallocate(scope, request);
      },
      (error) => console.warn('[isolated-writer-pool] reposição adiada', error),
    );
  }

  get size(): number {
    return this.#pool.size;
  }

  /** Testes: espera a reposição em segundo plano e as limpezas de boot pararem. */
  async idle(): Promise<void> {
    await Promise.all([
      ...this.#bootCleanups.values(),
      this.#replenish.drain(),
    ]);
  }

  /**
   * Adota do pool ou devolve `null` (o chamador cai no caminho atual).
   * `reserve` é SÍNCRONO e roda antes de qualquer `await` de claim: dois
   * writers concorrentes nunca recebem a mesma worktree.
   */
  async tryAdopt(
    scope: ProjectExecutionScope,
    missionId: string,
    request: IsolatedWriterPoolRequest,
  ): Promise<{ readonly record: WorktreeRecord } | null> {
    if (!this.#enabled()) return null;
    const scopeKey = this.#backend.scopeKey(scope);
    this.#scopes.set(scopeKey, scope);
    void this.#ensureBootCleanup(scope, scopeKey);
    // Pool sem entrada desta base: nada a adotar nem a marcar como stale.
    // `resolveBase` roda Git (vários comandos) e não pode custar isso num
    // spawn que já sabe que vai cair no caminho atual.
    const hasMatchable = this.#pool.entriesFor(scopeKey).some(
      (entry) =>
        entry.baseRootRealPath === request.baseRootRealPath &&
        entry.baseRef === request.baseRef,
    );
    if (!hasMatchable) return null;
    const base = await this.#backend.resolveBase(scope, request);
    const reservation = this.#pool.reserve(scopeKey, request, base.headSha);
    for (const stale of reservation.stale) {
      void this.#backend.remove(scope, stale).catch(() => {});
    }
    const entry = reservation.entry;
    if (!entry) return null;
    try {
      const record = await this.#backend.claim(scope, missionId, entry);
      return { record };
    } catch (error) {
      // Prova falhou (identidade/HEAD divergiu): descarta e cai no caminho atual.
      console.warn('[isolated-writer-pool] adoção recusada, descartando worktree do pool', error);
      void this.#backend.remove(scope, entry).catch(() => {});
      return null;
    }
  }

  /** Reposição em segundo plano, uma rodada por escopo, depois do turno atual. */
  scheduleReplenish(
    scope: ProjectExecutionScope,
    request: IsolatedWriterPoolRequest,
  ): void {
    if (!this.#enabled()) return;
    const scopeKey = this.#backend.scopeKey(scope);
    this.#scopes.set(scopeKey, scope);
    this.#replenish.enqueue(scopeKey, { scope, request });
  }

  /** Remove fisicamente todas as worktrees do pool em memória (shutdown). */
  async shutdown(): Promise<void> {
    for (const scopeKey of this.#pool.scopeKeys) {
      const scope = this.#scopes.get(scopeKey);
      for (const entry of this.#pool.clearScope(scopeKey)) {
        if (!scope) continue;
        await this.#removeBestEffort(scope, entry);
      }
    }
  }

  /**
   * Pré-aloca UMA worktree do pool no HEAD atual da base pedida, respeitando o
   * teto. Público para o aquecimento de boot e para os testes.
   */
  async preallocate(
    scope: ProjectExecutionScope,
    request: IsolatedWriterPoolRequest,
  ): Promise<void> {
    if (!this.#enabled()) return;
    // Disco crítico: ~1,6 GB de reserva por worktree não compensam o spawn
    // mais rápido. O writer materializa a worktree na hora, como sem pool.
    if (currentStorageHygienePolicy().pressure === 'critical') return;
    const scopeKey = this.#backend.scopeKey(scope);
    this.#scopes.set(scopeKey, scope);
    if (this.#pool.entriesFor(scopeKey).length >= WORKTREE_POOL_MAX_PER_SCOPE) return;
    try {
      const base = await this.#backend.resolveBase(scope, request);
      const entry = await this.#backend.materialize(scope, base);
      this.#pool.stage(entry);
    } catch (error) {
      // Reposição é melhor esforço; o spawn nunca depende dela.
      console.warn('[isolated-writer-pool] pré-alocação falhou', error);
    }
  }

  async #removeBestEffort(
    scope: ProjectExecutionScope,
    entry: PooledWorktreeEntry,
  ): Promise<void> {
    try {
      await this.#backend.remove(scope, entry);
    } catch {
      // Best-effort: a limpeza de boot tenta de novo.
    }
  }

  /**
   * Limpeza de boot: remove worktrees do pool órfãs no disco (de um processo
   * anterior que saiu sem limpar). Uma vez por escopo, fora do caminho crítico
   * (fire-and-forget); nunca remove uma entrada do pool atual.
   */
  #ensureBootCleanup(scope: ProjectExecutionScope, scopeKey: string): Promise<void> {
    if (this.#bootCleaned.has(scopeKey)) return Promise.resolve();
    this.#bootCleaned.add(scopeKey);
    const running = (async () => {
      await new Promise((resolve) => setImmediate(resolve));
      try {
        const inMemory = new Set(
          this.#pool.entriesFor(scopeKey).map((entry) => entry.worktreePath),
        );
        for (const orphan of await this.#backend.listPooledWorktrees(scope)) {
          if (inMemory.has(orphan.worktreePath)) continue;
          try {
            await this.#backend.remove(scope, {
              scopeKey,
              worktreePath: orphan.worktreePath,
              branchRef: orphan.branchRef,
              baseSha: '',
              createdAt: 0,
            });
          } catch {
            // Best-effort.
          }
        }
      } catch (error) {
        console.warn('[isolated-writer-pool] limpeza de boot adiada', error);
      }
    })();
    this.#bootCleanups.set(scopeKey, running);
    return running;
  }
}

// ---------------------------------------------------------------------------
// Backend real + singleton.
// ---------------------------------------------------------------------------

let sharedGit: AsyncGitRunner | undefined;

function git(): AsyncGitRunner {
  return (sharedGit ??= new AsyncProcessGitRunner());
}

function poolBranchRef(): string {
  return `${POOL_BRANCH_REF_PREFIX}${randomUUID().replace(/-/g, '')}`;
}

export function createRealIsolatedWriterPoolBackend(): IsolatedWriterPoolBackend {
  return {
    scopeKey: (scope) => requireWorktreeRuntimeRegistry().worktreeScopeKeyFor(scope),
    worktreesRoot: (scope) => requireWorktreeRuntimeRegistry().worktreesRootFor(scope),
    async resolveBase(scope, request) {
      const repository = await readRepositorySnapshotAsync(git(), scope, false);
      const baseRoot = request.baseRootRealPath === undefined
        ? repository
        : await readLinkedBaseSnapshotAsync(git(), repository, request.baseRootRealPath);
      const headSha = request.baseRef === undefined
        ? baseRoot.headSha
        : await resolveBaseRefAsync(git(), baseRoot.rootRealPath, request.baseRef, 'pane');
      return { headSha, repositoryRoot: repository.rootRealPath };
    },
    async materialize(scope, base) {
      const worktreesRoot = requireWorktreeRuntimeRegistry().worktreesRootFor(scope);
      const branchRef = poolBranchRef();
      const worktreePath = path.join(worktreesRoot, 'pool', randomUUID().replace(/-/g, ''));
      const entry: PooledWorktreeEntry = {
        scopeKey: requireWorktreeRuntimeRegistry().worktreeScopeKeyFor(scope),
        worktreePath,
        branchRef,
        baseSha: base.headSha,
        createdAt: Date.now(),
      };
      await materializeGitWorktree({
        repositoryRoot: base.repositoryRoot,
        worktreePath,
        branchRef,
        headSha: base.headSha,
        git: git(),
      });
      return entry;
    },
    async claim(scope, missionId, entry) {
      return requireWorktreeRuntimeRegistry().claimPooledPaneWriter(scope, missionId, {
        workerId: randomUUID(),
        worktreePath: entry.worktreePath,
        branchRef: entry.branchRef,
        baseSha: entry.baseSha,
      });
    },
    async remove(scope, entry) {
      await requireWorktreeRuntimeRegistry().removePooledWorktree(scope, {
        worktreePath: entry.worktreePath,
        branchRef: entry.branchRef,
      });
    },
    async listPooledWorktrees(scope) {
      const result = await git().run(scope.rootRealPath, ['worktree', 'list', '--porcelain']);
      const found: Array<{ readonly worktreePath: string; readonly branchRef: string }> = [];
      for (const block of result.stdout.split('\n\n')) {
        const lines = block.split('\n');
        const worktreePath = lines
          .find((line) => line.startsWith('worktree '))?.slice('worktree '.length) ?? '';
        const branchRef = lines
          .find((line) => line.startsWith('branch '))?.slice('branch '.length) ?? '';
        if (worktreePath && branchRef.startsWith(POOL_BRANCH_REF_PREFIX)) {
          found.push({ worktreePath, branchRef });
        }
      }
      return found;
    },
  };
}

let orchestrator: IsolatedWriterPoolOrchestrator | undefined;
let orchestratorGeneration = -1;

export function requireIsolatedWriterPool(): IsolatedWriterPoolOrchestrator {
  const generation = worktreeRuntimeRegistryGeneration();
  if (!orchestrator || orchestratorGeneration !== generation) {
    orchestrator = new IsolatedWriterPoolOrchestrator(createRealIsolatedWriterPoolBackend());
    orchestratorGeneration = generation;
  }
  return orchestrator;
}

/** Testes: recria o orquestrador com um backend injetado. */
export function resetIsolatedWriterPoolForTests(backend?: IsolatedWriterPoolBackend): void {
  orchestrator = backend
    ? new IsolatedWriterPoolOrchestrator(backend, { enabled: () => true })
    : undefined;
}

export function shutdownIsolatedWriterPool(): Promise<void> {
  return orchestrator ? orchestrator.shutdown() : Promise.resolve();
}
