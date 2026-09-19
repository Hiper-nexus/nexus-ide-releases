/**
 * Garantia de handoff do worker (paridade Bridge — Stop-hook / H3).
 *
 * Um worker NÃO consegue encerrar sua sessão sem submeter um
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
 * ## Doutrina H3 — DEGRADAR, nunca congelar
 *
 * Ordem de escrita deliberada (sobrevive kill no meio e corrida
 * "consume antes do poll"):
 *   1. **transcript / evidência** — tail do pane no summary sintético;
 *   2. **inbox durável** — `handoffs.submit` (SQLite outbox) ANTES de
 *      confiar em notificação in-memory;
 *   3. **nudge** — cutucada no PTY (melhor esforço; se falha, não para).
 *
 * Se o notify/cutucada falha, o sistema diz: *"swarm monitor will fall
 * back to inactivity detection"* — DEGRADA. Equivalente aqui:
 *   - cutucada não escreve → enforce sintético na hora (sem esperar grace);
 *   - submit sintético falha → **não** marca `enforced` (senão a missão
 *     congela para sempre); re-arma o timer de inatividade e tenta de novo.
 *
 * Congelar (merge abandonado 22 min sem watchdog; PREVC que nunca congela
 * com fence eterno) é o anti-padrão que este módulo e o merge-stall-watchdog
 * existem para matar.
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
import {
  getLastSessionInputOrigin,
  getSessionState,
  orchWriteSession,
  tapSessionExit,
  type SessionInputOrigin,
} from '../pty/pty-manager';
import {
  getPaneRuntimeAuthorityBySession,
  readSessionOutput,
  stripAnsi,
  type PaneRuntimeAuthority,
} from './pane-registry';
import { getProjectDomainStores } from './project-domain-store-registry';
import { isSessionInjectableIdle, tapAgentSemanticStatus } from './agent-status';
import {
  HANDOFF_ENTER_RETRY_MS,
  HANDOFF_PROMPT_SETTLE_MS,
  onHandoffSubmitted,
} from './idle-delivery';
import { promoteObservedPtyHandoffs } from './pty-stream-handoff';

/** Carência para o worker submeter sozinho depois de ficar idle. */
export const WORKER_QUIET_GRACE_MS = 20_000;
/** Carência após a cutucada antes do Nexus submeter no lugar dele. */
export const WORKER_ENFORCE_GRACE_MS = 45_000;
/** Linhas de tail anexadas ao handoff sintético como "último estado". */
const TAIL_LINES = 40;
const SYNTHETIC_SUMMARY_MAX_CHARS = 4_096;

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
  /** Handoff REAL (não sintético) ligado a esta sessão exata. */
  readonly hasHandoff: boolean;
  readonly nudged: boolean;
  readonly enforced: boolean;
  readonly exited: boolean;
}

/**
 * Decisão pura (unit-testável) da escada de cobrança.
 *
 * O estado da MISSÃO deliberadamente não entra aqui. Um gate de
 * `mission.status === 'running'` reabriria exatamente o buraco que este módulo
 * existe para fechar: a missão que se auto-encerra ENQUANTO um worker ainda
 * codifica é o caso originador do hotfix — se o encerramento silenciasse a
 * cobrança, o relatório daquele worker se perderia justamente quando é mais
 * necessário (por que a missão morreu?). o resultado permanece
 * coletável depois do fato; aqui a submissão é durável e o `handoff_list`
 * continua servindo mesmo sem orquestrador vivo.
 */
export function decideQuietWorker(state: QuietWorkerState): QuietWorkerAction {
  if (state.role !== 'worker') return 'ignore';
  if (state.enforced) return 'ignore';
  if (state.hasHandoff) return 'ignore';
  // Processo morto não tem como ser cutucado — cobra direto.
  if (state.exited) return 'enforce';
  return state.nudged ? 'enforce' : 'nudge';
}

