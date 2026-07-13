/**
 * Hit-test puro do companion (testável sem Electron/DOM real).
 * Usado para decidir se o cursor está sobre zona interativa do pet.
 */

export function pointInRect(
  x: number,
  y: number,
  rect: { left: number; right: number; top: number; bottom: number },
): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

/**
 * Selector de zonas interativas do pet (sprite, balão, menu).
 * Mantido em sync com classes em PetApp / pet.css.
 */
export const PET_INTERACTIVE_SELECTOR = '.pet__hit, .pet__balloon, .pet__menu';
