const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function dialogFocusableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (element) => element.getAttribute('aria-hidden') !== 'true',
  );
}

/** Returns true when the caller should prevent the native Tab navigation. */
export function trapDialogTabKey(
  container: HTMLElement,
  shiftKey: boolean,
): boolean {
  const focusable = dialogFocusableElements(container);
  if (focusable.length === 0) {
    container.focus();
    return true;
  }
  const first = focusable[0];
  const last = focusable.at(-1)!;
  const active = document.activeElement;
  if (!container.contains(active)) {
    (shiftKey ? last : first).focus();
    return true;
  }
  if (!shiftKey && active === last) {
    first.focus();
    return true;
  }
  if (shiftKey && active === first) {
    last.focus();
    return true;
  }
  return false;
}