export interface SyntheticHandoffInput {
  readonly status: 'blocked' | 'failed';
  readonly summary: string;
  readonly fullText?: string;
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
  /**
   * Overclock Stop-hook parity: promote a NEXUS_HANDOFF block already on
   * screen before nudging or synthesizing a blocked handoff. Return true
   * when at least one real handoff was persisted.
   */
  readonly promoteObserved?: (
    sessionId: string,
    tail: string,
  ) => boolean | Promise<boolean>;
  readonly lastInputOrigin: (
    sessionId: string,
  ) => SessionInputOrigin | undefined;
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
      // como em `injectPrompt` (tool-util.ts:211). Enter só depois do settle
      // — o mesmo CR imediato do idle-delivery era engolido pelo compositor.
      if (
        !orchWriteSession(sessionId, `\x1b[200~${text}\x1b[201~`, {
          markInputBusy: false,
        })
      ) {
        return false;
      }
      scheduleNudgedEnter(sessionId);
      return true;
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
    promoteObserved: async (sessionId, tail) => {
      const promoted = await promoteObservedPtyHandoffs(
        sessionId,
        stripAnsi(tail),
      );
      return promoted > 0;
    },
    lastInputOrigin: (sessionId) => getLastSessionInputOrigin(sessionId),
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
  } catch (error) {
    // H3 fail-open on read: "eco a mais é ruído; resultado perdido é o bug".
    // Assume missing so the inactivity ladder still runs (synthetic may
    // still land when the store recovers). Idempotency lives on submit.
    deps.log(
      `listHandoffs falhou — assumindo sem handoff real (session=${authority.sessionId}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

interface EnforcementWatch {
  nudged: boolean;
  enforced: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

const watches = new Map<string, EnforcementWatch>();
const nudgeSubmitTimers = new Map<string, Set<ReturnType<typeof setTimeout>>>();
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

function clearNudgeSubmitTimers(sessionId?: string): void {
  if (sessionId) {
    const timers = nudgeSubmitTimers.get(sessionId);
    if (timers) {
      for (const timer of timers) clearTimeout(timer);
      nudgeSubmitTimers.delete(sessionId);
    }
  } else {
    for (const [, timers] of nudgeSubmitTimers) {
      for (const timer of timers) clearTimeout(timer);
    }
    nudgeSubmitTimers.clear();
  }
}

function scheduleNudgedEnter(sessionId: string): void {
  clearNudgeSubmitTimers(sessionId);
  const timers = new Set<ReturnType<typeof setTimeout>>();
  nudgeSubmitTimers.set(sessionId, timers);

  const delays = [HANDOFF_PROMPT_SETTLE_MS, HANDOFF_ENTER_RETRY_MS, 600, 1200, 2000];
  let idx = 0;

  function scheduleNext(): void {
    if (idx >= delays.length) {
      nudgeSubmitTimers.delete(sessionId);
      return;
    }
    const currentDelay = delays[idx++];
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!isSessionInjectableIdle(sessionId) || getSessionState(sessionId) === 'busy') {
        clearNudgeSubmitTimers(sessionId);
        return;
      }
      const enterKey = idx >= 3 ? '\r\n' : '\r';
      orchWriteSession(sessionId, enterKey, { markInputBusy: false });
      scheduleNext();
    }, currentDelay);
    if (typeof timer.unref === 'function') timer.unref();
    timers.add(timer);
  }

  scheduleNext();
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

function truncateStart(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(text.length - maxChars);
}

function syntheticSummary(
  authority: PaneRuntimeAuthority,
  reason: string,
  missionNote: string,
  tail: string,
): string {
  const prefix =
    `${WORKER_HANDOFF_REQUIRED_MARKER} Fechamento mecânico pelo Nexus no ` +
    `lugar do worker "${authority.paneId}": ${reason}.${missionNote}`;
  if (!tail) return truncateStart(prefix, SYNTHETIC_SUMMARY_MAX_CHARS);
  const header = `${prefix}\n\nÚltimo estado real observado do pane:\n`;
  const boundedTail = truncateStart(
    tail,
    Math.max(0, SYNTHETIC_SUMMARY_MAX_CHARS - header.length),
  );
  return `${header}${boundedTail}`.slice(0, SYNTHETIC_SUMMARY_MAX_CHARS);
}

function readTailSafe(
  deps: WorkerHandoffEnforcementDeps,
  sessionId: string,
): string {
  try {
    return deps.readTail(sessionId);
  } catch {
    return '';
  }
}

function isPromotePromise(
  value: boolean | Promise<boolean>,
): value is Promise<boolean> {
  return typeof value === 'object' && value !== null && 'then' in value;
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
  const action = decideQuietWorker({
    role: authority.role,
    hasHandoff: hasRealHandoff(deps, authority),
    nudged: watch.nudged,
    enforced: watch.enforced,
    exited,
  });
  if (action === 'ignore') return;

  const finish = (): void =>
    continueQuietAction(deps, sessionId, exited, watch, authority, action);

  if (!deps.promoteObserved) {
    finish();
    return;
  }
  let result: boolean | Promise<boolean>;
  try {
    result = deps.promoteObserved(sessionId, readTailSafe(deps, sessionId));
  } catch (error) {
    deps.log(
      `promoteObserved falhou (session=${sessionId}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    finish();
    return;
  }
  if (isPromotePromise(result)) {
    void result
      .then((promoted) => {
        if (promoted) {
          deps.log(
            `bloco NEXUS_HANDOFF observado no PTY promovido ` +
              `(session=${sessionId}, pane=${authority.paneId})`,
          );
          return;
        }
        finish();
      })
      .catch((error) => {
        deps.log(
          `promoteObserved falhou (session=${sessionId}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        finish();
      });
    return;
  }
  if (result) {
    deps.log(
      `bloco NEXUS_HANDOFF observado no PTY promovido ` +
        `(session=${sessionId}, pane=${authority.paneId})`,
    );
    return;
  }
  finish();
}

function continueQuietAction(
  deps: WorkerHandoffEnforcementDeps,
  sessionId: string,
  exited: boolean,
  watch: EnforcementWatch,
  authority: PaneRuntimeAuthority,
  action: Exclude<QuietWorkerAction, 'ignore'>,
): void {
  if ((deps.lastInputOrigin(sessionId) ?? 'system') === 'human') {
    armTimer(watch, deps.enforceGraceMs, () =>
      evaluate(deps, sessionId, exited),
    );
    deps.log(
      `fechamento sintético adiado: última entrada foi humana ` +
        `(pane=${authority.paneId}, session=${sessionId})`,
    );
    return;
  }
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
  // Do NOT mark enforced until inbox write succeeds. Marking first was the
  // freeze: submit fails → enforced=true → decideQuietWorker always ignore →
  // mission waits forever with zero handoff (H3 anti-pattern).
  clearTimer(watch);
  let tail = '';
  try {
    tail = stripAnsi(deps.readTail(sessionId)).trim();
  } catch {
    tail = '';
  }
  const reason =
    status === 'failed'
      ? 'a sessão do worker terminou sem entregar um handoff'
      : 'o worker ficou ocioso sem entregar um handoff e não respondeu à ' +
        'cobrança final';
  // Missão já fora de 'running' é DIAGNÓSTICO, nunca motivo para silenciar:
  // worker mudo numa missão que se encerrou é justamente a pista de por que
  // ela se encerrou.
  let missionState: string | null = null;
  try {
    missionState =
      authority.scope && authority.missionId
        ? deps.missionStatus(authority.scope, authority.missionId)
        : null;
  } catch {
    missionState = null;
  }
  const missionNote =
    missionState && missionState !== 'running'
      ? ` A missão já estava em "${missionState}" quando isso foi detectado — ` +
        'este relatório é a evidência do que o worker estava fazendo no ' +
        'encerramento.'
      : '';
  const summary = syntheticSummary(authority, reason, missionNote, tail);
  try {
    deps.submitSynthetic(authority, { status, summary, fullText: summary });
  } catch (error) {
    deps.log(
      `falha ao submeter handoff de cobrança (session=${sessionId}): ${
        error instanceof Error ? error.message : String(error)
      } — rearmando detecção de inatividade (H3 degrade)`,
    );
    // Inactivity fallback: store may recover; do not freeze the ladder.
    // Session already exited has no PTY — still re-arm once so a transient
    // store blip can land the synthetic before the watch is dropped on exit.
    armTimer(watch, deps.enforceGraceMs, () =>
      evaluate(deps, sessionId, status === 'failed'),
    );
    return;
  }
  watch.enforced = true;
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
    clearNudgeSubmitTimers(entry.sessionId);
  });
  untapExit = tapSessionExit((sessionId) => {
    const watch = watches.get(sessionId);
    if (watch) clearTimer(watch);
    clearNudgeSubmitTimers(sessionId);
    evaluate(deps, sessionId, true);
    // H3: only drop the watch after durable inbox write (enforced). If
    // submit failed, the re-armed inactivity timer still owns this entry.
    const after = watches.get(sessionId);
    if (after?.enforced || !after?.timer) {
      if (after) clearTimer(after);
      watches.delete(sessionId);
    }
  });
}

export function shutdownWorkerHandoffEnforcement(): void {
  untapStatus?.();
  untapStatus = null;
  untapExit?.();
  untapExit = null;
  clearNudgeSubmitTimers();
  for (const watch of watches.values()) clearTimer(watch);
  watches.clear();
  activeDeps = null;
}

/** Somente para diagnóstico/testes de fiação. */
export function isWorkerHandoffEnforcementActive(): boolean {
  return activeDeps !== null;
}
