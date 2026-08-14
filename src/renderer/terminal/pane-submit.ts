const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';
const MIN_PASTE_SETTLE_MS = 750;
const MAX_PASTE_SETTLE_MS = 2_500;
/**
 * Janela para o turno abrir depois do Enter (idle→busy). Estourou sem
 * transição = Enter comido (rascunho empilhado no composer, repaint da TUI) —
 * o campo (14/08) mostrou texto PRESO no composer do claude com o Enter
 * virando quebra de linha, sem sinal nenhum pra cima.
 */
const SUBMIT_TURN_ACCEPTANCE_MS = 8_000;
/** Segunda janela, após o ÚNICO CR de destravamento. */
const SUBMIT_RETRY_ACCEPTANCE_MS = 4_000;

export interface PaneSubmitPorts {
  getSessionId(paneId: string): string | null;
  write(sessionId: string, data: string): void;
  writeConfirmed(sessionId: string, data: string): Promise<boolean>;
  schedule(callback: () => void, delayMs: number): unknown;
  /**
   * Sonda opcional de estado da sessão (pty.onStateChange). Presente, o
   * submit ganha verificação: sem transição para busy dentro da janela, UM
   * CR de destravamento e mais uma janela — nunca re-paste.
   */
  onSessionState?(
    sessionId: string,
    cb: (state: string) => void,
  ): () => void;
}

/** Espera a prova de que o turno abriu (transição para busy). Aditiva: sem a
 * sonda de estado, aceita como hoje. */
function awaitTurnStart(
  ports: { schedule(callback: () => void, delayMs: number): unknown; onSessionState?(sessionId: string, cb: (state: string) => void): () => void },
  sessionId: string,
  timeoutMs: number,
): Promise<boolean> {
  // Sem sonda de estado (ports antigas/testes): aceita como hoje — o degrau
  // de verificação é aditivo, nunca um timeout novo no caminho existente.
  if (!ports.onSessionState) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try {
        unsubscribe?.();
      } catch {
        /* best-effort */
      }
      resolve(ok);
    };
    const unsubscribe = ports.onSessionState?.(sessionId, (state) => {
      if (state === 'busy') finish(true);
    });
    ports.schedule(() => finish(false), timeoutMs);
  });
}

/**
 * Pós-Enter com verificação: se o turno não abriu, UM CR de destravamento —
 * nunca re-paste (duplicar o prompt seria pior que o travamento; CR em
 * composer vazio é no-op). Limitado a uma tentativa.
 */
function confirmEnterTookEffect(
  ports: Parameters<typeof awaitTurnStart>[0] & { getSessionId(paneId: string): string | null },
  paneId: string,
  expectedSessionId: string,
  writeEnter: (sessionId: string) => Promise<boolean>,
): Promise<boolean> {
  return awaitTurnStart(ports, expectedSessionId, SUBMIT_TURN_ACCEPTANCE_MS).then(
    (started) => {
      if (started) return true;
      if (ports.getSessionId(paneId) !== expectedSessionId) return false;
      return writeEnter(expectedSessionId).then(
        (retryAccepted) =>
          retryAccepted
            ? awaitTurnStart(ports, expectedSessionId, SUBMIT_RETRY_ACCEPTANCE_MS)
            : false,
        () => false,
      );
    },
  );
}

function isSafePrompt(text: string): boolean {
  return text.length > 0 && !/[\x00-\x08\x0b-\x1f\x7f]/u.test(text);
}

function pasteSettleMs(text: string): number {
  return Math.min(
    MAX_PASTE_SETTLE_MS,
    Math.max(MIN_PASTE_SETTLE_MS, Math.ceil(text.length * 1.4)),
  );
}

function pastePrompt(
  paneId: string,
  text: string,
  ports: PaneSubmitPorts,
): string | null {
  if (!isSafePrompt(text)) return null;
  const sessionId = ports.getSessionId(paneId);
  if (!sessionId) return null;
  ports.write(
    sessionId,
    `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`,
  );
  return sessionId;
}

