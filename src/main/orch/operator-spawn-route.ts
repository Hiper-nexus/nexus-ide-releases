import type { PaneRuntimeState } from '../../shared/orch-types';
import {
  isJevUnavailableReason,
  parseSpawnRouteConfidence,
  parseSpawnRuleChoice,
  type SpawnRouteConfidence,
  type SpawnRouteInfo,
  type SpawnRuleChoiceReceipt,
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

export interface MissionUsePane extends UseCountPane {
  readonly paneId?: string;
  readonly missionId?: string;
}

/**
 * CLIs dos panes VIVOS da missão que o registro durável (`mission_panes`) não
 * conhece. Os helpers da missão da aba (0.76.110) nascem sem linha ali e a
 * reserva de rota some ao ser consumida: o roteador via "só o orquestrador em
 * uso" a cada spawn e mandava todos os helpers para a mesma CLI (F-658).
 */
export function liveMissionAdapterIds(
  missionId: string,
  panes: readonly MissionUsePane[],
  recordedPaneIds: ReadonlySet<string>,
): string[] {
  return panes
    .filter(
      (pane) =>
        pane.missionId === missionId &&
        Boolean(pane.adapterId) &&
        !INACTIVE.has(pane.state) &&
        !(pane.paneId && recordedPaneIds.has(pane.paneId)),
    )
    .map((pane) => pane.adapterId!);
}

/** Helpers vivos na mesma CLI a partir dos quais o recibo sugere diversificar. */
export const SAME_ADAPTER_DIVERSITY_THRESHOLD = 2;

/**
 * F-672: quem fixa `adapterId` recebe a CLI que pediu — escolha explícita é
 * respeitada —, mas o recibo avisa quando ela já tem helpers vivos na missão.
 * Campo 28/09: depois de uma falha do Codex já corrigida, o orquestrador passou
 * a fixar Claude em todo spawn e o roteamento pelo Jev nunca mais foi usado.
 */
export function sameAdapterDiversityHint(
  adapterId: string | undefined,
  missionId: string | undefined,
  panes: readonly (MissionUsePane & { readonly role?: string })[],
  newPaneId?: string,
): { sameAdapterLive: number; hint: string } | null {
  if (!adapterId || !missionId) return null;
  const live = panes.filter(
    (pane) =>
      pane.missionId === missionId &&
      pane.adapterId === adapterId &&
      pane.role !== 'orchestrator' &&
      !INACTIVE.has(pane.state) &&
      pane.paneId !== newPaneId,
  ).length;
  if (live < SAME_ADAPTER_DIVERSITY_THRESHOLD) return null;
  return {
    sameAdapterLive: live,
    hint:
      `Já há ${live} helpers vivos em ${adapterId} nesta missão. Para distribuir ` +
      'o trabalho entre CLIs, omita adapterId e model no próximo nexus_pane_spawn: ' +
      'o Nexus roteia pela tarefa (Jev) entre as CLIs prontas.',
  };
}

/** CLIs de terminal que não carregam o MCP do Nexus (entrega só pelo fim do PTY). */
export function adapterIdsWithoutNexusMcp<
  T extends { readonly id: string; readonly kind: string },
>(adapters: readonly T[], canUseNexusMcp: (adapter: T) => boolean): string[] {
  return adapters
    .filter((adapter) => adapter.kind === 'cli-pty' && !canUseNexusMcp(adapter))
    .map((adapter) => adapter.id);
}

/**
 * F-802: fora do Autopilot o pty-ipc recusa "cannot enforce native read-only
 * authority" para a CLI que não confina leitura. A rota do helper somente
 * leitura da mão do operador não pode entregar uma CLI que o spawn vai
 * derrubar: o pool fica só com as que confinam. Se NENHUMA instalada confina,
 * o pool não é tocado (o spawn mostra o erro real; ausência de declaração não
 * derruba a rota inteira) — o mesmo contrato do filtro de busca na web (F-771).
 */
export function limitToReadOnlyCapable<
  T extends {
    readonly installed: boolean;
    readonly capabilities?: { readonly readOnlyEnforceable?: boolean };
  },
>(adapters: readonly T[], required: boolean): { adapters: T[]; note: string } {
  const capable = (adapter: T): boolean =>
    adapter.capabilities?.readOnlyEnforceable === true;
  if (!required || !adapters.some((adapter) => adapter.installed && capable(adapter))) {
    return { adapters: [...adapters], note: '' };
  }
  return {
    adapters: adapters.map((adapter) =>
      adapter.installed && !capable(adapter) ? { ...adapter, installed: false } : adapter,
    ),
    note: '; helper somente leitura fora do Autopilot — pool limitado às CLIs que confinam leitura',
  };
}

/**
 * Recibo da proveniência do Jev (confiança por dimensão + o que a regra teria
 * escolhido), copiado do resultado da rota SÓ quando o Jev influenciou e só nos
 * campos conhecidos: ids de CLI/modelo/esforço e números. O texto da tarefa e
 * qualquer outra chave que alguém tenha pendurado no objeto não passam.
 */
export function routeJevReceipt(route: Record<string, unknown> | undefined): {
  confidence?: SpawnRouteConfidence;
  ruleChoice?: SpawnRuleChoiceReceipt;
} {
  const source = route?.classifierSource;
  if (source !== 'jev' && source !== 'mixed') return {};
  const confidence = parseSpawnRouteConfidence(route?.confidence);
  const ruleChoice = parseSpawnRuleChoice(route?.ruleChoice);
  return {
    ...(confidence ? { confidence } : {}),
    ...(ruleChoice ? { ruleChoice } : {}),
  };
}

/** Origem da rota que o renderer exibe (chip + toast). */
export function spawnRouteFrom(
  route: Record<string, unknown> | undefined,
): SpawnRouteInfo | undefined {
  if (!route) return undefined;
  const raw = route.classifierSource;
  const source = raw === 'jev' || raw === 'mixed' ? raw : 'heuristic';
  return {
    source,
    ...(isJevUnavailableReason(route.jevUnavailable)
      ? { jevUnavailable: route.jevUnavailable }
      : {}),
    ...routeJevReceipt(route),
  };
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
