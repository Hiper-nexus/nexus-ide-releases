/**
 * Preferência de VISTA do card de cotas da barra lateral: recolhido (os 4
 * mais consumidos) ou expandido (todas as contas). Vive só neste navegador;
 * storage injetado nos testes e ausente/bloqueado nunca quebra a tela.
 */

const EXPANDED_KEY = 'nexus.rail.quotaExpanded.v1';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadQuotaCardExpanded(
  store: StorageLike | null = defaultStorage(),
): boolean {
  if (!store) return false;
  try {
    return store.getItem(EXPANDED_KEY) === 'expanded';
  } catch {
    return false;
  }
}

export function saveQuotaCardExpanded(
  expanded: boolean,
  store: StorageLike | null = defaultStorage(),
): void {
  if (!store) return;
  try {
    store.setItem(EXPANDED_KEY, expanded ? 'expanded' : 'collapsed');
  } catch {
    /* storage cheio ou bloqueado: a escolha só não persiste */
  }
}
