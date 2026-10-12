/**
 * Fechamento de panes por ESCOPO explícito + autoCloseOnHandoff (paridade
 * coordenação, gap e). Doutrina: o chamador NOMEIA o que fecha — nada implícito;
 * o desligamento automático é declarado no nascimento do pane (registro, não
 * pergunta). success fecha logo após o submit. partial/failed/blocked de
 * worker de missão (F-1409) fecham no ACK aceito do Maestro ou na rede de
 * segurança (15 min parado depois que a entrega chegou ao Maestro); rework e
 * pane sem braço (operador, autoCloseOnHandoff:false) ficam abertos.
*/
import { sanitizePaneBootOutput } from './pane-boot-output';

export interface ScopedCloseCandidate {
  readonly paneId: string;
  readonly sessionId?: string;
  readonly missionId?: string;
  readonly role?: "orchestrator" | "worker";
  /** F-231: mão do operador dentro da missão — o scope-close nunca a inclui. */
  readonly operatorOpened?: boolean;
  readonly scopeRoot?: string;
}

export interface ScopedCloseSelection {
  readonly close: readonly string[];
  readonly skipped: readonly { paneId: string; reason: string }[];
}

export function selectScopedPaneCloseTargets(input: {
  readonly scope: "caller_mission" | "caller_workspace";
  readonly callerSessionId?: string;
  readonly callerMissionId?: string;
  readonly callerScopeRoot: string;
  readonly panes: readonly ScopedCloseCandidate[];
  readonly isMissionRunning: (missionId: string) => boolean;
}): ScopedCloseSelection {
  const close: string[] = [];
  const skipped: { paneId: string; reason: string }[] = [];
  for (const pane of input.panes) {
    const inScope =
      input.scope === "caller_mission"
        ? Boolean(input.callerMissionId) &&
          pane.missionId === input.callerMissionId
        : pane.scopeRoot === input.callerScopeRoot;
    if (!inScope) continue;
    if (pane.sessionId && pane.sessionId === input.callerSessionId) {
      skipped.push({ paneId: pane.paneId, reason: "caller" });
      continue;
    }
    if (pane.role === "orchestrator") {
      skipped.push({ paneId: pane.paneId, reason: "orchestrator" });
      continue;
    }
    // F-231: "só ele fecha" — o scope-close do Maestro pula panes do operador.
    if (pane.operatorOpened === true) {
      skipped.push({ paneId: pane.paneId, reason: "operator-opened" });
      continue;
    }
    // Worker de OUTRA missão em execução: a autoridade é do scheduler dela —
    // só o escopo da PRÓPRIA missão do chamador pode derrubar workers vivos.
    if (
      input.scope === "caller_workspace" &&
      pane.missionId &&
      pane.missionId !== input.callerMissionId &&
      input.isMissionRunning(pane.missionId)
    ) {
      skipped.push({ paneId: pane.paneId, reason: "mission-running" });
      continue;
    }
    close.push(pane.paneId);
  }
  return Object.freeze({
    close: Object.freeze(close),
    skipped: Object.freeze(skipped),
  });
}

export function shouldAutoCloseAfterHandoff(input: {
  readonly armed: boolean;
  readonly status: string;
}): boolean {
  return input.armed && input.status === "success";
}

/**
 * Motor (06/10): quem nasce com o braço de auto-close armado.
 * - helper da mão do operador SEM missão (C3, 25/09);
 * - worker de missão que NÃO é a mão do operador dentro dela (F-231).
 * Nunca: orquestrador, nem `operatorOpened` (a mão do operador na missão).
 * `autoCloseOnHandoff: false` explícito vence sempre; `true` força para
 * qualquer um (inclusive os que não entrariam pelo default).
 */
export function shouldArmAutoCloseOnHandoff(input: {
  readonly explicit: boolean | undefined;
  readonly operatorHand: boolean;
  readonly missionId: string | undefined;
  readonly role: string | undefined;
  readonly operatorOpened: boolean | undefined;
}): boolean {
  if (input.explicit === true) return true;
  if (input.explicit === false) return false;
  if (input.operatorHand && input.missionId === undefined) return true;
  return (
    input.missionId !== undefined &&
    input.role === "worker" &&
    input.operatorOpened !== true
  );
}

