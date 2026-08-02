/**
 * Colisão REAL de ownership entre missões: enfileirar, não matar.
 *
 * A procedência da reivindicação já foi corrigida — permissão generosa
 * (coverage permit) deixou de ser veto e a exclusividade continua medida. Isso
 * resolveu "missão B nunca começa". O que sobrou é o caso em que a colisão é
 * verdadeira: dois planos nomearam o MESMO arquivo. Hoje esse caminho morre.
 *
 * `decideSchedule`/`selectDisjointWave` (mission-scheduler.ts) já sabem deferir
 * a colisão INTRA-missão: as tarefas que intersectam ownership admitida ou
 * worker vivo caem em `deferred`, o plano vira `wait` com razão nomeada
 * ("ready tasks blocked by ownership overlap or reserved glue") e a tarefa
 * volta no próximo tick. Ela consegue fazer isso porque enxerga o conjunto
 * inteiro: as tarefas da missão e os workers dela.
 *
 * O caminho CROSS-missão não tem essa visão. A exclusividade entre missões só é
 * medida lá embaixo, no `WorktreeManager`, no instante da reserva — depois do
 * claim durável, dentro do dispatch. De lá ela sobe como `OwnershipOverlapError`
 * e cai no catch genérico do dispatch, onde vira falha. Em campo isso apareceu
 * como um plano selado com 5 tarefas cujas 5 falharam ~4s depois do despacho:
 * não foram os workers que falharam — o despacho abortou.
 *
 * Este módulo dá ao caminho cross-missão o mesmo deferimento, com o que a
 * espera precisa para não ser pior que a falha:
 *
 *  1. NOME — a espera diz QUEM segura (`conflictingMissionId`/`conflictingTaskId`,
 *     campos que o erro passou a carregar exatamente para esta mensagem) e QUAIS
 *     reivindicações colidiram.
 *  2. TETO — quem segura pode nunca soltar (missão travada, worktree órfão).
 *     Estourado o teto, a espera vira falha nomeada e acionável, no espírito do
 *     dead-letter da fila de merge (merge-stall-watchdog.ts): nada fica em
 *     espera para sempre, e o deadline vencido produz erro com CTA em vez de
 *     silêncio.
 *  3. CICLO — se A espera B e B espera A, nenhum dos dois solta e o teto seria
 *     só uma soneca cara. A espera mútua é detectada e nomeada na hora.
 *
 * Puro de propósito (sem IO, `now` injetado): a parte que precisa de teste é a
 * decisão. O registro de arestas é um mapa de processo, como
 * `worktreeCreateChains` no dispatch — as missões concorrentes tickam no mesmo
 * main process, então é ali que o grafo de espera existe.
 */

/**
 * Espelho de `TASK_DISPATCH_HEARTBEAT_LEASE_MS` (task-dispatch-lifecycle.ts).
 *
 * Espelhado em vez de importado para manter este módulo puro: aquele arquivo
 * arrasta pty-manager/gate/acp para o grafo de import de um módulo que só
 * decide. `mission-ownership-wait.test.ts` importa a constante real e trava o
 * espelho contra drift.
 */
export const HOLDER_WORKER_LEASE_UPPER_BOUND_MS = 10 * 60_000;

/**
 * Espelho de `STALLED_MERGE_ATTEMPT_MS` (merge-stall-watchdog.ts): o deadline
 * depois do qual um merge abandonado no mesmo processo é dead-lettered.
 */
export const HOLDER_MERGE_DEADLINE_UPPER_BOUND_MS = 25 * 60_000;

/**
 * Teto da espera cross-missão.
 *
 * A operação esperada é "o detentor solta a reserva". Ele solta quando o
 * registro dele sai dos status ativos — integrado ou falho. Duas travas do
 * produto GARANTEM que isso acontece, e o pior caso legítimo é elas em série:
 *
 *   • o worker do detentor morre calado → o lease de heartbeat expira e o
 *     dispatch é reclamado em até 10 min;
 *   • o merge do detentor é abandonado dentro do processo → o watchdog de
 *     stall o manda para dead-letter em até 25 min.
 *
 * Um detentor que sobreviveu aos DOIS deadlines não vai ser solto por watchdog
 * nenhum: a reserva está órfã, e continuar esperando é a espera eterna que este
 * módulo existe para impedir. Por isso o teto é a soma — o maior bound legítimo
 * da cadeia de liberação — e não um número escolhido a dedo.
 *
 * O relógio é ancorado na PRIMEIRA espera da tarefa, não reiniciado a cada
 * detentor novo. Detentores que se revezam mantendo a mesma tarefa parada por
 * 35 min não são contenção saudável: são inanição, e o teto tem que enxergá-la.
 */
