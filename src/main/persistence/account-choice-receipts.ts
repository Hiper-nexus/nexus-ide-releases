/**
 * Recibos da escolha de conta por sessão (memória volátil): quem decidiu a
 * conta do pane — pinada, regra de folga, ativa, fallback, nativa ou legada —
 * para `nexus_pane_spawn`/`nexus_pane_whoami` devolverem o PORQUÊ sem que o
 * agente infira pelo título. Esquecido no exit do PTY.
 */
import type { AccountChoiceReceipt } from '../../shared/account-choice';

const receipts = new Map<string, AccountChoiceReceipt>();

export function recordAccountChoiceReceipt(
  sessionId: string,
  receipt: AccountChoiceReceipt,
): void {
  receipts.set(sessionId, receipt);
}

export function getAccountChoiceReceipt(
  sessionId: string,
): AccountChoiceReceipt | undefined {
  return receipts.get(sessionId);
}

export function forgetAccountChoiceReceipt(sessionId: string): void {
  receipts.delete(sessionId);
}
