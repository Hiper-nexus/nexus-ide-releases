/**
 * Entrega CONFIRMADA do ditado no pane — o coração do fix do release-blocker
 * v0.25.1 (ditado 100% morto no empacotado). O ASR e o HUD funcionavam, mas
 * `routeDictation` chamava o caminho fire-and-forget `submitPromptToPane`, que
 * devolve `true` por MERA presença de sessão e não instrumenta nada: o pane
 * nunca recebia o texto e mesmo assim o HUD pintava sucesso (false-green).
 *
 * Este módulo é puro/injetável (mesmo idioma de ports do `pane-submit.ts`) por
 * dois motivos: (1) a lógica de confirmação e de fallback fica testável sem o
 * grafo pesado de imports do voice-run-jarvis-turn; (2) cada salto do trajeto
 * — emit → resolução de alvo → IPC → escrita no PTY — emite uma linha no
 * voice.log, então uma morte silenciosa futura fica rastreável ponta a ponta.
 */

import type { PtyPromptState } from '../../shared/types';

export type DictationLogLevel = 'info' | 'warn' | 'error';

/**
 * F-1393: resultado de uma lane. `queued` = pane ocupado que enfileira texto
 * + Enter; `wait` = nada escrito, vale esperar o pane ficar livre. Boolean
 * segue aceito (true = started, false = failed) para portas antigas.
 */
export type DictationLaneOutcome = 'started' | 'queued' | 'wait' | 'failed' | 'lost';

/** C2 (F-1393): como terminou um ditado pendente. */
export type DictationPendingErrorCode =
  | 'pending-timeout'
  | 'pending-session-changed'
  | 'pending-failed'
  /** C-5: o pane livre recebeu o texto mas o envio não se confirmou. */
  | 'pending-lost'
  /** Input humano no pane (respondeu o diálogo): texto vai para a área de transferência. */
  | 'pending-cancelled'
  /** C-2: um ditado novo para o mesmo pane tomou o lugar — sem cópia, sem nota. */
  | 'pending-replaced';

export interface DictationPendingSettled {
  readonly paneId: string;
  readonly result: 'ok' | 'error';
  readonly errorCode?: DictationPendingErrorCode;
  /** Falha real do pendente: o texto foi para a área de transferência. */
  readonly preserved?: boolean;
}

/** C-7 (F-1393): recusas SEM escrita toleradas no pane livre antes de desistir. */
export const DICTATION_PENDING_FAILED_RETRIES = 3;

/** F-1393: teto de segurança do ditado pendente e cadência da sonda. */
export const DICTATION_PENDING_MAX_MS = 10 * 60_000;
export const DICTATION_PENDING_POLL_MS = 1_000;

export interface DictationDeliveryPorts {
  /** Pane atualmente focado (destino natural do ditado). */
  getFocusedPaneId(): string | null;
  /** Panes com sessão PTY VIVA, em ordem de layout (candidatos de fallback). */
  listLivePaneIds(): string[];
  /** Sessão viva do pane, ou null se morreu. */
  getSessionId(paneId: string): string | null;
  /** Injeção com recibo real (paste + Enter confirmados contra a sessão). */
  deliverConfirmed(
    paneId: string,
    text: string,
    sessionId: string,
  ): Promise<boolean | DictationLaneOutcome>;
  /**
   * Lane do operador (orch:panes.operatorInput) — o caminho autorizado quando o
   * pane é um agente governado: o IPC cru do terminal recusa essas sessões por
   * design (pty-manager, presentation-only authority).
   */
  deliverOperator(
    paneId: string,
    text: string,
    sessionId: string,
  ): Promise<boolean | DictationLaneOutcome>;
  /**
   * F-1393: sonda do pane para o ditado pendente (diálogo aberto ou adapter
   * sem fila). Com `schedule`, o pendente é entregue quando o pane voltar a
   * idle sem diálogo, na MESMA sessão; sem as duas portas, `wait` vira falha.
   */
  probePromptState?(paneId: string, sessionId: string): Promise<PtyPromptState | null>;
  schedule?(callback: () => void, delayMs: number): unknown;
  now?(): number;
  /**
   * C2 (F-1393): desfecho do ditado pendente (entregue, descartado ou
   * cancelado) — o chamador fecha a sessão de uso e atualiza o HUD.
   */
  onSettled?(settled: DictationPendingSettled): void;
  /**
   * C-3 (F-1393): o pendente começou (true) ou desistiu (false, pane voltou a
   * ficar ocupado) de entrar no pane livre — o HUD mostra "Ditado entrando…".
   */
  onDelivering?(paneId: string, active: boolean): void;
  /**
   * F-1393: o ditado que nenhum pane aceitou não pode sumir — o operador
   * falou um prompt inteiro. Guarda o texto (área de transferência) e diz se
   * conseguiu; ausente, o comportamento antigo segue.
   */
  preserveUndelivered?(text: string): Promise<boolean>;
  /** Espelha no voice.log cada salto do trajeto. */
  log(
    level: DictationLogLevel,
    event: string,
    msg?: string,
    data?: Record<string, unknown>,
  ): void;
}

