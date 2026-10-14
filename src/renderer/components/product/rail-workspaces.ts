import type { MissionSummarySnapshot } from '../../../shared/mission-engine-contract';
import type { WorkspaceRailWorkspace } from './WorkspaceRail';

/**
 * Projeção do rail multi-workspace (2026-08-17): a seção "Em andamento"
 * deixou de mostrar só o workspace corrente — missão rodando em outro
 * workspace era invisível por construção (App.tsx só alimentava o corrente).
 *
 * Regras:
 * - O workspace CORRENTE mantém todas as suas missões (comportamento atual).
 * - Vizinhos (recentes ≠ corrente) entram em "Em andamento" apenas com
 *   missões ATIVAS (running/blocked/recovering) — concluídas não poluem.
 * - "Recentes" segue como lista de workspaces sem missões no chip.
 * - Um workspace em "Em andamento" NUNCA reaparece em "Recentes".
 * - O corrente com panes vivos (mesmo sem missão) carrega `livePaneCount`
 *   para a linha mostrar o andamento; vizinhos só são conhecidos pelas
 *   missões ativas (o renderer não tem os panes de outro workspace).
 */

const ACTIVE_NEIGHBOR_MISSION_STATES: ReadonlySet<
  MissionSummarySnapshot['state']
> = new Set([
  'running',
  'blocked_user',
  'blocked_technical',
  'recovering',
] as const);

export interface RailWorkspaceInput {
  readonly path: string;
  readonly name: string;
}

export interface ProjectRailWorkspacesInput {
  readonly current: RailWorkspaceInput | null;
  readonly recents: readonly RailWorkspaceInput[];
  readonly currentSummaries: readonly MissionSummarySnapshot[];
  /** Panes vivos do workspace corrente (layout do renderer). */
  readonly currentLivePaneCount?: number;
  /** Missões do workspace corrente cujo motor concluiu e o humano ainda não. */
  readonly currentAwaitingReviewIds?: readonly string[];
  /**
   * Summaries de OUTROS workspaces, key = path. Só os ativos são usados; a
   * chave ausente significa "sem missão ativa lá".
   */
  readonly crossWorkspaceSummaries: Readonly<
    Record<string, readonly MissionSummarySnapshot[]>
  >;
}

function toRailMission(
  summary: MissionSummarySnapshot,
  awaitingReviewIds?: ReadonlySet<string>,
) {
  return {
    id: summary.id,
    title: summary.title,
    status: summary.state,
    needsAttention: summary.needsAttention,
    updatedAt: summary.updatedAt,
    ...(summary.worktrees ? { worktrees: summary.worktrees } : {}),
    ...(summary.stateReason ? { stateReason: summary.stateReason } : {}),
    ...(awaitingReviewIds?.has(summary.id)
      ? { awaitsOperatorReview: true as const }
      : {}),
  };
}

export function projectRailWorkspaces(
  input: ProjectRailWorkspacesInput,
): {
  readonly activeWorkspaces: readonly WorkspaceRailWorkspace[];
  readonly recentWorkspaces: readonly WorkspaceRailWorkspace[];
} {
  const currentPath = input.current?.path ?? null;
  const activeWorkspaces: WorkspaceRailWorkspace[] = [];

  const awaitingReviewIds = new Set(input.currentAwaitingReviewIds ?? []);
  if (input.current) {
    activeWorkspaces.push({
      id: input.current.path,
      name: input.current.name,
      path: input.current.path,
      missions: input.currentSummaries.map((summary) =>
        toRailMission(summary, awaitingReviewIds),
      ),
      ...(input.currentLivePaneCount
        ? { livePaneCount: input.currentLivePaneCount }
        : {}),
    });
  }

  for (const workspace of input.recents) {
    if (workspace.path === currentPath) continue;
    const summaries = input.crossWorkspaceSummaries[workspace.path] ?? [];
    const active = summaries.filter((summary) =>
      ACTIVE_NEIGHBOR_MISSION_STATES.has(summary.state),
    );
    if (active.length > 0) {
      activeWorkspaces.push({
        id: workspace.path,
        name: workspace.name,
        path: workspace.path,
        missions: active.map((summary) => toRailMission(summary)),
      });
    }
  }

  const activePaths = new Set(activeWorkspaces.map((w) => w.path));
  const recentWorkspaces: WorkspaceRailWorkspace[] = input.recents
    .filter(
      (workspace) =>
        workspace.path !== currentPath && !activePaths.has(workspace.path),
    )
    .map((workspace) => ({
      id: workspace.path,
      name: workspace.name,
      path: workspace.path,
      missions: [],
    }));

  return { activeWorkspaces, recentWorkspaces };
}
