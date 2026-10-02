/**
 * Recibo da escolha de conta de uma sessão, lido uma vez do Main e guardado por
 * `sessionId` (a decisão não muda durante a vida da sessão — respawn gera outro
 * id). Sem polling: quem pergunta é o hook, quando a sessão nasce ou muda.
 *
 * - Pedidos simultâneos da mesma sessão dividem UMA chamada ao IPC.
 * - Só recibo encontrado entra no cache; "sem recibo" e falha não, para que uma
 *   nova montagem ainda possa achá-lo.
 * - O que o bridge devolve passa de novo pela lista de permissão
 *   (`parseAccountChoiceReceipt`): a interface só vê campo conhecido e rótulo
 *   mascarado, mesmo que o Main mude.
 * - Nunca lança; o cache é limitado.
 */
import {
  parseAccountChoiceReceipt,
  type AccountChoiceReceipt,
} from '../../shared/account-choice';

/** Sessões de agente vivas são dezenas; o teto só impede crescimento sem fim. */
export const ACCOUNT_CHOICE_RECEIPT_CACHE_MAX = 64;

// Map preserva a ordem de inserção: a primeira chave é a mais antiga.
const cache = new Map<string, AccountChoiceReceipt>();
const inFlight = new Map<string, Promise<AccountChoiceReceipt | null>>();

/** Recibo já lido desta sessão, sem efeito colateral (seguro para o render). */
export function peekAccountChoiceReceipt(sessionId: string): AccountChoiceReceipt | undefined {
  return cache.get(sessionId);
}

function remember(sessionId: string, receipt: AccountChoiceReceipt): void {
  cache.delete(sessionId);
  cache.set(sessionId, receipt);
  while (cache.size > ACCOUNT_CHOICE_RECEIPT_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

async function fetchReceipt(sessionId: string): Promise<AccountChoiceReceipt | null> {
  try {
    const api = window.nexus?.accountChoice;
    if (!api) return null;
    return parseAccountChoiceReceipt(await api.get(sessionId));
  } catch {
    return null;
  }
}

export function loadAccountChoiceReceipt(sessionId: string): Promise<AccountChoiceReceipt | null> {
  const cached = cache.get(sessionId);
  if (cached) return Promise.resolve(cached);
  const pending = inFlight.get(sessionId);
  if (pending) return pending;
  const request = fetchReceipt(sessionId)
    .then((receipt) => {
      if (receipt) remember(sessionId, receipt);
      return receipt;
    })
    .finally(() => {
      inFlight.delete(sessionId);
    });
  inFlight.set(sessionId, request);
  return request;
}

/** Esquece tudo (testes). */
export function clearAccountChoiceReceiptCache(): void {
  cache.clear();
  inFlight.clear();
}
