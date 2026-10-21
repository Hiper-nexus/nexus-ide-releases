/**
 * First prompt of a pane opened for a task (F-1596: "Novo vídeo de
 * apresentação"). Kept in memory by pane id until the pane's CLI is ready;
 * terminal-host delivers it once, through the same readiness wait the
 * continuity pack uses. Never persisted: a restart drops an undelivered brief.
 */

const pending = new Map<string, string>();

/**
 * Guarda de último recurso, NÃO o teto de quem escreve. O corte aqui é no
 * FIM do texto — e o fim do brief é justamente a regra de custo ("me mostre
 * o roteiro e o custo e espere o meu ok") e a linha de entrega. Em 8.000 um
 * brief com muitos anexos já passava: o agente recebia o pedido sem a trava
 * de gasto e podia pagar API sem perguntar.
 *
 * Quem limita é o formulário, campo a campo (`BRIEF_FIELD_LIMITS`), com
 * contador à vista. Este número fica acima do PIOR caso que aquele
 * formulário consegue montar — `pending-brief.test.ts` monta esse pior caso
 * e falha se um teto de campo crescer sem este acompanhar.
 *
 * Acima de `WINDOWS_NATIVE_PROMPT_MAX_CHARS` (20.000) o brief deixa o argv e
 * é entregue por colagem; é caminho previsto (F-669), não perda.
 */
export const MAX_BRIEF_CHARS = 20_000;

export function stashPendingBrief(paneId: string, brief: string): void {
  const text = brief.trim().slice(0, MAX_BRIEF_CHARS);
  if (text) pending.set(paneId, text);
}

export function takePendingBrief(paneId: string): string | undefined {
  const brief = pending.get(paneId);
  pending.delete(paneId);
  return brief;
}
