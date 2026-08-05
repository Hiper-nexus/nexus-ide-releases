const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';
const MIN_PASTE_SETTLE_MS = 750;
const MAX_PASTE_SETTLE_MS = 2_500;

export interface PaneSubmitPorts {
  getSessionId(paneId: string): string | null;
  write(sessionId: string, data: string): void;
  writeConfirmed(sessionId: string, data: string): Promise<boolean>;
  schedule(callback: () => void, delayMs: number): unknown;
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
          .then(resolve, () => resolve(false));
      }, pasteSettleMs(text));
    });
  });
}
