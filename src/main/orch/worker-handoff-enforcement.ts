/**
 * Garantia de handoff do worker (paridade Overclock — Stop-hook).
 *
 * No Overclock um worker NÃO consegue encerrar sua sessão sem submeter um
 * handoff: um Stop-hook bloqueia a saída. No Nexus a detecção era inteiramente
 * PÓS-MORTE, e havia um buraco silencioso entre os três guardas existentes:
 *
 *  - `stall-watchdog` só olha worker em estado `busy`
 *    (`stall-watchdog.ts:74` — `if (c.state !== 'busy') return false`);
 *  - o reap de boot não-executante exige `!everExecuted`
 *    (`stall-watchdog.ts:100`) — quem CODIFICOU já executou;
 *  - `worker-handoff-ttl` só age quando existe handoff limpo
 *    (`worker-handoff-ttl.ts:130` — `if (!hasCleanHandoff(...)) return null`).
 *
 * Ou seja: o worker que TRABALHA e depois fica idle SEM entregar handoff não é
 * visto por nenhum dos três. O orquestrador espera para sempre um resultado que
 * nunca chega e a missão morre em silêncio — trabalho acontecendo com zero
 * prova de entrega. Este módulo fecha exatamente esse buraco.
 *
 * Escada de cobrança (não destrutiva, idempotente por sessão):
 *  1. worker fica idle sem handoff → carência (`WORKER_QUIET_GRACE_MS`) para
 *     ele mesmo submeter;
 *  2. ainda mudo → CUTUCADA: um prompt final é digitado no pane pedindo o
 *     handoff (só em PTY idle — nunca dentro de um turno vivo, mesma regra do
 *     `idle-delivery`);
 *  3. ainda mudo após `WORKER_ENFORCE_GRACE_MS` → o Nexus submete POR ELE um
 *     handoff `blocked` com o motivo e o último estado do pane (tail), pela
 *     mesma via durável dos handoffs reais — o orquestrador SEMPRE recebe algo;
 *  4. sessão morta sem handoff → não há quem cutucar: handoff `failed` na hora.
 *
 * Qualquer trabalho novo (status não-idle) desarma a escada: silêncio legítimo
 * de quem voltou a produzir nunca é cobrado.
 */

import type { Handoff } from '../../shared/orch-types';
import type { ProjectExecutionScope } from '../../shared/types';
import { orchWriteSession, tapSessionExit } from '../pty/pty-manager';
import {
  getPaneRuntimeAuthorityBySession,
  readSessionOutput,
  type PaneRuntimeAuthority,
} from './pane-registry';
import { getProjectDomainStores } from './project-domain-store-registry';
import { isSessionInjectableIdle, tapAgentSemanticStatus } from './agent-status';
import { onHandoffSubmitted } from './idle-delivery';

/** Carência para o worker submeter sozinho depois de ficar idle. */
export const WORKER_QUIET_GRACE_MS = 20_000;
/** Carência após a cutucada antes do Nexus submeter no lugar dele. */
export const WORKER_ENFORCE_GRACE_MS = 45_000;
/** Linhas de tail anexadas ao handoff sintético como "último estado". */
const TAIL_LINES = 40;

export const WORKER_HANDOFF_REQUIRED_MARKER = '[NEXUS_HANDOFF_REQUIRED]';

/**
 * Autores sintéticos (watchdogs, esta cobrança) não provam que o WORKER
 * cumpriu o contrato — se contassem, um alerta de stall silenciaria a cobrança
 * do handoff real que nunca veio.
 */
export const SYNTHETIC_HANDOFF_AUTHOR_PREFIX = 'nexus-';

export type QuietWorkerAction = 'ignore' | 'nudge' | 'enforce';

export interface QuietWorkerState {
  readonly role?: string;
  readonly missionRunning: boolean;
  /** Handoff REAL (não sintético) ligado a esta sessão exata. */
  readonly hasHandoff: boolean;
  readonly nudged: boolean;
  readonly enforced: boolean;
  readonly exited: boolean;
}

/** Decisão pura (unit-testável) da escada de cobrança. */
export function decideQuietWorker(state: QuietWorkerState): QuietWorkerAction {
  if (state.role !== 'worker') return 'ignore';
  if (state.enforced) return 'ignore';
  if (state.hasHandoff) return 'ignore';
  // Missão fora de 'running' pertence à máquina de encerramento: um teardown
  // fecha todos os panes de uma vez e não é morte silenciosa.
  if (!state.missionRunning) return 'ignore';
  // Processo morto não tem como ser cutucado — cobra direto.
  if (state.exited) return 'enforce';
  return state.nudged ? 'enforce' : 'nudge';
}

export interface SyntheticHandoffInput {
  readonly status: 'blocked' | 'failed';
  readonly summary: string;
}

