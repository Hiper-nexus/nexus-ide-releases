/**
 * Foco preso dentro de um diálogo.
 *
 * A auditoria achou seis `aria-modal="true"` sem cerca nenhuma: o Tab saía do
 * modal e passeava pela aplicação atrás do scrim. Quem navega por teclado
 * perde a referência de onde está — e quem usa leitor de tela é levado a
 * controles que o scrim já tornou inalcançáveis pelo mouse.
 *
 * Lógica pura, sem React, para ser testável com DOM de verdade.
 */

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Elementos que podem receber foco AGORA (visíveis e habilitados). */
export function focusableWithin(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) =>
      !element.hasAttribute('inert') &&
      element.getAttribute('aria-hidden') !== 'true',
  );
}

export interface TrapResult {
  /** True quando o Tab foi tratado aqui (o chamador deve prevenir o default). */
  readonly handled: boolean;
  /** Para onde o foco deve ir; null quando não há o que focar. */
  readonly next: HTMLElement | null;
}

/**
 * Decide o próximo foco de um Tab dentro do diálogo.
 * Circular: do último volta ao primeiro, e com Shift o inverso.
 */
export function nextTrapFocus(
  root: ParentNode,
  active: Element | null,
  shiftKey: boolean,
): TrapResult {
  const items = focusableWithin(root);
  if (items.length === 0) return { handled: false, next: null };
  const index = active instanceof HTMLElement ? items.indexOf(active) : -1;
  if (index === -1) {
    return { handled: true, next: shiftKey ? items[items.length - 1]! : items[0]! };
  }
  const nextIndex = shiftKey
    ? (index - 1 + items.length) % items.length
    : (index + 1) % items.length;
  return { handled: true, next: items[nextIndex]! };
}