export const OWNERSHIP_WAIT_CEILING_MS =
  HOLDER_WORKER_LEASE_UPPER_BOUND_MS + HOLDER_MERGE_DEADLINE_UPPER_BOUND_MS;

/** Profundidade máxima ao desembrulhar `cause` procurando o erro de overlap. */
const MAX_CAUSE_DEPTH = 8;

/** Quantas reivindicações colididas cabem numa razão legível. */
const MAX_REPORTED_CLAIMS = 6;

export interface CrossMissionOwnershipConflict {
  readonly holderMissionId: string;
  readonly holderTaskId: string;
  /** Arquivos/símbolos/domínios que colidiram, já rotulados. */
  readonly claims: readonly string[];
}

export interface OwnershipWaitEdge {
  readonly waiterMissionId: string;
  readonly waiterTaskId: string;
  readonly holderMissionId: string;
  readonly holderTaskId: string;
  /** Quando ESTA tarefa começou a esperar (não quando o detentor mudou). */
  readonly since: number;
}

export type OwnershipWaitDecision =
  | {
      readonly kind: 'wait';
      readonly reason: string;
      readonly waitedMs: number;
      readonly conflict: CrossMissionOwnershipConflict;
    }
  | {
      readonly kind: 'expired';
      readonly reason: string;
      readonly waitedMs: number;
      readonly conflict: CrossMissionOwnershipConflict;
    }
  | {
      readonly kind: 'deadlock';
      readonly reason: string;
      readonly waitedMs: number;
      readonly conflict: CrossMissionOwnershipConflict;
      readonly cycle: readonly string[];
    };

// ── Reconhecimento ──────────────────────────────────────────────────────────

interface OverlapErrorShape {
  readonly name?: unknown;
  readonly conflictingMissionId?: unknown;
  readonly conflictingTaskId?: unknown;
  readonly files?: unknown;
  readonly symbols?: unknown;
  readonly domains?: unknown;
  readonly cause?: unknown;
}

