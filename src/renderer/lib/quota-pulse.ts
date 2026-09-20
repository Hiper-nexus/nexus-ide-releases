/**
 * Pure layout math for the Fleet Pulse reset timeline (tests drive these).
 * A horizon de 7 dias é o mesmo teto da janela semanal — o eixo responde
 * "quando a conta mais apertada respira de novo?" sem inventar dado.
 */

import type { ProviderQuotaEntry } from '../../shared/quota-types';
import { effectiveUsedRatio } from '../../shared/quota-headroom';

export const PULSE_HORIZON_MS = 7 * 24 * 60 * 60_000;

export type PulseTone = 'ok' | 'warn' | 'danger';

export interface PulseMarker {
  entryId: string;
  adapterId: string;
  windowLabel: string;
  resetsAt: number;
  /** 0..1 na horizon; clamp em 1 quando passa do teto. */
  position: number;
  beyondHorizon: boolean;
  tone: PulseTone;
  usedRatio: number;
}

export interface PulseTick {
  /** 0..1 na horizon. */
  position: number;
  label: string;
}

function toneFor(usedRatio: number): PulseTone {
  if (usedRatio >= 0.8) return 'danger';
  if (usedRatio >= 0.5) return 'warn';
  return 'ok';
}

/**
 * A janela decisiva com reset conhecido: a de maior uso efetivo
 * (mesma aritmética do scorer — crédito de reset ≤60min).
 */
function decisiveWithReset(
  entry: ProviderQuotaEntry,
  now: number,
): { windowLabel: string; resetsAt: number; usedRatio: number } | null {
  let worst: {
    windowLabel: string;
    resetsAt: number;
    usedRatio: number;
    effective: number;
  } | null = null;
  for (const w of entry.windows) {
    if (w.resetsAt === undefined || w.usedRatio === null || w.usedRatio === undefined) {
      continue;
    }
    const effective = effectiveUsedRatio(w, now) ?? w.usedRatio;
    if (!worst || effective > worst.effective) {
      worst = {
        windowLabel: w.label,
        resetsAt: w.resetsAt,
        usedRatio: w.usedRatio,
        effective,
      };
    }
  }
  return worst
    ? {
        windowLabel: worst.windowLabel,
        resetsAt: worst.resetsAt,
        usedRatio: worst.usedRatio,
      }
    : null;
}

export function buildPulseMarkers(
  entries: ReadonlyArray<ProviderQuotaEntry>,
  now: number,
  horizonMs = PULSE_HORIZON_MS,
): PulseMarker[] {
  const markers: PulseMarker[] = [];
  for (const entry of entries) {
    const decisive = decisiveWithReset(entry, now);
    if (!decisive) continue;
    const msLeft = decisive.resetsAt - now;
    const beyondHorizon = msLeft > horizonMs;
    markers.push({
      entryId: entry.id,
      adapterId: entry.adapterId,
      windowLabel: decisive.windowLabel,
      resetsAt: decisive.resetsAt,
      position: Math.min(1, Math.max(0, msLeft / horizonMs)),
      beyondHorizon,
      tone: toneFor(decisive.usedRatio),
      usedRatio: decisive.usedRatio,
    });
  }
  return markers.sort((a, b) => a.position - b.position);
}

/** Eixo: marcas em 1h, 6h, 1d, 2d, 4d e o teto de 7d. */
export function buildPulseTicks(horizonMs = PULSE_HORIZON_MS): PulseTick[] {
  const spec: Array<{ offsetMs: number; label: string }> = [
    { offsetMs: 60 * 60_000, label: '1h' },
    { offsetMs: 6 * 60 * 60_000, label: '6h' },
    { offsetMs: 24 * 60 * 60_000, label: '1d' },
    { offsetMs: 2 * 24 * 60 * 60_000, label: '2d' },
    { offsetMs: 4 * 24 * 60 * 60_000, label: '4d' },
    { offsetMs: horizonMs, label: '7d' },
  ];
  return spec.map(({ offsetMs, label }) => ({
    position: Math.min(1, offsetMs / horizonMs),
    label,
  }));
}
