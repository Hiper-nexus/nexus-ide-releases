/**
 * Largura do rail, ajustável pela pessoa.
 *
 * DESIGN.md §11 já descreve o rail como "largura persistente de 260px (faixa
 * permitida: 200-480px)" — a faixa existia no contrato e nunca no produto: a
 * largura era um literal em CSS. Em janela estreita isso deixava o rail comendo
 * um terço do canvas sem escape, e em rail largo os nomes de pasta cabiam mas
 * ninguém podia pedir por eles.
 */
import { create } from 'zustand';

export const RAIL_WIDTH_MIN = 200;
export const RAIL_WIDTH_MAX = 480;
export const RAIL_WIDTH_DEFAULT = 260;
export const RAIL_WIDTH_STORAGE_KEY = 'nexus.rail.width';

/** Fora da faixa vira o extremo mais próximo; lixo vira o default. */
export function clampRailWidth(value: number): number {
  if (!Number.isFinite(value)) return RAIL_WIDTH_DEFAULT;
  return Math.min(RAIL_WIDTH_MAX, Math.max(RAIL_WIDTH_MIN, Math.round(value)));
}

function storage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readStoredRailWidth(): number {
  const store = storage();
  if (!store) return RAIL_WIDTH_DEFAULT;
  let raw: string | null;
  try {
    raw = store.getItem(RAIL_WIDTH_STORAGE_KEY);
  } catch {
    return RAIL_WIDTH_DEFAULT;
  }
  if (raw === null) return RAIL_WIDTH_DEFAULT;
  return clampRailWidth(Number.parseFloat(raw));
}

function persistRailWidth(width: number): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(RAIL_WIDTH_STORAGE_KEY, String(width));
  } catch {
    // Storage cheio ou bloqueado não pode travar o arraste em andamento.
  }
}

interface RailWidthStore {
  width: number;
  setWidth(width: number): void;
  reset(): void;
}

export const useRailWidthStore = create<RailWidthStore>((set) => ({
  width: readStoredRailWidth(),
  setWidth: (width) => {
    const next = clampRailWidth(width);
    persistRailWidth(next);
    set({ width: next });
  },
  reset: () => {
    persistRailWidth(RAIL_WIDTH_DEFAULT);
    set({ width: RAIL_WIDTH_DEFAULT });
  },
}));
