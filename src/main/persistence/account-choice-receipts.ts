/**
 * Recibos da escolha de conta por sessão (memória volátil): quem decidiu a
 * conta do pane — pinada, regra de folga, ativa, fallback, nativa ou legada —
 * para `nexus_pane_spawn`/`nexus_pane_whoami` devolverem o PORQUÊ sem que o
 * agente infira pelo título. Esquecido no exit do PTY.
 */
import type { AccountChoiceReceipt } from '../../shared/account-choice';

const receipts = new Map<string, AccountChoiceReceipt>();

/**
 * F-969: o failover de conta religa o MESMO pane numa conta fixada pelo Main.
 * O recibo da sessão nova diria só "fixada"; esta nota (por paneId, de vida
 * curta) diz que foi a troca automática por limite confirmado e de qual conta
 * esgotada ela veio. Só rótulos mascarados — nunca id, token ou e-mail cru.
 */
const FAILOVER_NOTE_TTL_MS = 5 * 60_000;
const pendingFailoverNotes = new Map<string, { note: string; at: number }>();

export function noteAccountFailoverForPane(
  paneId: string,
  note: string,
  now = Date.now(),
): void {
  pendingFailoverNotes.set(paneId, { note, at: now });
}

export function forgetAccountFailoverNote(paneId: string): void {
  pendingFailoverNotes.delete(paneId);
}

export function recordAccountChoiceReceipt(
  sessionId: string,
  receipt: AccountChoiceReceipt,
  paneId?: string,
  now = Date.now(),
): void {
  const pending = paneId ? pendingFailoverNotes.get(paneId) : undefined;
  if (paneId && pending) {
    pendingFailoverNotes.delete(paneId);
    if (now - pending.at <= FAILOVER_NOTE_TTL_MS) {
      receipts.set(sessionId, {
        ...receipt,
        note: receipt.note ? `${pending.note}; ${receipt.note}` : pending.note,
      });
      return;
    }
  }
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