export interface WorkerHandoffEnforcementDeps {
  readonly getAuthority: (sessionId: string) => PaneRuntimeAuthority | null;
  readonly listHandoffs: (
    scope: ProjectExecutionScope,
    missionId: string,
  ) => readonly Handoff[];
  readonly missionStatus: (
    scope: ProjectExecutionScope,
    missionId: string,
  ) => string | null;
  readonly isIdle: (sessionId: string) => boolean;
  /** Digita a cobrança no pane do worker; false = não deu para escrever. */
  readonly nudge: (authority: PaneRuntimeAuthority, text: string) => boolean;
  readonly submitSynthetic: (
    authority: PaneRuntimeAuthority,
    input: SyntheticHandoffInput,
  ) => void;
  readonly readTail: (sessionId: string) => string;
  readonly quietGraceMs: number;
  readonly enforceGraceMs: number;
  readonly log: (message: string) => void;
}

function nudgeText(): string {
  return (
    `${WORKER_HANDOFF_REQUIRED_MARKER} Você encerrou seu turno sem entregar o ` +
    'handoff. O orquestrador está bloqueado esperando o seu resultado. ' +
    'Entregue AGORA, em uma única ação: chame a tool nexus_handoff_submit ' +
    '(ou imprima o bloco de conclusão que recebeu no seu brief) com ' +
    'status "success" | "partial" | "blocked" | "failed" e um summary ' +
    'objetivo do que você fez ou do que te impediu. Se estiver travado, ' +
    'entregue mesmo assim com status "blocked" e diga o motivo — um handoff ' +
    'ruim vale mais que silêncio.'
  );
}

function productionDeps(): WorkerHandoffEnforcementDeps {
  return {
    getAuthority: (sessionId) => getPaneRuntimeAuthorityBySession(sessionId),
    listHandoffs: (scope, missionId) =>
      getProjectDomainStores(scope).handoffs.list({
        missionId,
        includeDelivered: true,
      }),
    missionStatus: (scope, missionId) =>
      getProjectDomainStores(scope).missions.get(missionId)?.status ?? null,
    isIdle: (sessionId) => isSessionInjectableIdle(sessionId),
    nudge: (authority, text) => {
      const sessionId = authority.sessionId;
      if (!sessionId) return false;
      // Bracketed paste: o texto inteiro vira UMA transação do editor da TUI,
      // como em `injectPrompt` (tool-util.ts:211).
      if (
        !orchWriteSession(sessionId, `\x1b[200~${text}\x1b[201~`, {
          markInputBusy: false,
        })
      ) {
        return false;
      }
      return orchWriteSession(sessionId, '\r', { markInputBusy: false });
    },
    submitSynthetic: (authority, input) => {
      if (!authority.scope || !authority.missionId) return;
      const handoff = getProjectDomainStores(authority.scope).handoffs.submit({
        status: input.status,
        summary: input.summary,
        missionId: authority.missionId,
        ...(authority.sessionId ? { sessionId: authority.sessionId } : {}),
        ...(authority.workerIncarnationId
          ? { workerIncarnationId: authority.workerIncarnationId }
          : {}),
        fromAgent: 'nexus-handoff-enforcement',
      });
      onHandoffSubmitted(handoff, authority.scope);
    },
    readTail: (sessionId) => readSessionOutput(sessionId, TAIL_LINES),
    quietGraceMs: WORKER_QUIET_GRACE_MS,
    enforceGraceMs: WORKER_ENFORCE_GRACE_MS,
    log: (message) => console.warn(`[handoff-enforcement] ${message}`),
  };
}

/** Handoffs REAIS (autor não sintético) ligados a esta sessão exata. */
function hasRealHandoff(
  deps: WorkerHandoffEnforcementDeps,
  authority: PaneRuntimeAuthority,
): boolean {
  if (!authority.scope || !authority.missionId) return false;
  try {
    return deps
      .listHandoffs(authority.scope, authority.missionId)
      .some(
        (handoff) =>
          handoff.sessionId === authority.sessionId &&
          !(handoff.fromAgent ?? '').startsWith(SYNTHETIC_HANDOFF_AUTHOR_PREFIX),
      );
  } catch {
    // Falha de leitura nunca fabrica cobrança: fail-closed para "já entregou".
    return true;
  }
}