export type DictationRouteResult =
  | {
      ok: true;
      paneId: string;
      /** F-1393: pane ocupado enfileirou; o turno abre depois do atual. */
      queued?: boolean;
    }
  | {
      ok: false;
      /**
       * `delivery-lost` (C1): o texto foi escrito no pane mas o envio não se
       * confirmou — sem re-colar em outra lane; o HUD manda conferir o pane.
       */
      reason: 'no-live-pane' | 'delivery-failed' | 'delivery-lost';
      /** F-1393: texto guardado na área de transferência para colar. */
      preserved?: boolean;
    }
  | {
      /** F-1393: nada escrito ainda; entra quando o pane ficar livre. */
      ok: false;
      reason: 'pending';
      paneId: string;
      preserved?: boolean;
    };

/**
 * Roteia o ditado para o pane focado (ou um fallback vivo) e só reporta sucesso
 * quando o PTY confirma a injeção. Nunca devolve false-green: uma escrita não
 * confirmada vira `delivery-failed`, e ausência total de pane vivo vira
 * `no-live-pane` — ambos visíveis pro chamador surgir no HUD. Pane ocupado
 * que enfileira recebe o ditado (`queued`); diálogo aberto ou adapter sem fila
 * deixa o ditado pendente até o pane ficar livre (F-1393).
 */
export async function deliverDictation(
  text: string,
  ports: DictationDeliveryPorts,
): Promise<DictationRouteResult> {
  const routed = await routeToPane(text, ports);
  // B1 (F-1393): pendente NÃO vai para a área de transferência — colar o
  // texto e depois o Nexus entregar o mesmo pendente rodaria o prompt duas
  // vezes. A cópia fica só para falha real.
  if (routed.ok || routed.reason === 'pending' || !ports.preserveUndelivered) return routed;
  const preserved = await ports.preserveUndelivered(text).catch(() => false);
  ports.log(
    preserved ? 'info' : 'error',
    'dictation.preserved',
    preserved
      ? 'ditado não entregue foi copiado para a área de transferência'
      : 'ditado não entregue e a cópia falhou',
    { reason: routed.reason, chars: text.length, preserved },
  );
  return { ...routed, preserved };
}

function laneOutcome(value: boolean | DictationLaneOutcome): DictationLaneOutcome {
  if (value === true) return 'started';
  if (value === false) return 'failed';
  return value;
}

async function deliverOnLanes(
  targetPaneId: string,
  text: string,
  sessionId: string,
  ports: DictationDeliveryPorts,
): Promise<{ outcome: DictationLaneOutcome; lane: 'terminal' | 'operator' }> {
  const outcome = laneOutcome(await ports.deliverConfirmed(targetPaneId, text, sessionId));
  // C1: só uma recusa SEM escrita cai na outra lane — `lost` já escreveu, e
  // colar de novo duplicaria o prompt no composer.
  if (outcome !== 'failed') return { outcome, lane: 'terminal' };
  // Pane governado: o IPC cru do terminal recusa sessões de agentes
  // orquestrados por design (pty-manager, presentation-only). A recusa cai na
  // lane do operador, que valida posse+missão no main e devolve recibo real.
  ports.log(
    'info',
    'dictation.laneFallback',
    'lane terminal recusou — tentando a lane do operador (pane governado)',
    { targetPaneId, sessionId },
  );
  return {
    outcome: laneOutcome(await ports.deliverOperator(targetPaneId, text, sessionId)),
    lane: 'operator',
  };
}

/** Um pendente por pane; um ditado novo para o pane substitui o anterior. */
type PendingCancelReason = 'replaced' | 'human-input';
interface PendingEntry {
  readonly token: number;
  /** C-3: entrega em voo (paste + Enter já saindo) — tecla não cancela. */
  delivering: boolean;
  deliveringDone?: Promise<void>;
  cancel(reason: PendingCancelReason): void;
}
const pendingByPane = new Map<string, PendingEntry>();
let pendingSeq = 0;

/** C-6 (F-1393): ainda há ditado pendente em algum pane? */
export function hasPendingDictation(): boolean {
  return pendingByPane.size > 0;
}

function cancelPending(paneId: string): boolean {
  const entry = pendingByPane.get(paneId);
  if (!entry || entry.delivering) return false;
  entry.cancel('replaced');
  return true;
}

