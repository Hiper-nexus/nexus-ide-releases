import { create } from 'zustand';
import { TAB_ORDER_CAP } from '../lib/tab-drag';

/**
 * Ordem das abas dos Terminais escolhida pelo operador (WEB-13). Preferência
 * de vista, não estado de missão: mora no localStorage como a largura do
 * rail, e a falta dela só devolve a ordem natural.
 */
export const TAB_ORDER_STORAGE_KEY = 'nexus.workspace-tabs.order';

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readStoredTabOrder(): string[] {
  try {
    const raw = storage()?.getItem(TAB_ORDER_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((key): key is string => typeof key === 'string' && key.length > 0 && key.length <= 300))]
      .slice(0, TAB_ORDER_CAP);
  } catch {
    return [];
  }
}

interface TabOrderStore {
  readonly order: readonly string[];
  setOrder(order: readonly string[]): void;
}

export const useTabOrderStore = create<TabOrderStore>((set) => ({
  order: readStoredTabOrder(),
  setOrder: (order) => {
    const next = [...order].slice(0, TAB_ORDER_CAP);
    try {
      storage()?.setItem(TAB_ORDER_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Storage cheio ou bloqueado: a ordem vale nesta sessão e pronto.
    }
    set({ order: next });
  },
}));
