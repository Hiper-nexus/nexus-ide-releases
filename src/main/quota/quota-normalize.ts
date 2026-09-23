/**
 * Pure builders for quota windows — no Electron, no invented percentages.
 */

import type {
  QuotaConfidence,
  QuotaSource,
  QuotaWindow,
  QuotaWindowKind,
} from '../../shared/quota-types';

export function clampRatio(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export function formatRemaining(ms: number, now = Date.now()): string {
  const left = Math.max(0, ms - now);
  const mins = Math.round(left / 60_000);
  if (mins < 60) return `${Math.max(1, mins)}min`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours < 48) return rem > 0 ? `${hours}h${rem}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const h = hours % 24;
  return h > 0 ? `${days}d${h}h` : `${days}d`;
}

/** Unknown window — UI shows "—" not 0%. */
export function unknownWindow(
  kind: QuotaWindowKind,
  label: string,
): QuotaWindow {
  return {
    kind,
    label,
    usedRatio: null,
    source: 'unknown',
    confidence: 'low',
  };
}

export function knownWindow(input: {
  kind: QuotaWindowKind;
  label: string;
  usedRatio: number;
  source: QuotaSource;
  confidence: QuotaConfidence;
  resetsAt?: number;
  now?: number;
}): QuotaWindow {
  const now = input.now ?? Date.now();
  return {
    kind: input.kind,
    label: input.label,
    usedRatio: clampRatio(input.usedRatio),
    source: input.source,
    confidence: input.confidence,
    resetsAt: input.resetsAt,
    remainingLabel:
      input.resetsAt !== undefined
        ? formatRemaining(input.resetsAt, now)
        : undefined,
  };
}

/** Exhausted until cooldown (after 429 / limit-hit). */
export function exhaustedWindow(input: {
  kind: QuotaWindowKind;
  label: string;
  resetsAt: number;
  source?: QuotaSource;
  now?: number;
}): QuotaWindow {
  return knownWindow({
    kind: input.kind,
    label: input.label,
    usedRatio: 1,
    source: input.source ?? 'limit-hit',
    confidence: 'medium',
    resetsAt: input.resetsAt,
    now: input.now,
  });
}

/**
 * Default shell for a CLI without telemetry: honest unknowns.
 * Majority of cloud LLMs share the same two windows: rolling **5 Horas** + **Semanal**.
 * Only pure-local (Ollama) differs.
 */
export function defaultUnknownWindows(
  adapterId: string,
): QuotaWindow[] {
  if (adapterId === 'mimo-code') return [unknownWindow('credits', 'Token Plan')];
  if (adapterId === 'ollama') {
    return [
      unknownWindow('local', 'Local'),
      unknownWindow('hours', '5 Horas'),
    ];
  }
  // Claude, Codex, GLM, Kimi, AGY, LongCat, OpenCode, Aider, custom…
  // Grok CLI OAuth exposes monthly billing (not 5h/weekly) — keep Mensal slot.
  if (adapterId === 'grok') {
    return [
      unknownWindow('hours', '5 Horas'),
      unknownWindow('weekly', 'Semanal'),
      unknownWindow('monthly', 'Mensal'),
    ];
  }
  return [
    unknownWindow('hours', '5 Horas'),
    unknownWindow('weekly', 'Semanal'),
  ];
}

/**
 * Merge probe windows over defaults: known ratios win; unknowns fill gaps.
 * Never demotes a known window to unknown when re-merging partial probes.
 */
export function mergeWindows(
  base: readonly QuotaWindow[],
  overlay: readonly QuotaWindow[],
): QuotaWindow[] {
  const byKind = new Map<string, QuotaWindow>();
  for (const w of base) byKind.set(`${w.kind}:${w.label}`, w);
  for (const w of overlay) {
    const key = `${w.kind}:${w.label}`;
    const prev = byKind.get(key);
    if (!prev || prev.usedRatio === null || w.usedRatio !== null) {
      byKind.set(key, w);
    }
  }
  // Prefer stable order: 5h first (majority LLM UX), then weekly, rest.
  const order: QuotaWindowKind[] = [
    'hours',
    'weekly',
    'session',
    'monthly',
    'credits',
    'local',
  ];
  return dropPlaceholderUnknowns([...byKind.values()]).sort(
    (a, b) => order.indexOf(a.kind) - order.indexOf(b.kind),
  );
}

const PLACEHOLDER_LABEL: Partial<Record<QuotaWindowKind, string>> = {
  hours: '5 Horas',
  weekly: 'Semanal',
  monthly: 'Mensal',
};

/**
 * «5 Horas · Sem leitura» ao lado de «Gemini Models · 5 Horas · 3%» é a
 * mesma janela duas vezes: o molde genérico ficou porque o rótulo real é
 * mais específico. Se a cadência já tem leitura, o molde sai.
 */
function dropPlaceholderUnknowns(windows: QuotaWindow[]): QuotaWindow[] {
  return windows.filter((window) => {
    if (window.usedRatio !== null) return true;
    const placeholder = PLACEHOLDER_LABEL[window.kind];
    if (!placeholder || window.label !== placeholder) return true;
    return !windows.some(
      (other) =>
        other !== window &&
        other.kind === window.kind &&
        other.usedRatio !== null,
    );
  });
}