/**
 * B1 (F-1393): input humano no pane (teclado, colar, espaços do hold-to-talk)
 * cancela o ditado pendente dele — o operador assumiu o pane (respondeu o
 * diálogo, colou o texto); entregar depois duplicaria o prompt.
 */
export function cancelPendingDictation(paneId: string): boolean {
  const entry = pendingByPane.get(paneId);
  // C-3: com o paste/Enter em voo, cancelar só mentiria no HUD — o texto
  // entra de qualquer jeito. A tecla do operador segue para o pane normal.
  if (!entry || entry.delivering) return false;
  entry.cancel('human-input');
  return true;
}

function deferUntilFree(
  paneId: string,
  sessionId: string,
  text: string,
  ports: DictationDeliveryPorts,
): void {
  const probe = ports.probePromptState!;
  const schedule = ports.schedule!;
  const now = ports.now ?? Date.now;
  const token = ++pendingSeq;
  const startedAt = now();
  const mine = () => pendingByPane.get(paneId)?.token === token;
  const settle = (
    level: DictationLogLevel,
    event: string,
    msg: string,
    extra: Record<string, unknown>,
    errorCode?: DictationPendingErrorCode,
  ) => {
    if (mine()) pendingByPane.delete(paneId);
    ports.log(level, event, msg, { targetPaneId: paneId, sessionId, chars: text.length, ...extra });
    const outcome = { paneId, result: errorCode ? 'error' : 'ok', ...(errorCode ? { errorCode } : {}) } as const;
    // C2: o pendente que não entra guarda o texto agora — B1 tirou a cópia do
    // momento em que ele ficou pendente. C-1: inclui o cancelamento por input
    // humano (responder o diálogo com y/Enter é o único jeito de fechá-lo; sem
    // cópia o prompt falado sumia) — o pendente já saiu do mapa, então colar
    // não duplica. Só o substituído por um ditado novo não copia.
    if (errorCode && errorCode !== 'pending-replaced' && ports.preserveUndelivered) {
      void ports.preserveUndelivered(text)
        .catch(() => false)
        .then((preserved) => ports.onSettled?.({ ...outcome, preserved }));
      return;
    }
    ports.onSettled?.(outcome);
  };
  let failedAttempts = 0;
  const entry: PendingEntry = {
    token,
    delivering: false,
    cancel: (reason) =>
      settle(
        'info',
        reason === 'replaced' ? 'dictation.pendingReplaced' : 'dictation.pendingCancelled',
        reason === 'replaced'
          ? 'ditado pendente substituído por um novo'
          : 'input humano no pane — ditado pendente cancelado',
        { reason },
        reason === 'replaced' ? 'pending-replaced' : 'pending-cancelled',
      ),
  };
  pendingByPane.set(paneId, entry);
  const backToWaiting = () => {
    entry.delivering = false;
    ports.onDelivering?.(paneId, false);
    schedule(() => void tick(), DICTATION_PENDING_POLL_MS);
  };
  const tick = async (): Promise<void> => {
    if (!mine()) return;
    if (ports.getSessionId(paneId) !== sessionId) {
      settle('warn', 'dictation.pendingDropped', 'sessão do pane mudou — ditado pendente descartado', { reason: 'session-changed' }, 'pending-session-changed');
      return;
    }
    if (now() - startedAt >= DICTATION_PENDING_MAX_MS) {
      settle('warn', 'dictation.pendingDropped', 'pane não ficou livre em 10 min — ditado pendente descartado', { reason: 'timeout' }, 'pending-timeout');
      return;
    }
    const state = await probe(paneId, sessionId).catch(() => null);
    if (!mine()) return;
    if (state && state.state === 'idle' && !state.awaitingInput) {
      entry.delivering = true;
      let resolveDone: () => void = () => {};
      entry.deliveringDone = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      ports.onDelivering?.(paneId, true);
      try {
        const { outcome, lane } = await deliverOnLanes(paneId, text, sessionId, ports);
        if (!mine()) return;
        if (outcome === 'wait') {
          backToWaiting();
          return;
        }
        // C-7: recusa sem nada escrito (IPC, posse momentânea) não encerra o
        // pendente de primeira — tenta de novo nos próximos ticks.
        if (outcome === 'failed' && ++failedAttempts <= DICTATION_PENDING_FAILED_RETRIES) {
          ports.log('info', 'dictation.pendingRetry', 'pane livre recusou sem escrever — nova tentativa', {
            targetPaneId: paneId,
            sessionId,
            attempt: failedAttempts,
          });
          backToWaiting();
          return;
        }
        const delivered = outcome === 'started' || outcome === 'queued';
        settle(
          delivered ? 'info' : 'error',
          delivered ? 'dictation.pendingDelivered' : outcome === 'lost' ? 'dictation.pendingLost' : 'dictation.pendingFailed',
          delivered
            ? 'ditado pendente entregue ao pane livre'
            : outcome === 'lost'
              ? 'texto do pendente escrito no pane mas o envio não se confirmou'
              : 'pane livre recusou o ditado pendente',
          { lane, outcome },
          delivered ? undefined : outcome === 'lost' ? 'pending-lost' : 'pending-failed',
        );
        return;
      } finally {
        entry.deliveringDone = undefined;
        resolveDone();
      }
    }
    schedule(() => void tick(), DICTATION_PENDING_POLL_MS);
  };
  schedule(() => void tick(), DICTATION_PENDING_POLL_MS);
}

