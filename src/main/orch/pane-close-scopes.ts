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
 * F-1634: prazo do aceite de uma entrega `success`. Curto de propósito — o
 * ACK do Maestro chega em um turno dele, e um pane de agente custa ~1 GB
 * (F-572): esperar os 15 min da rede não-success encheria a máquina.
 */
export const SUCCESS_ACK_IDLE_CLOSE_MS = 3 * 60_000;
/**
 * F-1634: teto da espera pela ENTREGA do `success` que aguarda aceite.
 *
 * O prazo do aceite só começa quando a entrega sai de `queued` (M3). Numa
 * entrega presa — Maestro morto, outbox parado — isso deixaria o pane vivo
 * sem prazo nenhum, e `success` é o caso comum (antes fechava na hora).
 * Estourado o teto, a janela de ociosidade corre mesmo sem entrega
 * confirmada: sem Maestro para acusar, não há contexto a preservar.
 */
export const SUCCESS_ACK_DELIVERY_CEILING_MS = 10 * 60_000;

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
  {
    readonly paneId: string;
    /**
     * F-1634 (2ª rodada do Codex no PR 159): de QUAL handoff é este close.
     * Sem o id, um rework de rodada antiga cancelava o close já agendado da
     * rodada nova e só rearmava o pane — sem pendente e sem timer, ele ficava
     * aberto sem prazo nenhum.
     */
    readonly handoffId: string;
    readonly timer: ReturnType<typeof setTimeout>;
  }
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
  scheduledNonSuccessCloseBySession.set(sessionId, {
    paneId: pending.paneId,
    handoffId: pending.handoffId,
    timer,
  });
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
  /**
   * F-1634: quem vai CONSUMIR a entrega está ocupado agora?
   *
   * A doutrina manda o Maestro rodar ele mesmo o teste que prova a correção
   * antes de aceitar (regra do operador de 02/10), e uma suíte real passa dos
   * três minutos da janela de aceite. Sem isto, a rede fechava o pane do
   * worker enquanto o Maestro estava legitimamente verificando, e um `rework`
   * depois perdia a conversa morna — o laço que a espera existe para evitar.
   * A janela só corre quando worker E consumidor estão parados.
   */
  readonly isDeliveryConsumerBusy?: () => boolean;
  readonly idleCloseMs?: number;
  /**
   * F-1634: a entrega `success` deste worker ainda passa pelo veredito do
   * Maestro (`nexus_handoff_ack`). Fechar o pane no submit apagava o contexto
   * antes do veredito: um `rework` depois caía numa encarnação nova — resume
   * indisponível volta ao brief original — e o worker refazia o trabalho do
   * zero. Com o aceite pendente, `accepted` fecha na hora, `rework` encontra
   * o pane morno e a rede de segurança fecha quem nunca é acusado.
   *
   * Só para worker de missão: handoff sem missão não tem ACK, então ali o
   * `success` continua fechando já.
   */
  readonly awaitAckOnSuccess?: boolean;
}

/**
 * Consome o braço apenas depois de um handoff persistido; fechar fica fora da resposta.
 * success fecha já. Com `nonSuccess` (worker de missão), partial/failed/blocked
 * ficam abertos até o ACK do Maestro ou a rede de segurança (F-1409).
 */
/**
 * F-1634: esta entrega `success` fica aberta esperando o veredito do Maestro?
 *
 * Quem pode receber rework é quem ESCREVE, e o rótulo não basta para saber
 * isso. `readOnly` é consultivo fora do Hardened (F-1157), e `isolatedWriter`
 * explícito VENCE esse rótulo (F-1318): o "leitor" que pediu worktree é writer
 * e nasce `isolated_worktree`. Lendo só o rótulo, o writer isolado ficava fora
 * da espera e o rework dele voltava a cair em resume/pane novo — justamente o
 * que esta mudança existe para evitar (revisão do Codex no PR 159).
 *
 * Fica fora: a lane que o Hardened confina (nunca escreve por caminho
 * nenhum), o revisor somente leitura (entrega consumida pelo motor da
 * conclusão, e não existe rework de leitura) e qualquer entrega sem missão,
 * que não tem ACK.
 */
