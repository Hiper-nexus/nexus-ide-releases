import type { MissionWorktree } from '../../../shared/mission-engine-contract';

/**
 * Linhas do rail para a lista de missões de um projeto: a BRANCH vira o nó da
 * árvore (herdr/Sidecar), a missão fica embaixo dela. Missão sem worktree roda
 * no checkout — lista direto sob o projeto, sem cabeçalho inventado.
 *
 * Só a branch do worktree ATIVO conta como nó (reserved/ready/queued); com
 * vários, vale o primeiro. Ordem = primeira aparição, para a lista não
 * reordenar a cada refresh.
 */
export type MissionBranchRow<TMission> =
  | { readonly kind: 'branch'; readonly branch: string; readonly status: MissionWorktree['status'] }
  | { readonly kind: 'mission'; readonly mission: TMission };

const ACTIVE_STATUSES: ReadonlySet<MissionWorktree['status']> = new Set([
  'reserved',
  'ready',
  'queued',
]);

export function primaryMissionWorktree(
  worktrees: readonly MissionWorktree[] | undefined,
): MissionWorktree | null {
  if (!worktrees || worktrees.length === 0) return null;
  return (
    worktrees.find((worktree) => ACTIVE_STATUSES.has(worktree.status)) ??
    worktrees[0] ??
    null
  );
}

export function flattenMissionBranchGroups<
  TMission extends { readonly worktrees?: readonly MissionWorktree[] },
>(missions: readonly TMission[]): MissionBranchRow<TMission>[] {
  const loose: MissionBranchRow<TMission>[] = [];
  const groups = new Map<string, { status: MissionWorktree['status']; rows: MissionBranchRow<TMission>[] }>();
  for (const mission of missions) {
    const primary = primaryMissionWorktree(mission.worktrees);
    if (!primary) {
      loose.push({ kind: 'mission', mission });
      continue;
    }
    const group = groups.get(primary.branch) ?? { status: primary.status, rows: [] };
    group.rows.push({ kind: 'mission', mission });
    groups.set(primary.branch, group);
  }
  const grouped: MissionBranchRow<TMission>[] = [];
  for (const [branch, group] of groups) {
    grouped.push({ kind: 'branch', branch, status: group.status });
    grouped.push(...group.rows);
  }
  return [...loose, ...grouped];
}

/** Estado do worktree em uma palavra; `ready` não precisa de rótulo. */
export function worktreeStatusLabel(
  status: MissionWorktree['status'],
): string | null {
  switch (status) {
    case 'reserved':
      return 'reservado';
    case 'queued':
      return 'na fila';
    case 'integrated':
      return 'integrado';
    case 'failed':
      return 'falhou';
    case 'abandoned':
      return 'abandonado';
    case 'ready':
      return null;
  }
}
