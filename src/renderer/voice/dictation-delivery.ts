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

export type DictationLogLevel = 'info' | 'warn' | 'error';

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
  ): Promise<boolean>;
  /** Espelha no voice.log cada salto do trajeto. */
  log(
    level: DictationLogLevel,
    event: string,
    msg?: string,
    data?: Record<string, unknown>,
  ): void;
}

export type DictationRouteResult =
  | { ok: true; paneId: string }
  | { ok: false; reason: 'no-live-pane' | 'delivery-failed' };

/**
 * Roteia o ditado para o pane focado (ou um fallback vivo) e só reporta sucesso
 * quando o PTY confirma a injeção. Nunca devolve false-green: uma escrita não
 * confirmada vira `delivery-failed`, e ausência total de pane vivo vira
 * `no-live-pane` — ambos visíveis pro chamador surgir no HUD.
 */
export async function deliverDictation(
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

  // Salto 3 — IPC: despacho da injeção confirmada para o processo main.
  ports.log('info', 'dictation.ipcDispatch', 'despachando injeção confirmada via IPC', {
    targetPaneId,
    sessionId,
    chars: text.length,
  });
  const delivered = await ports.deliverConfirmed(targetPaneId, text, sessionId);

  // Salto 4 — escrita no PTY: recibo real da injeção (ou a falha, sem false-green).
  ports.log(
    delivered ? 'info' : 'error',
    delivered ? 'dictation.ptyConfirmed' : 'dictation.ptyFailed',
    delivered
      ? 'PTY confirmou a injeção do ditado'
      : 'PTY não confirmou a injeção do ditado — nada foi escrito',
    { targetPaneId, sessionId, chars: text.length },
  );

  return delivered
    ? { ok: true, paneId: targetPaneId }
    : { ok: false, reason: 'delivery-failed' };
}
