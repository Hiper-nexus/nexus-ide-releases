/**
 * Largura do inspetor da missão, ajustável pela pessoa.
 *
 * O quadro já colapsava o inspetor com persistência, mas a largura era uma
 * fração da área de trabalho recalculada a cada montagem: quem arrastava o
 * divisor perdia o ajuste ao trocar de missão. Aqui a largura vira preferência
 * durável, no mesmo idioma do `rail-width-store`.
 *
 * Padrão portado do Agent Orchestrator (Untrivial-ai/agent-orchestrator,
 * Apache-2.0): largura persistida em localStorage e publicada como CSS var na
 * raiz do layout, nunca como `style` inline por filho. Ver
 * `third_party/provenance/agent-orchestrator-2026-09-09.json`.
 */
import { create } from 'zustand';

/**
 * A faixa espelha `--nexus-shell-inspector-min/max` de `styles/app-shell.css`
 * — o que o shell já concede ao inspetor de produto. O CSS do quadro lê os
 * tokens direto (`min-width`/`max-width`); o store precisa dos números para o
 * clamp e para o `aria-valuenow` do divisor. O teste do store confere que os
 * dois não divergiram.
 */
export const MISSION_INSPECTOR_WIDTH_MIN = 360;
export const MISSION_INSPECTOR_WIDTH_MAX = 440;
export const MISSION_INSPECTOR_WIDTH_DEFAULT = 400;
export const MISSION_INSPECTOR_WIDTH_STORAGE_KEY =
  'nexus.mission.inspector-width';

/** Fora da faixa vira o extremo mais próximo; lixo vira o default. */
export function clampInspectorWidth(value: number): number {
  if (!Number.isFinite(value)) return MISSION_INSPECTOR_WIDTH_DEFAULT;
  return Math.min(
    MISSION_INSPECTOR_WIDTH_MAX,
    Math.max(MISSION_INSPECTOR_WIDTH_MIN, Math.round(value)),
  );
}

function storage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readStoredInspectorWidth(): number {
  const store = storage();
  if (!store) return MISSION_INSPECTOR_WIDTH_DEFAULT;
  let raw: string | null;
  try {
    raw = store.getItem(MISSION_INSPECTOR_WIDTH_STORAGE_KEY);
  } catch {
    return MISSION_INSPECTOR_WIDTH_DEFAULT;
  }
  if (raw === null) return MISSION_INSPECTOR_WIDTH_DEFAULT;
  return clampInspectorWidth(Number.parseFloat(raw));
}

function persistInspectorWidth(width: number): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(MISSION_INSPECTOR_WIDTH_STORAGE_KEY, String(width));
  } catch {
    // Storage cheio ou bloqueado não pode travar o arraste em andamento.
  }
}

interface InspectorWidthStore {
  width: number;
  setWidth(width: number): void;
  reset(): void;
}

export const useInspectorWidthStore = create<InspectorWidthStore>((set) => ({
  width: readStoredInspectorWidth(),
  setWidth: (width) => {
    const next = clampInspectorWidth(width);
    persistInspectorWidth(next);
    set({ width: next });
  },
  reset: () => {
    persistInspectorWidth(MISSION_INSPECTOR_WIDTH_DEFAULT);
    set({ width: MISSION_INSPECTOR_WIDTH_DEFAULT });
  },
}));
