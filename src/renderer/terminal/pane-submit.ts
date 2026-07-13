const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';
const PASTE_SETTLE_MS = 250;

export interface PaneSubmitPorts {
  getSessionId(paneId: string): string | null;
  write(sessionId: string, data: string): void;
  writeConfirmed(sessionId: string, data: string): Promise<boolean>;
  schedule(callback: () => void, delayMs: number): unknown;
}

function isSafePrompt(text: string): boolean {
  return text.length > 0 && !/[\x00-\x08\x0b-\x1f\x7f]/u.test(text);
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
  }, PASTE_SETTLE_MS);
  return true;
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
      }, PASTE_SETTLE_MS);
    });
  });
}
