import type { PaneRuntimeState } from '../../shared/orch-types';
import {
  isJevUnavailableReason,
  type SpawnRouteInfo,
} from '../../shared/spawn-route';

/**
 * Peças puras do spawn da mão do operador sempre roteado (A, 25/09): o agente
 * descreve a tarefa, o Jev + tabela escolhem CLI/modelo/esforço.
 */

function nonBlank(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/** Texto que o roteador classifica: task, senão prompt, senão title. */
export function operatorRouteTask(args: Record<string, unknown>): string | null {
  return nonBlank(args.task) ?? nonBlank(args.prompt) ?? nonBlank(args.title) ?? null;
}

/** O que o agente pediu e o roteamento descartou — vai no recibo. */
export function ignoredRouteChoice(
  args: Record<string, unknown>,
): { adapterId?: string; model?: string; effort?: string } | null {
  const adapterId = nonBlank(args.adapterId);
  const model = nonBlank(args.model);
  const effort = nonBlank(args.effort);
  if (!adapterId && !model && !effort) return null;
  return {
    ...(adapterId ? { adapterId } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
}

export interface UseCountPane {
  readonly sessionId: string | null;
  readonly adapterId?: string;
  readonly state: PaneRuntimeState;
}

const INACTIVE: ReadonlySet<PaneRuntimeState> = new Set(['exited', 'parked', 'hibernated']);

/**
 * CLIs já em uso pelo agente pai: a dele e a de cada filho vivo que ele
 * abriu. É "por pai" porque o Main ainda não conhece abas (sub-projeto B).
 */
export function operatorChildUseCounts(
  parentSessionId: string | undefined,
  parentAdapterId: string | undefined,
  panes: readonly UseCountPane[],
  parentOf: (sessionId: string) => string | undefined,
): Map<string, number> {
  const counts = new Map<string, number>();
  if (!parentSessionId) return counts;
  const bump = (adapterId: string) => counts.set(adapterId, (counts.get(adapterId) ?? 0) + 1);
  if (parentAdapterId) bump(parentAdapterId);
  for (const pane of panes) {
    if (!pane.sessionId || !pane.adapterId || INACTIVE.has(pane.state)) continue;
    if (parentOf(pane.sessionId) !== parentSessionId) continue;
    bump(pane.adapterId);
  }
  return counts;
}

/** Origem da rota que o renderer exibe (chip + toast). */
export function spawnRouteFrom(
  route: Record<string, unknown> | undefined,
): SpawnRouteInfo | undefined {
  if (!route) return undefined;
  const raw = route.classifierSource;
  const source = raw === 'jev' || raw === 'mixed' ? raw : 'heuristic';
  return isJevUnavailableReason(route.jevUnavailable)
    ? { source, jevUnavailable: route.jevUnavailable }
    : { source };
}

export function routeString(
  route: Record<string, unknown> | undefined,
  key: 'adapterId' | 'model' | 'effort',
): string | undefined {
  return nonBlank(route?.[key]);
}

/**
 * O renderer herda a aba do pai pelo PANE id. A sessão do pai
 * (`operatorParentSessionId`) é autoridade do Main e nunca cruza para lá.
 */
export function parentPaneIdFor(
  parentSessionId: string | undefined,
  findPaneId: (sessionId: string) => string | undefined,
): string | undefined {
  return parentSessionId ? findPaneId(parentSessionId) : undefined;
}