export function missionWriterAwaitsHandoffAck(input: {
  readonly missionId?: string;
  readonly role?: string;
  readonly readOnly?: boolean;
  readonly readOnlyEnforced?: boolean;
  readonly isolatedWriter?: boolean;
  /**
   * F-1634 (revisão do Codex no PR 159): o flag `isolatedWriter` só é copiado
   * para o contexto do FILHO DO OPERADOR (`mcp-server.ts`, `operatorChild &&
   * meta?.isolatedWriter`); num worker de missão ele é sempre undefined, e ler
   * só o flag deixava a regra do F-1318 sem efeito justamente ali. Estes dois
   * são o sinal FÍSICO, medido pelo Main: writer isolado é o que roda numa
   * worktree própria, diferente do checkout de coordenação.
   */
  readonly scopeRoot?: string;
  readonly executionRoot?: string;
} | null | undefined): boolean {
  // F-1634: o fallback de disco do handoff MCP é ingerido NO BOOT, depois de
  // queda do Main (F-795), quando a sessão do worker já morreu e não há
  // contexto de gate. Sem contexto não há conversa morna a preservar: devolve
  // false e aquele caminho mantém o fechamento imediato de sempre.
  if (!input) return false;
  if (input.missionId === undefined || input.role !== "worker") return false;
  if (input.readOnlyEnforced === true) return false;
  if (input.isolatedWriter === true) return true;
  if (
    input.executionRoot !== undefined &&
    input.scopeRoot !== undefined &&
    input.executionRoot !== input.scopeRoot
  ) {
    return true;
  }
  return input.readOnly !== true;
}

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
  // F-1634: `success` de worker de missão espera o aceite do Maestro pelo
  // MESMO caminho diferido do não-success — só o prazo da rede é mais curto.
  const awaitAck =
    status === "success" && nonSuccess?.awaitAckOnSuccess === true;
  if (awaitAck || !shouldAutoCloseAfterHandoff({ armed: true, status })) {
    // A rede de segurança só arma para entrega terminal não-success
    // (partial|failed|blocked) ou para o `success` que aguarda aceite:
    // `progress`/`stalled` são sintéticos e o worker ainda trabalha — não há
    // entrega para o Maestro consumir, então armar aqui fecharia o pane
    // parado antes de ele entregar.
    if (!awaitAck && status !== "partial" && status !== "failed" && status !== "blocked") return;
    if (nonSuccess) {
      clearPendingNonSuccess(sessionId);
      const idleMs =
        nonSuccess.idleCloseMs ??
        (awaitAck ? SUCCESS_ACK_IDLE_CLOSE_MS : NON_SUCCESS_IDLE_CLOSE_MS);
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
        let consumerBusy = false;
        try {
          consumerBusy = nonSuccess.isDeliveryConsumerBusy?.() === true;
        } catch {
          // Sonda indisponível não autoriza fechar o pane no meio de uma
          // verificação: trata como ocupado e tenta de novo na próxima volta.
          consumerBusy = true;
        }
        if (producedOutput || consumerBusy || nonSuccess.isBusy?.(sessionId)) {
          startIdleWindow();
          return;
        }
        closePendingNonSuccess(sessionId, pending);
      };
      // O prazo só começa quando a entrega sai de `queued` (M3).
      // F-1634: com aceite pendente a espera tem teto — ver
      // SUCCESS_ACK_DELIVERY_CEILING_MS.
      const deliveryDeadline = awaitAck
        ? Date.now() + SUCCESS_ACK_DELIVERY_CEILING_MS
        : null;
      const awaitDelivery = (): void => {
        if (pendingNonSuccessBySession.get(sessionId) !== pending) return;
        let delivered = true;
        try {
          delivered = nonSuccess.isDelivered?.(handoffId) ?? true;
        } catch {
          // Ledger indisponível agora: não fecha; tenta de novo na próxima volta.
          delivered = false;
        }
        if (!delivered && deliveryDeadline !== null && Date.now() >= deliveryDeadline) {
          startIdleWindow();
          return;
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
 * F-1634: a entrega do `[NEXUS_REWORK]` falhou — devolve a rede de segurança.
 *
 * O ACK de `rework` cancela a rede ANTES de a nota ser entregue, porque o
 * worker normalmente volta a trabalhar. Quando a entrega falha (sem nota,
 * `injectPrompt` recusado, conversa não retomável), o worker fica ARMADO e sem
 * prazo nenhum — e worker de missão é excluído da limpeza do guardião, então o
 * pane de ~1 GB ficava aberto até a missão encerrar. Antes isto só alcançava
 * partial/failed/blocked; o `success` do writer trouxe o caminho para o uso
 * comum, então o conserto é obrigatório aqui.
 *
 * Idempotente: reagenda a mesma espera, e um pane que já fechou não reabre.
 */
export function restoreHandoffWaitAfterFailedRework(
  sessionId: string | undefined,
  handoffId: string,
  paneIdOf: PaneIdOf,
  close: ClosePane,
  nonSuccess: NonSuccessCloseOptions,
): void {
  if (!sessionId || pendingNonSuccessBySession.has(sessionId)) return;
  scheduleAutoCloseAfterHandoff(sessionId, 'success', paneIdOf, close, {
    ...nonSuccess,
    handoffId,
    awaitAckOnSuccess: true,
  });
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
    //
    // F-1634 (revisão do Codex no PR 159): a rede cancelada é a DESTE handoff.
    // Um worker pode ter duas rodadas entregues e não consumidas (payload novo
    // depois de uma entrega já entregue abre rodada nova, F-239); limpar a
    // espera da sessão sem conferir o handoff fazia um ACK da rodada antiga
    // apagar a rede da rodada nova, e o pane ficava armado sem prazo nenhum.
    // A espera que sobra defere o fechamento enquanto o worker produz saída
    // (activityMark/isBusy), então a nota do rework não é interrompida.
    if (pendingNonSuccessBySession.get(sessionId)?.handoffId === handoffId) {
      clearPendingNonSuccess(sessionId);
    }
    // Só o close DESTE handoff é cancelado: o da rodada que ninguém devolveu
    // continua valendo, senão o pane fica sem pendente e sem timer.
    const scheduled = scheduledNonSuccessCloseBySession.get(sessionId);
    if (scheduled && scheduled.handoffId === handoffId) {
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
