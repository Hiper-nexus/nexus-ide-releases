import { useEffect, useState } from 'react';
import type { AccountChoiceReceipt } from '../../shared/account-choice';
import { loadAccountChoiceReceipt, peekAccountChoiceReceipt } from './account-choice-receipt';

interface FetchedReceipt {
  readonly sessionId: string;
  readonly receipt: AccountChoiceReceipt;
}

/**
 * Recibo da escolha de conta da sessão viva de um pane. Pergunta ao Main UMA
 * vez quando a sessão nasce ou muda (nada de polling nem de pedido a cada
 * render); sem sessão devolve `null`, e o recibo de uma sessão anterior nunca
 * aparece para a seguinte. Resposta que chega depois de a sessão mudar é
 * descartada.
 */
export function useAccountChoiceReceipt(sessionId: string | null): AccountChoiceReceipt | null {
  const [fetched, setFetched] = useState<FetchedReceipt | null>(null);

  useEffect(() => {
    if (!sessionId || peekAccountChoiceReceipt(sessionId)) return undefined;
    let cancelled = false;
    void loadAccountChoiceReceipt(sessionId).then((receipt) => {
      if (!cancelled && receipt) setFetched({ sessionId, receipt });
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  if (!sessionId) return null;
  const cached = peekAccountChoiceReceipt(sessionId);
  if (cached) return cached;
  return fetched?.sessionId === sessionId ? fetched.receipt : null;
}
