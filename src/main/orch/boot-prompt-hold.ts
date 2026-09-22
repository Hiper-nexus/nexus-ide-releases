import { orchWriteSession } from '../pty/pty-manager';
import { cliPromptAutoResponder } from './cli-prompt-autoresponder';

/**
 * How long to wait for a known boot menu before force-dismissing it.
 * 5s was tuned for menus that paint immediately; first-run CLIs (MiMo after
 * a multi-minute DB migration, Devin trust after a cold Node boot) have not
 * even drawn the dialog yet — force-accept finds no match and the brief is
 * pasted into the stream and swallowed.
 */
const BOOT_PROMPT_HOLD_MS = 25_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Block inject while a known interactive boot prompt is visible or just
 * accepted. If the menu is still up after maxMs, force-dismiss it (Down+Enter,
 * then numeric "2") so we never type the mission brief into the dialog.
 */
export async function waitOutBootPrompts(
  sessionId: string,
  maxMs = BOOT_PROMPT_HOLD_MS,
): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (
    cliPromptAutoResponder.shouldDeferInjection(sessionId) &&
    Date.now() < deadline
  ) {
    await delay(50);
  }
  if (!cliPromptAutoResponder.shouldDeferInjection(sessionId)) return;

  const forced = cliPromptAutoResponder.forceAcceptResponse(sessionId);
  if (forced) {
    orchWriteSession(sessionId, forced.response);
    if (forced.fallbackResponse) {
      await delay(120);
      // Some Claude Code builds ignore the primary keys on numbered menus.
      orchWriteSession(sessionId, forced.fallbackResponse);
    }
  }
  const settleDeadline = Date.now() + 600;
  while (
    cliPromptAutoResponder.shouldDeferInjection(sessionId) &&
    Date.now() < settleDeadline
  ) {
    await delay(50);
  }
}
