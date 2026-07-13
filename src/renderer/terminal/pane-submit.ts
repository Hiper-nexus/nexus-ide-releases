const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';
const PASTE_SETTLE_MS = 250;

export interface PaneSubmitPorts {
  getSessionId(paneId: string): string | null;
  write(sessionId: string, data: string): void;
  schedule(callback: () => void, delayMs: number): unknown;
}

/** Paste one complete agent prompt and submit it with the CR emitted by Enter. */
export function submitPromptToPane(
  paneId: string,
  text: string,
  ports: PaneSubmitPorts,
): boolean {
  const sessionId = ports.getSessionId(paneId);
  if (!sessionId) return false;

  ports.write(
    sessionId,
    `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`,
  );
  ports.schedule(() => {
    if (ports.getSessionId(paneId) !== sessionId) return;
    ports.write(sessionId, '\r');
  }, PASTE_SETTLE_MS);
  return true;
}
