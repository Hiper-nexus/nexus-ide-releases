/**
 * Proveniência de rota: memória curta das últimas RouteDecisions entregues ao
 * orquestrador, para que o spawn ad-hoc (sem agentName) de modelos com warning
 * de catálogo exija uma decisão real do nexus_route_task em vez de aceitar o
 * default arbitrário da CLI (ex.: grok-4.5). Pure logic — testável sem MCP.
 */

export interface RouteProvenanceEntry {
  adapterId: string;
  model?: string;
}

export interface SpawnGateModelInfo {
  warning?: string;
}

// Limitação aceita (Onda 0): ring ÚNICO do processo main, sem escopo por
// missão, sem TTL e sem consumo — uma decisão recente autoriza o mesmo
// adapter+model para qualquer missão até ser evictada. O enforcement completo
// (reserva por missão, expiração) é a Fase 2 do plano do dossiê.
const RECENT_CAP = 16;

let recentDecisions: RouteProvenanceEntry[] = [];

export function clearRouteProvenance(): void {
  recentDecisions = [];
  missionlessUses = [];
}

/**
 * Memória curta de rotas SEM missão (F-1291). Reserva de rota só nasce com
 * missionId, então o spawn do operador nunca aparecia em
 * `consumedRouteCountsByAdapterSince` e o fair-share global era no-op fora de
 * missão — a mesma CLI repetia para sempre. Cada decisão sem missão (nunca
 * sugestão do hook) soma 1 aqui, com timestamp para a janela de 7 dias.
 *
 * Limitação herdada do ring acima: memória do processo main, sem escopo por
 * checkout. Para o fair-share (gap 2 em 7 dias) o sinal entre checkouts é
 * desprezível; a alternativa seria não contar nada — o bug.
 */
interface MissionlessUse {
  adapterId: string;
  at: number;
}

const MISSIONLESS_CAP = 128;

let missionlessUses: MissionlessUse[] = [];

export function recordMissionlessRouteDecision(adapterId: string, at: number = Date.now()): void {
  missionlessUses = [
    ...missionlessUses.slice(-(MISSIONLESS_CAP - 1)),
    { adapterId, at },
  ];
}

/** Usos sem missão por adapter desde `sinceMs` — insumo do fair-share. */
export function missionlessRouteCountsByAdapterSince(sinceMs: number): Map<string, number> {
  const counts = new Map<string, number>();
  for (const use of missionlessUses) {
    if (use.at < sinceMs) continue;
    counts.set(use.adapterId, (counts.get(use.adapterId) ?? 0) + 1);
  }
  return counts;
}

export function recordRouteDecision(decision: RouteProvenanceEntry): void {
  recentDecisions = [
    ...recentDecisions.slice(-(RECENT_CAP - 1)),
    { adapterId: decision.adapterId, model: decision.model },
  ];
}

export function hasRecentRouteMatch(adapterId: string, model?: string): boolean {
  return recentDecisions.some(
    (entry) => entry.adapterId === adapterId && entry.model === model,
  );
}

/**
 * Retorna a mensagem de erro que o handler de spawn ad-hoc deve lançar, ou
 * null quando o spawn pode prosseguir. Só gateia modelo EXPLÍCITO com warning
 * de catálogo e sem decisão recente do router — spawns de roster (agentName)
 * e modelos limpos nunca passam por aqui.
 */
export function adHocSpawnGateError(
  adapterId: string,
  model: string | undefined,
  info: SpawnGateModelInfo | null | undefined,
): string | null {
  if (!model || !info?.warning) return null;
  if (hasRecentRouteMatch(adapterId, model)) return null;
  return (
    `route_required: o modelo ${adapterId}:${model} tem warning de catálogo ` +
    `("${info.warning}") e não veio de uma decisão do router. Chame ` +
    'nexus_route_task e spawne com o adapter/model/effort retornados (o ' +
    'router escolhe um modelo avaliado/estável). Se este modelo específico ' +
    'for realmente necessário, o usuário deve selecioná-lo manualmente pela UI.'
  );
}
