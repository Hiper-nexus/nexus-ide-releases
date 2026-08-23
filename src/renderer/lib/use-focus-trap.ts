import { useEffect, type RefObject } from 'react';
import { nextTrapFocus } from './focus-trap';

/**
 * Prende o Tab dentro do diálogo enquanto ele estiver aberto.
 *
 * Captura no `keydown` da janela para vencer handlers de conteúdo, e só age
 * quando o diálogo está montado e ativo — fechado, o teclado volta a ser da
 * aplicação inteira.
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
): void {
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return;
      const root = ref.current;
      if (!root) return;
      const { handled, next } = nextTrapFocus(
        root,
        document.activeElement,
        event.shiftKey,
      );
      if (!handled || !next) return;
      event.preventDefault();
      next.focus();
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () =>
      window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [ref, active]);
}