/** A short notification alone must not destroy the pane's only complete report. */
export function assertAutoCloseReportPreserved(
  sessionId: string | undefined,
  paneId: string | null,
  status: unknown,
  args: { fullText?: unknown; summary?: unknown; artifacts?: unknown },
  readTerminalTail?: () => string,
): string | null {
  if (!sessionId || status !== 'success' || !armedAutoClosePaneId(sessionId, paneId)) return null;
  // Native system-delivery contract uses artifacts[].fullText; MCP also
  // accepts a top-level fullText. Both already persist verbatim in the ledger.
  const fullTextArtifact = Array.isArray(args.artifacts) ? args.artifacts.slice(0, 4096)
    .find(artifact => artifact && typeof artifact === 'object' &&
      (typeof artifact.fullText === 'string' || artifact.kind === 'overclock.fullText' && typeof artifact.payload === 'string')) : null;
  const report: string | null = typeof args.fullText === 'string' ? args.fullText : fullTextArtifact
    ? typeof fullTextArtifact.fullText === 'string' ? fullTextArtifact.fullText : fullTextArtifact.payload
    : typeof args.summary === 'string' && args.summary.trim().length > 400 ? args.summary.trim() : null;
  const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
  // F-833/N4: naming the notification fullText does not preserve the report.
  // Capture only Main-owned output, never an agent-authored terminal artifact.
  const repeatedSummary = Boolean((typeof args.fullText === 'string' || fullTextArtifact) && report && summary && report.length <= 60_000 &&
    report.trim().length <= summary.length);
  if (!report?.trim() || repeatedSummary) {
    const tail = sanitizePaneBootOutput(readTerminalTail?.() ?? '');
    // Redactors can emit several placeholders on one line. Only remaining
    // contextual text counts as recovery, not their separators or brackets.
    const useful = /[\p{L}\p{N}]/u.test(tail.replace(
      /\[(?:sem saída capturada|\.\.\.[^\[\]\r\n]*|[^\[\]\r\n]*redigid[oa]s?|REDACTED(?:_[A-Z0-9]+)*)\]/giu, ''));
    if (useful && tail !== summary) return tail;
  }
  if (!report?.trim() || report.length > 60_000 || repeatedSummary) {
    throw new Error('handoff_report_required: este pane fecha após a entrega. Envie o relatório completo em fullText (até 60000 caracteres), além do summary. O pane foi preservado; nenhum sucesso foi registrado.');
  }
  return null;
}

type PaneIdOf = (sessionId: string) => string | null;
type ClosePane = (paneId: string, expectedSessionId: string) => Promise<unknown>;

function closeArmedPaneSoon(
  sessionId: string,
  armedPaneId: string,
  paneIdOf: PaneIdOf,
  close: ClosePane,
): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    if (scheduledNonSuccessCloseBySession.get(sessionId)?.paneId === armedPaneId) {
      scheduledNonSuccessCloseBySession.delete(sessionId);
    }
    if (paneIdOf(sessionId) !== armedPaneId) return;
    void Promise.resolve().then(() => close(armedPaneId, sessionId)).catch((error) =>
      console.warn(`[handoff] auto-close do pane ${armedPaneId} falhou:`, error),
    );
  }, 0);
}

/**
 * F-1409: rede de segurança da entrega não-success de worker de missão armado.
 * Sem ACK do Maestro nesse prazo e com o worker parado, o pane fecha (a
 * entrega e o scrollback relevante vivem no ledger). Worker ocupado adia.
 */
export const NON_SUCCESS_IDLE_CLOSE_MS = 15 * 60_000;

/**
 * F-1409/M3: enquanto a entrega está `queued` (Maestro em turno longo), o
 * prazo não corre — o Maestro ainda não leu e pode pedir rework. Verifica a
 * chegada a cada minuto; o prazo começa na primeira verificação entregue.
 */
