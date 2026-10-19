/**
 * F-1427: falha de CLI numa MISSÃO que não é morte espontânea.
 *
 * A mortalidade de worker (`worker-mortality.ts`, F-918) só conta a CLI que
 * saiu sozinha — pane fechado por pedido fica de fora de propósito, porque o
 * disjuntor de writer recusa spawn e um fechamento de limpeza não pode
 * bloquear ninguém. Mas a rota usava a mesma régua para honrar o `exclude` do
 * orquestrador: em 13/10 o MiMo travou >1 h, o MiniMax caiu num erro de
 * provedor, o Maestro fechou os dois e pediu `exclude: ["mimo-code",
 * "minimax-code"]` — e ouviu "exclude ignorado (CLI saudável) … sem morte
 * nesta missão".
 *
 * Este registro guarda, por (missão, CLI), as falhas que provam que a CLI não
 * fez a tarefa nesta missão:
 *  - `closed-without-delivery`: o orquestrador fechou o pane do worker que já
 *    tinha recebido a tarefa, sem handoff dele;
 *  - `no-execution-proof`: o supervisor do F-1414 reabriu a tarefa noutra CLI
 *    (não começou, recusou, travou no boot);
 *  - `provider-error`: o pane parou no erro de provedor/rede da própria CLI e
 *    não voltou depois do retry;
 *  - `usage-limit`: o limite confirmado tirou a tarefa do pane;
 *  - `credential-remap`: o gate pré-spawn recusou a credencial e o assento
 *    foi remapeado para outra CLI antes de o pane nascer;
 *  - `idle-without-delivery`: o worker ficou ocioso sem commit nem handoff
 *    e o supervisor reabriu a tarefa noutra CLI.
 *
 * Duas leituras, nenhuma bloqueia spawn sozinha:
 *  - o `exclude` do caller passa a valer para a CLI (`tools-domain`);
 *  - cada falha entra como amostra `failed` no "sucesso 14d" da rota
 *    (`routeFailureOutcomeRows`), como a falha sintética do enforcement.
 *
 * Memória do processo, como o disjuntor e o `cli-limit-registry`: partida fria
 * = nenhuma falha. Uma falha por pane/sessão (dedupe), lista limitada.
 */

import type { RouteOutcomeCount } from './route-pipeline';

export type MissionCliFailureCause =
  | 'closed-without-delivery'
  | 'no-execution-proof'
  | 'provider-error'
  | 'usage-limit'
  | 'credential-remap'
  | 'idle-without-delivery';

export interface MissionCliFailure {
  readonly missionId: string;
  readonly adapterId: string;
  readonly model?: string;
  readonly cause: MissionCliFailureCause;
  /** Pane ou sessão da tentativa: a mesma tentativa conta uma vez só. */
  readonly attemptKey: string;
  readonly at: number;
}

const MAX_FAILURES = 512;
const failures = new Map<string, MissionCliFailure>();

const CAUSE_LABEL: Readonly<Record<MissionCliFailureCause, string>> = {
  'closed-without-delivery': 'fechado sem entrega',
  'no-execution-proof': 'sem prova de execução',
  'provider-error': 'erro do provedor',
  'usage-limit': 'limite de uso',
  'credential-remap': 'credencial recusada no spawn',
  'idle-without-delivery': 'ocioso sem entrega',
};

export function noteMissionCliFailure(
  input: Omit<MissionCliFailure, 'at'> & { readonly at?: number },
): MissionCliFailure | null {
  if (!input.missionId || !input.adapterId || !input.attemptKey) return null;
  const key = `${input.missionId}\0${input.attemptKey}`;
  const existing = failures.get(key);
  if (existing) return existing;
  const failure: MissionCliFailure = {
    missionId: input.missionId,
    adapterId: input.adapterId,
    ...(input.model ? { model: input.model } : {}),
    cause: input.cause,
    attemptKey: input.attemptKey,
    at: input.at ?? Date.now(),
  };
  failures.set(key, failure);
  while (failures.size > MAX_FAILURES) {
    const oldest = failures.keys().next().value;
    if (oldest === undefined) break;
    failures.delete(oldest);
  }
  return failure;
}