/** Paste one complete agent prompt and schedule the CR emitted by Enter. */
export function submitPromptToPane(
  paneId: string,
  text: string,
  ports: PaneSubmitPorts,
): boolean {
  const sessionId = pastePrompt(paneId, text, ports);
  if (!sessionId) return false;
  ports.schedule(() => {
    if (ports.getSessionId(paneId) !== sessionId) return;
    ports.write(sessionId, '\r');
  }, pasteSettleMs(text));
  return true;
}

export interface PaneOperatorSubmitPorts {
  getSessionId(paneId: string): string | null;
  /** Escrita pela lane do operador (orch:panes.operatorInput) com recibo real. */
  operatorWrite(sessionId: string, data: string): Promise<boolean>;
  schedule(callback: () => void, delayMs: number): unknown;
  /** Sonda opcional — mesma semântica aditiva do PaneSubmitPorts. */
  onSessionState?(
    sessionId: string,
    cb: (state: string) => void,
  ): () => void;
}

/**
 * Digitação confirmada pela LANE DO OPERADOR — o caminho autorizado para panes
 * governados: writeSession (IPC cru do terminal) recusa sessões de agentes
 * orquestrados por design (pty-manager: presentation authority only), e a lane
 * do operador rejeita bracketed paste. Logo: texto plano (quebras de linha
 * viram espaço) seguido de Enter após o settle, cada escrita com recibo.
 */
export function submitPromptToPaneOperator(
  paneId: string,
  text: string,
  expectedSessionId: string,
  ports: PaneOperatorSubmitPorts,
): Promise<boolean> {
  const line = text.replace(/\r?\n/gu, ' ');
  if (!isSafePrompt(line)) return Promise.resolve(false);
  if (ports.getSessionId(paneId) !== expectedSessionId) {
    return Promise.resolve(false);
  }
  return ports.operatorWrite(expectedSessionId, line).then(
    (accepted) => {
      if (!accepted || ports.getSessionId(paneId) !== expectedSessionId) {
        return false;
      }
      return new Promise<boolean>((resolve) => {
        ports.schedule(() => {
          if (ports.getSessionId(paneId) !== expectedSessionId) {
            resolve(false);
            return;
          }
          void ports.operatorWrite(expectedSessionId, '\r')
            .then((enterAccepted) =>
              enterAccepted
                ? confirmEnterTookEffect(
                    ports,
                    paneId,
                    expectedSessionId,
                    (sessionId) => ports.operatorWrite(sessionId, '\r'),
                  )
                : false,
            )
            .then(resolve, () => resolve(false));
        }, pasteSettleMs(line));
      });
    },
    () => false,
  );
}

/** Confirm paste and Enter against the exact recovered PTY identity. */
export function submitPromptToPaneConfirmed(
  paneId: string,
  text: string,
  expectedSessionId: string,
  ports: PaneSubmitPorts,
): Promise<boolean> {
  if (!isSafePrompt(text)) return Promise.resolve(false);
  if (ports.getSessionId(paneId) !== expectedSessionId) {
    return Promise.resolve(false);
  }
  return ports.writeConfirmed(
    expectedSessionId,
    `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`,
  ).then((pasteAccepted) => {
    if (
      !pasteAccepted ||
      ports.getSessionId(paneId) !== expectedSessionId
    ) {
      return false;
    }
    return new Promise<boolean>((resolve) => {
      ports.schedule(() => {
        if (ports.getSessionId(paneId) !== expectedSessionId) {
          resolve(false);
          return;
        }
        void ports.writeConfirmed(expectedSessionId, '\r')
          .then((enterAccepted) =>
            enterAccepted
              ? confirmEnterTookEffect(
                  ports,
                  paneId,
                  expectedSessionId,
                  (sessionId) => ports.writeConfirmed(sessionId, '\r'),
                )
              : false,
          )
          .then(resolve, () => resolve(false));
      }, pasteSettleMs(text));
    });
  });
}
