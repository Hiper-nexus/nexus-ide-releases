/**
 * Resposta direta (Onda 3) — o caminho que NÃO vira missão.
 *
 * O router de intenção (main) classifica o objetivo; se for uma pergunta
 * pura e trivial, um provedor barato já configurado responde inline e o
 * operador nunca paga squad/orquestrador/charters por "quanto é 1+1?".
 * Fail-open de ponta a ponta: qualquer falha devolve null e o fluxo normal
 * de missão segue — o router nunca pode derrubar o caminho que já existia.
 */

export interface DirectAnswer {
  readonly question: string;
  readonly answer: string;
}

/** Narrowing defensivo: o canal retorna `unknown` de propósito. */
function readDirectAnswerQuestion(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const route = raw as { readonly kind?: unknown; readonly question?: unknown };
  if (route.kind !== 'direct-answer') return null;
  if (typeof route.question !== 'string') return null;
  const question = route.question.trim();
  return question.length > 0 ? question : null;
}

/**
 * Classifica e, se for pergunta direta, tenta responder. `null` significa
 * "não é pergunta direta" OU "ninguém conseguiu responder" — nos dois casos
 * quem chamou deve seguir o fluxo normal de missão.
 */
export async function requestDirectAnswer(
  objective: string,
): Promise<DirectAnswer | null> {
  const text = objective.trim();
  if (!text) return null;
  const bridge = window.nexus?.mission;
  if (!bridge?.routeIntent || !bridge.answerDirect) return null;
  try {
    const question = readDirectAnswerQuestion(await bridge.routeIntent(text));
    if (!question) return null;
    const answer = (await bridge.answerDirect(question))?.trim();
    return answer ? { question, answer } : null;
  } catch {
    return null;
  }
}