export function missionCliFailures(
  missionId: string,
  adapterId: string,
): MissionCliFailure[] {
  return [...failures.values()].filter(
    (failure) => failure.missionId === missionId && failure.adapterId === adapterId,
  );
}

/** "minimax-code (erro do provedor)" — o motivo que vai ao recibo da rota. */
export function missionCliFailureNote(missionId: string, adapterId: string): string {
  const causes = [...new Set(missionCliFailures(missionId, adapterId).map((f) => CAUSE_LABEL[f.cause]))];
  return causes.length > 0 ? `${adapterId} (${causes.join(', ')})` : adapterId;
}

/**
 * Amostras `failed` para o índice de sucesso 14d: uma linha por (CLI, modelo)
 * com `successes: 0` e o total de falhas na janela.
 */
export function routeFailureOutcomeRows(sinceMs: number): RouteOutcomeCount[] {
  const rows = new Map<string, { adapterId: string; model?: string; total: number }>();
  for (const failure of failures.values()) {
    if (failure.at < sinceMs) continue;
    const key = `${failure.adapterId}\0${failure.model ?? ''}`;
    const row = rows.get(key) ?? {
      adapterId: failure.adapterId,
      ...(failure.model ? { model: failure.model } : {}),
      total: 0,
    };
    row.total += 1;
    rows.set(key, row);
  }
  return [...rows.values()].map((row) => ({ ...row, successes: 0 }));
}

export function resetMissionCliFailures(missionId?: string): void {
  if (!missionId) {
    failures.clear();
    return;
  }
  for (const [key, failure] of failures) {
    if (failure.missionId === missionId) failures.delete(key);
  }
}

/** Pane do `nexus_pane_close`, lido antes de fechar (a sessão some depois). */
export interface ClosedPaneFacts {
  readonly paneId: string;
  readonly sessionId?: string | null;
  readonly adapterId?: string | null;
  readonly missionId?: string | null;
  readonly role?: string;
  readonly operatorOpened?: boolean;
  /** Estado físico da sessão na hora do pedido de fechar. */
  readonly sessionState?: string | null;
  /** O pane nasceu com um pedido de tarefa (`nexus_pane_spawn`, F-765). */
  readonly hasTaskRequest: boolean;
  /** Autores dos handoffs desta sessão (sintéticos `nexus-*` não provam entrega). */
  readonly handoffAuthors: readonly (string | null | undefined)[];
  readonly model?: string;
}

/**
 * F-1427: fechar pelo Maestro o pane do worker que recebeu a tarefa e não
 * entregou é falha da CLI nesta missão. Fica de fora: pane do operador
 * (F-231), orquestrador, pane sem pedido de tarefa, sessão que ainda nascia
 * (o veredito é do watchdog de início) e quem entregou um handoff real.
 */
export function closedWorkerFailure(
  facts: ClosedPaneFacts,
): Omit<MissionCliFailure, 'at'> | null {
  if (facts.role !== 'worker' || facts.operatorOpened === true) return null;
  if (!facts.missionId || !facts.adapterId || !facts.sessionId) return null;
  if (!facts.hasTaskRequest) return null;
  if (!facts.sessionState || facts.sessionState === 'spawning') return null;
  const delivered = facts.handoffAuthors.some(
    (author) => !(author ?? '').startsWith('nexus-'),
  );
  if (delivered) return null;
  return {
    missionId: facts.missionId,
    adapterId: facts.adapterId,
    ...(facts.model ? { model: facts.model } : {}),
    cause: 'closed-without-delivery',
    attemptKey: facts.sessionId,
  };
}