function asRecord(value: unknown): OverlapErrorShape | null {
  return value !== null && typeof value === 'object'
    ? (value as OverlapErrorShape)
    : null;
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/**
 * Reconhecimento estrutural, de propósito: importar `OwnershipOverlapError` de
 * runtime/worktree-contract arrastaria node:crypto e o contrato de worktree
 * inteiro para dentro de um módulo puro — e o erro já atravessa fronteiras de
 * processo/serialização onde `instanceof` não sobrevive.
 *
 * Retorna `null` — ou seja, o comportamento de hoje permanece — em três casos
 * que NÃO são a colisão cross-missão que sabemos esperar:
 *  • o erro não é um overlap de ownership;
 *  • o detentor é a PRÓPRIA missão (colisão intra-missão: `decideSchedule` já é
 *    a autoridade que defere isso, e um overlap intra que chegou até aqui é
 *    corrida real, não contenção — continua falhando como hoje);
 *  • o detentor é anônimo. Esperar sem saber por quem é exatamente a espera
 *    cega que este módulo recusa.
 */
export function crossMissionOwnershipConflict(
  error: unknown,
  waiterMissionId: string,
): CrossMissionOwnershipConflict | null {
  let candidate = asRecord(error);
  for (
    let depth = 0;
    candidate !== null && depth < MAX_CAUSE_DEPTH;
    depth += 1
  ) {
    if (candidate.name === 'OwnershipOverlapError') break;
    candidate = asRecord(candidate.cause);
  }
  if (candidate === null || candidate.name !== 'OwnershipOverlapError') {
    return null;
  }
  const holderMissionId = nonEmptyString(candidate.conflictingMissionId);
  const holderTaskId = nonEmptyString(candidate.conflictingTaskId);
  if (holderMissionId === null || holderTaskId === null) return null;
  if (holderMissionId === waiterMissionId) return null;
  return Object.freeze({
    holderMissionId,
    holderTaskId,
    claims: Object.freeze([
      ...stringList(candidate.files),
      ...stringList(candidate.symbols).map((symbol) => `symbol:${symbol}`),
      ...stringList(candidate.domains).map((domain) => `domain:${domain}`),
    ]),
  });
}

// ── Grafo de espera ─────────────────────────────────────────────────────────

const waitEdges = new Map<string, OwnershipWaitEdge>();

function edgeKey(waiterMissionId: string, waiterTaskId: string): string {
  return `${waiterMissionId} ${waiterTaskId}`;
}

export function recordOwnershipWaitEdge(edge: OwnershipWaitEdge): void {
  waitEdges.set(edgeKey(edge.waiterMissionId, edge.waiterTaskId), edge);
}

export function clearOwnershipWaitEdge(
  waiterMissionId: string,
  waiterTaskId: string,
): void {
  waitEdges.delete(edgeKey(waiterMissionId, waiterTaskId));
}

/**
 * Poda as arestas de UMA missão que não correspondem mais a uma tarefa
 * esperando. Sem isso uma tarefa que saiu da espera (despachou, falhou, sumiu
 * do plano) deixaria uma aresta fantasma capaz de forjar um ciclo.
 */
export function pruneOwnershipWaitEdgesForMission(
  waiterMissionId: string,
  waitingTaskIds: ReadonlySet<string>,
): void {
  for (const [key, edge] of waitEdges) {
    if (edge.waiterMissionId !== waiterMissionId) continue;
    if (waitingTaskIds.has(edge.waiterTaskId)) continue;
    waitEdges.delete(key);
  }
}

export function ownershipWaitEdges(): readonly OwnershipWaitEdge[] {
  return Object.freeze([...waitEdges.values()]);
}

/** Só para testes: o registro é estado de processo, como as chains de worktree. */
export function resetOwnershipWaitGraph(): void {
  waitEdges.clear();
}

/**
 * Ciclo de espera mútua em nível de MISSÃO. A colisão que interessa é entre
 * missões (a intra já é deferida antes de chegar aqui), então o vértice é a
 * missão e a aresta é "esta missão espera aquela". Retorna o caminho fechado
 * (`['a','b','a']`) ou `null`.
 */
export function findOwnershipWaitCycle(
  edges: readonly OwnershipWaitEdge[],
  from: string,
): readonly string[] | null {
  const adjacency = new Map<string, Set<string>>();
  for (const edge of edges) {
    const holders = adjacency.get(edge.waiterMissionId) ?? new Set<string>();
    holders.add(edge.holderMissionId);
    adjacency.set(edge.waiterMissionId, holders);
  }

  const path: string[] = [from];
  const visited = new Set<string>([from]);

  const walk = (missionId: string): readonly string[] | null => {
    for (const holder of adjacency.get(missionId) ?? []) {
      path.push(holder);
      if (holder === from) return Object.freeze([...path]);
      if (!visited.has(holder)) {
        visited.add(holder);
        const found = walk(holder);
        if (found) return found;
      }
      path.pop();
    }
    return null;
  };

  return walk(from);
}

// ── Razões nomeadas ─────────────────────────────────────────────────────────

/**
 * As razões dizem "worktree ... reservado ..." de propósito: é assim que
 * `missionBlockCause` (src/shared/mission-block-cause.ts) as classifica como
 * `ownership-conflict` e as apresenta ao operador com a CTA certa ("libere a
 * reserva presa e retome a missão"). A classificação já existe; aqui só
 * escrevemos a causa na língua que ela lê, em vez de criar transporte novo.
 */
function claimList(claims: readonly string[]): string {
  if (claims.length === 0) return 'reivindicações não detalhadas';
  const shown = claims.slice(0, MAX_REPORTED_CLAIMS).join(', ');
  const rest =
    claims.length > MAX_REPORTED_CLAIMS
      ? `, +${claims.length - MAX_REPORTED_CLAIMS}`
      : '';
  return `${shown}${rest}`;
}

function minutes(ms: number): number {
  return Math.max(1, Math.round(ms / 60_000));
}

function holderLabel(conflict: CrossMissionOwnershipConflict): string {
  return `${conflict.holderMissionId}/${conflict.holderTaskId}`;
}

function waitReason(
  conflict: CrossMissionOwnershipConflict,
  waitedMs: number,
): string {
  return (
    `capacity_wait: o worktree desta task está reservado pela missão ` +
    `${holderLabel(conflict)} (${claimList(conflict.claims)}); o despacho ` +
    `espera a liberação há ${Math.max(0, Math.round(waitedMs / 1_000))}s em ` +
    `vez de falhar.`
  );
}

function expiredReason(
  conflict: CrossMissionOwnershipConflict,
  waitedMs: number,
  holdersSeen: number,
): string {
  const contention =
    holdersSeen > 1
      ? `Esta task foi bloqueada por ${holdersSeen} reservas diferentes nesse ` +
        `período — é inanição, não uma reserva única presa. `
      : `Nem o lease de heartbeat (${minutes(
          HOLDER_WORKER_LEASE_UPPER_BOUND_MS,
        )} min) nem o deadline de merge estagnado (${minutes(
          HOLDER_MERGE_DEADLINE_UPPER_BOUND_MS,
        )} min) liberaram a reserva: ela está órfã. `;
  return (
    `o worktree desta task continua reservado pela missão ` +
    `${holderLabel(conflict)} depois de ${minutes(waitedMs)} min de espera ` +
    `(teto do despacho: ${minutes(OWNERSHIP_WAIT_CEILING_MS)} min). ` +
    contention +
    `Abra o diagnóstico da missão ${conflict.holderMissionId}, libere a ` +
    `reserva presa e retome esta missão. Reivindicações em conflito: ` +
    `${claimList(conflict.claims)}.`
  );
}

function deadlockReason(
  conflict: CrossMissionOwnershipConflict,
  cycle: readonly string[],
): string {
  return (
    `espera mútua de ownership: o worktree desta task está reservado pela ` +
    `missão ${holderLabel(conflict)}, que por sua vez espera de volta por ` +
    `esta — ciclo ${cycle.join(' → ')}. Nenhum lado solta, então esperar o ` +
    `teto só adiaria a falha. Abra o diagnóstico e libere a reserva de uma ` +
    `das missões do ciclo para quebrá-lo. Reivindicações em conflito: ` +
    `${claimList(conflict.claims)}.`
  );
}

// ── Decisão ─────────────────────────────────────────────────────────────────

export interface OwnershipWaitInput {
  readonly conflict: CrossMissionOwnershipConflict;
  readonly waiter: {
    readonly missionId: string;
    readonly taskId: string;
  };
  /** Quando ESTA tarefa começou a esperar (âncora do teto). */
  readonly since: number;
  readonly now: number;
  /** Quantos detentores distintos já bloquearam esta tarefa nesta espera. */
  readonly holdersSeen: number;
  /** Grafo de espera JÁ incluindo a aresta desta tarefa. */
  readonly edges: readonly OwnershipWaitEdge[];
  readonly ceilingMs?: number;
}

/**
 * Ordem deliberada: ciclo ANTES do teto. Uma espera mútua não fica melhor
 * dormindo 35 min — os dois lados já estão provadamente travados, e adiar a
 * falha só troca um erro acionável agora por um erro acionável tarde.
 */
export function decideOwnershipWait(
  input: OwnershipWaitInput,
): OwnershipWaitDecision {
  const waitedMs = Math.max(0, input.now - input.since);
  const cycle = findOwnershipWaitCycle(input.edges, input.waiter.missionId);
  if (cycle !== null) {
    return Object.freeze({
      kind: 'deadlock' as const,
      reason: deadlockReason(input.conflict, cycle),
      waitedMs,
      conflict: input.conflict,
      cycle,
    });
  }
  const ceilingMs = input.ceilingMs ?? OWNERSHIP_WAIT_CEILING_MS;
  if (waitedMs >= ceilingMs) {
    return Object.freeze({
      kind: 'expired' as const,
      reason: expiredReason(input.conflict, waitedMs, input.holdersSeen),
      waitedMs,
      conflict: input.conflict,
    });
  }
  return Object.freeze({
    kind: 'wait' as const,
    reason: waitReason(input.conflict, waitedMs),
    waitedMs,
    conflict: input.conflict,
  });
}