async function routeToPane(
  text: string,
  ports: DictationDeliveryPorts,
): Promise<DictationRouteResult> {
  const focusedPaneId = ports.getFocusedPaneId();
  // Salto 1 — emit: o ditado transcrito está pronto para roteamento.
  ports.log('info', 'dictation.emit', 'ditado pronto para roteamento', {
    focusedPaneId,
    chars: text.length,
  });

  // Salto 2 — resolução de alvo: exige sessão VIVA; foco sem sessão cai num
  // fallback (primeiro pane vivo), nunca num silent-drop.
  const livePaneIds = ports.listLivePaneIds();
  const focusedIsLive = focusedPaneId != null && livePaneIds.includes(focusedPaneId);
  const targetPaneId = focusedIsLive ? focusedPaneId : livePaneIds[0];

  if (!targetPaneId) {
    ports.log(
      'error',
      'dictation.noLivePane',
      'nenhum pane com sessão viva para receber o ditado',
      { focusedPaneId },
    );
    return { ok: false, reason: 'no-live-pane' };
  }

  const sessionId = ports.getSessionId(targetPaneId);
  if (!sessionId) {
    ports.log(
      'error',
      'dictation.sessionGone',
      'pane alvo perdeu a sessão antes da escrita',
      { targetPaneId, focusedPaneId },
    );
    return { ok: false, reason: 'no-live-pane' };
  }

  const usedFallback = targetPaneId !== focusedPaneId;
  ports.log('info', 'dictation.targetResolved', 'alvo do ditado resolvido', {
    targetPaneId,
    sessionId,
    usedFallback,
  });
  const existingPending = pendingByPane.get(targetPaneId);
  if (existingPending?.delivering && existingPending.deliveringDone) {
    await existingPending.deliveringDone;
  }
  cancelPending(targetPaneId);

  // Salto 3 — IPC: despacho da injeção confirmada para o processo main.
  ports.log('info', 'dictation.ipcDispatch', 'despachando injeção confirmada via IPC', {
    targetPaneId,
    sessionId,
    chars: text.length,
  });
  const { outcome, lane } = await deliverOnLanes(targetPaneId, text, sessionId, ports);

  // Salto 4 — escrita no PTY: recibo real da injeção (ou a falha, sem false-green).
  if (outcome === 'queued') {
    ports.log('info', 'dictation.ptyQueued', 'pane ocupado enfileirou o ditado (entra depois do turno atual)', {
      targetPaneId,
      sessionId,
      chars: text.length,
      lane,
    });
    return { ok: true, paneId: targetPaneId, queued: true };
  }
  if (outcome === 'wait' && ports.probePromptState && ports.schedule) {
    ports.log('info', 'dictation.pending', 'pane com diálogo ou sem fila — ditado aguardando o pane ficar livre', {
      targetPaneId,
      sessionId,
      chars: text.length,
      lane,
    });
    deferUntilFree(targetPaneId, sessionId, text, ports);
    return { ok: false, reason: 'pending', paneId: targetPaneId };
  }
  if (outcome === 'lost') {
    ports.log('error', 'dictation.ptyLost', 'texto escrito no pane mas o envio não se confirmou — sem re-colar', {
      targetPaneId,
      sessionId,
      chars: text.length,
      lane,
    });
    return { ok: false, reason: 'delivery-lost' };
  }
  const delivered = outcome === 'started';
  ports.log(
    delivered ? 'info' : 'error',
    delivered ? 'dictation.ptyConfirmed' : 'dictation.ptyFailed',
    delivered
      ? 'PTY confirmou a injeção do ditado'
      : 'PTY não confirmou a injeção do ditado — nada foi escrito',
    { targetPaneId, sessionId, chars: text.length, lane },
  );

  return delivered
    ? { ok: true, paneId: targetPaneId }
    : { ok: false, reason: 'delivery-failed' };
}

/** Test-only. */
export function resetPendingDictationsForTests(): void {
  pendingByPane.clear();
}