export const NON_SUCCESS_DELIVERY_POLL_MS = 60_000;

interface PendingNonSuccessClose {
  readonly paneId: string;
  readonly handoffId: string;
  readonly paneIdOf: PaneIdOf;
  readonly close: ClosePane;
  timer?: ReturnType<typeof setTimeout>;
}

/** Entrega partial/failed/blocked de worker armado aguardando o Maestro, por sessão. */
const pendingNonSuccessBySession = new Map<string, PendingNonSuccessClose>();

/**
 * Grok #1: entre desarmar e o setTimeout(0) do fechamento, um ACK rework
 * ainda precisa vencer — o close agendado fica aqui até disparar.
 */
const scheduledNonSuccessCloseBySession = new Map<
  string,
  { readonly paneId: string; readonly timer: ReturnType<typeof setTimeout> }
>();

function clearPendingNonSuccess(sessionId: string): void {
  const pending = pendingNonSuccessBySession.get(sessionId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingNonSuccessBySession.delete(sessionId);
}

function closePendingNonSuccess(sessionId: string, pending: PendingNonSuccessClose): void {
  clearPendingNonSuccess(sessionId);
  if (armedAutoClosePaneId(sessionId, pending.paneId) !== pending.paneId) return;
  disarmAutoCloseOnHandoff(sessionId, pending.paneId);
  const timer = closeArmedPaneSoon(sessionId, pending.paneId, pending.paneIdOf, pending.close);
  scheduledNonSuccessCloseBySession.set(sessionId, { paneId: pending.paneId, timer });
}

/** Estados em que o worker ainda trabalha — a rede de segurança espera. */
export function isWorkerSessionBusy(state: string | null): boolean {
  return state === "busy" || state === "spawning";
}

export interface NonSuccessCloseOptions {
  /** Handoff que o ACK do Maestro precisa citar para fechar o pane. */
  readonly handoffId: string;
  /** Worker trabalhando (ex.: depois de rework por PTY) adia a rede de segurança. */
  readonly isBusy?: (sessionId: string) => boolean;
  /**
   * Grok #2: contador de saída do worker (one-shot fica "busy" enquanto o
   * processo vive). null = sem sinal. Saída nova na janela adia o fechamento.
   */
  readonly activityMark?: (sessionId: string) => number | null;
  /** A entrega já chegou ao Maestro (deliveryState ≠ queued)? Ausente = desde o submit. */
  readonly isDelivered?: (handoffId: string) => boolean;
  readonly idleCloseMs?: number;
}

/**
 * Consome o braço apenas depois de um handoff persistido; fechar fica fora da resposta.
 * success fecha já. Com `nonSuccess` (worker de missão), partial/failed/blocked
 * ficam abertos até o ACK do Maestro ou a rede de segurança (F-1409).
 */
export function scheduleAutoCloseAfterHandoff(
  sessionId: string | undefined,
  status: string,
  paneIdOf: PaneIdOf,
  close: ClosePane,
  nonSuccess?: NonSuccessCloseOptions,
): void {
  if (!sessionId) return;
  const paneId = paneIdOf(sessionId);
  const armedPaneId = armedAutoClosePaneId(sessionId, paneId);
  if (armedPaneId === null) return;
  if (!shouldAutoCloseAfterHandoff({ armed: true, status })) {
    if (nonSuccess) {
      clearPendingNonSuccess(sessionId);
      const idleMs = nonSuccess.idleCloseMs ?? NON_SUCCESS_IDLE_CLOSE_MS;
      const handoffId = nonSuccess.handoffId;
      const markOf = (): number | null => {
        try {
          return nonSuccess.activityMark?.(sessionId) ?? null;
        } catch {
          return null;
        }
      };
      let windowMark: number | null = null;
      const startIdleWindow = (): void => {
        windowMark = markOf();
        pending.timer = setTimeout(onIdle, idleMs);
      };
      const onIdle = (): void => {
        if (pendingNonSuccessBySession.get(sessionId) !== pending) return;
        const mark = markOf();
        const producedOutput = mark !== null && windowMark !== null && mark !== windowMark;
        if (producedOutput || nonSuccess.isBusy?.(sessionId)) {
          startIdleWindow();
          return;
        }
        closePendingNonSuccess(sessionId, pending);
      };
      // O prazo só começa quando a entrega sai de `queued` (M3).
      const awaitDelivery = (): void => {
        if (pendingNonSuccessBySession.get(sessionId) !== pending) return;
        let delivered = true;
        try {
          delivered = nonSuccess.isDelivered?.(handoffId) ?? true;
        } catch {
          // Ledger indisponível agora: não fecha; tenta de novo na próxima volta.
          delivered = false;
        }
        if (!delivered) {
          pending.timer = setTimeout(awaitDelivery, Math.min(NON_SUCCESS_DELIVERY_POLL_MS, idleMs));
          return;
        }
        startIdleWindow();
      };
      const pending: PendingNonSuccessClose = {
        paneId: armedPaneId, handoffId, paneIdOf, close,
      };
      pendingNonSuccessBySession.set(sessionId, pending);
      awaitDelivery();
    }
    return;
  }
  clearPendingNonSuccess(sessionId);
  disarmAutoCloseOnHandoff(sessionId, paneId);
  closeArmedPaneSoon(sessionId, armedPaneId, paneIdOf, close);
}

/**
 * F-1409: o Maestro consumiu (ACK) a entrega não-success. `accepted` fecha o
 * worker armado; `rework` mantém o pane vivo para receber a nota (o braço
 * segue armado para a próxima entrega).
 */
export function closeAfterNonSuccessHandoffAck(
  sessionId: string | undefined,
  handoffId: string,
  verdict: string,
): boolean {
  if (!sessionId) return false;
  if (verdict === "rework") {
    // O writer volta a trabalhar: cancela a rede de segurança e, se o timer
    // já desarmou e agendou o close (setTimeout 0), cancela o close e rearma.
    clearPendingNonSuccess(sessionId);
    const scheduled = scheduledNonSuccessCloseBySession.get(sessionId);
    if (scheduled) {
      clearTimeout(scheduled.timer);
      scheduledNonSuccessCloseBySession.delete(sessionId);
      armAutoCloseOnHandoff(sessionId, scheduled.paneId);
    }
    return false;
  }
  const pending = pendingNonSuccessBySession.get(sessionId);
  if (!pending || pending.handoffId !== handoffId) return false;
  closePendingNonSuccess(sessionId, pending);
  return true;
}

/**
 * Braços de autoCloseOnHandoff por sessão física. Registro em memória: o
 * braço morre com o processo — um pane sobrevivente de crash nunca fecha
 * sozinho por um braço fantasma.
 */
const armedBySession = new Map<string, string>();

export function armAutoCloseOnHandoff(
  sessionId: string,
  paneId: string,
): void {
  armedBySession.set(sessionId, paneId);
}

/**
 * Braço por PANE para o spawn com ACK pendente: a mão do operador recebe o
 * paneId antes de a sessão existir, então não há sessão para armar ainda. O
 * handoff da sessão que nascer nesse pane encontra o braço pelo pane.
 */
const armedByPane = new Set<string>();

export function armAutoCloseOnHandoffForPane(paneId: string): void {
  armedByPane.add(paneId);
}

export function disarmAutoCloseOnHandoff(
  sessionId: string,
  paneId?: string | null,
): void {
  armedBySession.delete(sessionId);
  if (paneId) armedByPane.delete(paneId);
  clearPendingNonSuccess(sessionId);
}

export function armedAutoClosePaneId(
  sessionId: string,
  paneId?: string | null,
): string | null {
  const bySession = armedBySession.get(sessionId);
  if (bySession) return bySession;
  return paneId && armedByPane.has(paneId) ? paneId : null;
}
