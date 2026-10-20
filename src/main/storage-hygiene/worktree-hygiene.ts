import type { ProjectExecutionScope } from '../../shared/types';
import type { StorageHygienePolicy } from './hygiene-policy';
import type { WorktreeHygieneOutcome } from './storage-hygiene-service';

/** O recorte do WorktreeRuntimeRegistry que a higiene usa (injetado no boot). */
export interface WorktreeHygieneRegistry {
  openScopes(): readonly ProjectExecutionScope[];
  trimAgedPaneWriterCaches(
    scope: ProjectExecutionScope,
    options: { readonly minIdleMs: number; readonly deadlineAt?: number },
  ): Promise<{ readonly trimmed: number }>;
  collectAgedPaneWriterWorktrees(
    scope: ProjectExecutionScope,
    limits: { readonly minIdleMs?: number; readonly retireAfterMs?: number; readonly budgetMs?: number },
  ): Promise<{
    readonly removed: readonly unknown[];
    readonly kept: Readonly<Record<string, number>>;
    readonly retired?: number;
  }>;
  drainRetiredWorktrees(): ReadonlyArray<{ readonly branch: string; readonly ref: string; readonly commit: string }>;
}

/**
 * Worktrees de writers de cada escopo aberto: primeiro a poda leve (caches),
 * depois a coleta (limpa sai; suja se aposenta com salvaguarda). Um escopo que
 * falha não impede os outros; o prazo da rodada vale para todos.
 */
export async function runWorktreeHygiene(
  registry: WorktreeHygieneRegistry,
  policy: StorageHygienePolicy,
  deadlineAt: number,
): Promise<WorktreeHygieneOutcome> {
  let trimmed = 0;
  let removed = 0;
  let retired = 0;
  let kept = 0;
  const scopes = registry.openScopes();
  for (const scope of scopes) {
    if (Date.now() >= deadlineAt) break;
    try {
      trimmed += (await registry.trimAgedPaneWriterCaches(scope, {
        minIdleMs: policy.paneWorktreeTrimAfterMs,
        deadlineAt,
      })).trimmed;
    } catch (error) {
      console.warn('[storage-hygiene] poda de caches de worktree adiada:', error);
    }
    const budgetMs = deadlineAt - Date.now();
    if (budgetMs <= 0) break;
    try {
      const report = await registry.collectAgedPaneWriterWorktrees(scope, {
        minIdleMs: policy.paneWorktreeMinIdleMs,
        retireAfterMs: policy.paneWorktreeRetireAfterMs,
        budgetMs,
      });
      removed += report.removed.length;
      retired += report.retired ?? 0;
      kept += Object.values(report.kept).reduce((sum, count) => sum + count, 0);
    } catch (error) {
      console.warn('[storage-hygiene] coleta de worktrees adiada:', error);
    }
  }
  return { trimmed, removed, retired, kept, scopes: scopes.length, retiredWorktrees: registry.drainRetiredWorktrees() };
}