interface EnforcementWatch {
  nudged: boolean;
  enforced: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

const watches = new Map<string, EnforcementWatch>();
let untapStatus: (() => void) | null = null;
let untapExit: (() => void) | null = null;
let activeDeps: WorkerHandoffEnforcementDeps | null = null;

function watchFor(sessionId: string): EnforcementWatch {
  const existing = watches.get(sessionId);
  if (existing) return existing;
  const created: EnforcementWatch = {
    nudged: false,
    enforced: false,
    timer: null,
  };
  watches.set(sessionId, created);
  return created;
}

function clearTimer(watch: EnforcementWatch): void {
  if (watch.timer) clearTimeout(watch.timer);
  watch.timer = null;
}

function armTimer(
  watch: EnforcementWatch,
  delayMs: number,
  run: () => void,
): void {
  clearTimer(watch);
  const timer = setTimeout(() => {
    watch.timer = null;
    run();
  }, delayMs);
  if (typeof timer.unref === 'function') timer.unref();
  watch.timer = timer;
}

/**
 * Re-avalia do zero (autoridade, missão, handoff) e executa a ação devida.
 * `exited` pula a exigência de PTY idle: não há PTY.
 */
function evaluate(
  deps: WorkerHandoffEnforcementDeps,
  sessionId: string,
  exited: boolean,
): void {
  const watch = watchFor(sessionId);
  const authority = deps.getAuthority(sessionId);
  if (
    !authority ||
    authority.sessionId !== sessionId ||
    !authority.missionId ||
    !authority.scope
  ) {
    return;
  }
  const missionRunning =
    deps.missionStatus(authority.scope, authority.missionId) === 'running';
  const action = decideQuietWorker({
    role: authority.role,
    missionRunning,
    hasHandoff: hasRealHandoff(deps, authority),
    nudged: watch.nudged,
    enforced: watch.enforced,
    exited,
  });
  if (action === 'ignore') return;
  if (action === 'nudge') {
    // Nunca escreve dentro de um turno vivo: se voltou a trabalhar, o próprio
    // status não-idle já desarmou; aqui só confirmamos antes de digitar.
    if (!deps.isIdle(sessionId)) return;
    watch.nudged = true;
    if (!deps.nudge(authority, nudgeText())) {
      deps.log(
        `cutucada não pôde ser escrita; cobrando handoff direto ` +
          `(pane=${authority.paneId}, session=${sessionId})`,
      );
      enforce(deps, authority, watch, 'blocked', sessionId);
      return;
    }
    deps.log(
      `worker idle sem handoff — cutucada enviada ` +
        `(pane=${authority.paneId}, session=${sessionId}, ` +
        `mission=${authority.missionId})`,
    );
    armTimer(watch, deps.enforceGraceMs, () =>
      evaluate(deps, sessionId, exited),
    );
    return;
  }
  enforce(deps, authority, watch, exited ? 'failed' : 'blocked', sessionId);
}

function enforce(
  deps: WorkerHandoffEnforcementDeps,
  authority: PaneRuntimeAuthority,
  watch: EnforcementWatch,
  status: 'blocked' | 'failed',
  sessionId: string,
): void {
  watch.enforced = true;
  clearTimer(watch);
  let tail = '';
  try {
    tail = deps.readTail(sessionId).trim();
  } catch {
    tail = '';
  }
  const reason =
    status === 'failed'
      ? 'a sessão do worker terminou sem entregar um handoff'
      : 'o worker ficou ocioso sem entregar um handoff e não respondeu à ' +
        'cobrança final';
  const summary =
    `${WORKER_HANDOFF_REQUIRED_MARKER} Handoff submetido pelo Nexus no lugar ` +
    `do worker "${authority.paneId}": ${reason}. Nenhum resultado foi ` +
    'declarado por ele, então o resultado real é desconhecido — leia o pane ' +
    '(nexus_pane_read) antes de aceitar ou re-despachar a tarefa.' +
    (tail ? `\n\nÚltimo estado observado do pane:\n${tail}` : '');
  try {
    deps.submitSynthetic(authority, { status, summary });
  } catch (error) {
    deps.log(
      `falha ao submeter handoff de cobrança (session=${sessionId}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }
  deps.log(
    `handoff ${status} submetido no lugar do worker ` +
      `(pane=${authority.paneId}, session=${sessionId}, ` +
      `mission=${authority.missionId})`,
  );
}

export function initWorkerHandoffEnforcement(
  deps: WorkerHandoffEnforcementDeps = productionDeps(),
): void {
  if (untapStatus) return;
  activeDeps = deps;
  untapStatus = tapAgentSemanticStatus((entry) => {
    const watch = watchFor(entry.sessionId);
    if (entry.status === 'idle' || entry.status === 'completed') {
      if (watch.enforced || watch.timer) return;
      armTimer(watch, deps.quietGraceMs, () =>
        evaluate(deps, entry.sessionId, false),
      );
      return;
    }
    // Voltou a trabalhar: desarma a escada e re-arma a cutucada para um
    // eventual novo silêncio (mas nunca desfaz uma cobrança já feita).
    clearTimer(watch);
    watch.nudged = false;
  });
  untapExit = tapSessionExit((sessionId) => {
    const watch = watches.get(sessionId);
    if (watch) clearTimer(watch);
    evaluate(deps, sessionId, true);
    watches.delete(sessionId);
  });
}

export function shutdownWorkerHandoffEnforcement(): void {
  untapStatus?.();
  untapStatus = null;
  untapExit?.();
  untapExit = null;
  for (const watch of watches.values()) clearTimer(watch);
  watches.clear();
  activeDeps = null;
}

/** Somente para diagnóstico/testes de fiação. */
export function isWorkerHandoffEnforcementActive(): boolean {
  return activeDeps !== null;
}
