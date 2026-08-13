/**
 * Operational model bands — the Overclock inheritance that our ranking
 * was missing.
 *
 * Overclock's `overclock_model_list` is not a leaderboard. It is three
 * cost/depth bands plus the rule "default DOWN, scale UP only with a
 * concrete reason". Their site says the same thing as product thesis:
 * do not burn an expensive model on mechanical work; assemble the
 * harness (agent + model + effort) by task type.
 *
 * Nexus already had a race chart of fixture estimates and an empty
 * specialty-benchmark table. Those must not become "measured" scores.
 * Bands are derived from catalog cost/availability — real operational
 * facts — and never from `nexus-eval/.../fixture`.
 */

import {
  classifyRouteSpecialty,
  type RouteEffort,
  type RouteSpecialty,
} from './mission-route-specialty';

export const OPERATIONAL_BANDS = ['fast', 'balanced', 'deep'] as const;
export type OperationalBand = (typeof OPERATIONAL_BANDS)[number];

export const OPERATIONAL_BAND_LABELS: Readonly<Record<OperationalBand, string>> =
  Object.freeze({
    fast: 'Rápido',
    balanced: 'Equilibrado',
    deep: 'Profundo',
  });

export const OPERATIONAL_DOCTRINE = Object.freeze({
  rule: 'default-down' as const,
  summary:
    'Escolha a faixa mais barata que resolve. Escale UP só com razão concreta ' +
    '(contrato compartilhado, traço difícil entre arquivos, security). ' +
    'Effort é profundidade-de-raciocínio-por-turno, não importância da missão.',
  bands: Object.freeze({
    fast: 'mecânico e repetitivo: grep, lookup, recon, doc, typo',
    balanced: 'padrão — feature, visual, plano que ainda não é contrato',
    deep: 'design-defining: contrato compartilhado, security, bug difícil, ops de produção',
  }),
});

export interface BandClassifiable {
  readonly costTier?: string | null;
  readonly availability?: string | null;
}

/**
 * Cost/availability → band. Unknown defaults to balanced (DOWN, not UP).
 * `api-only` / `deprecated` still classify; the router already blocks them.
 */
export function classifyOperationalBand(
  input: BandClassifiable | null | undefined,
): OperationalBand {
  const cost = input?.costTier ?? undefined;
  const availability = input?.availability ?? undefined;
  if (
    availability === 'free' ||
    availability === 'cheap' ||
    cost === 'free' ||
    cost === 'low'
  ) {
    return 'fast';
  }
  if (cost === 'high') return 'deep';
  if (cost === 'medium') return 'balanced';
  return 'balanced';
}

export function bandForSpecialty(specialty: RouteSpecialty): OperationalBand {
  switch (specialty) {
    case 'doc':
      return 'fast';
    case 'security':
    case 'bug':
    case 'ops':
      return 'deep';
    default:
      return 'balanced';
  }
}

export function effortForBand(band: OperationalBand): RouteEffort {
  switch (band) {
    case 'fast':
      return 'low';
    case 'deep':
      return 'high';
    default:
      return 'medium';
  }
}

/** Next cheaper band. Never escalates — Overclock default DOWN. */
export function degradeOperationalBand(
  band: OperationalBand,
): OperationalBand | null {
  if (band === 'deep') return 'balanced';
  if (band === 'balanced') return 'fast';
  return null;
}

export function isOperationalBand(value: unknown): value is OperationalBand {
  return (
    typeof value === 'string' &&
    (OPERATIONAL_BANDS as readonly string[]).includes(value)
  );
}

/**
 * Stable partition: items in the target band keep relative order and
 * come first. Empty list / unknown bands are a no-op.
 */
export function preferOperationalBand<T>(
  items: readonly T[],
  bandOf: (item: T) => OperationalBand | null | undefined,
  target: OperationalBand,
): T[] {
  if (items.length === 0) return [];
  const head: T[] = [];
  const tail: T[] = [];
  for (const item of items) {
    if (bandOf(item) === target) head.push(item);
    else tail.push(item);
  }
  return head.length === 0 ? [...items] : [...head, ...tail];
}

export interface BandPick<T> {
  readonly item: T;
  readonly band: OperationalBand;
  /** True when the target band was empty and we stepped DOWN. */
  readonly degraded: boolean;
}

/**
 * Pick the first item in `target`, else the next cheaper band.
 * Never walks UP. Empty pool → null.
 */
export function pickForBandWithDegrade<T>(
  items: readonly T[],
  bandOf: (item: T) => OperationalBand | null | undefined,
  target: OperationalBand,
): BandPick<T> | null {
  let band: OperationalBand | null = target;
  let degraded = false;
  while (band) {
    const hit = items.find((item) => bandOf(item) === band);
    if (hit) {
      return Object.freeze({ item: hit, band, degraded });
    }
    const next = degradeOperationalBand(band);
    if (next) degraded = true;
    band = next;
  }
  return null;
}

export function groupByOperationalBand<T>(
  items: readonly T[],
  bandOf: (item: T) => OperationalBand | null | undefined,
): Readonly<Record<OperationalBand, readonly T[]>> {
  const groups: Record<OperationalBand, T[]> = {
    fast: [],
    balanced: [],
    deep: [],
  };
  for (const item of items) {
    const band = bandOf(item);
    if (band) groups[band].push(item);
  }
  return Object.freeze({
    fast: Object.freeze(groups.fast),
    balanced: Object.freeze(groups.balanced),
    deep: Object.freeze(groups.deep),
  });
}

/**
 * Resolve the operational target from a free-text need (specialty
 * classifier) plus an optional explicit band override.
 */
export function resolveNeedBand(
  need: string | undefined,
  bandOverride?: OperationalBand,
): {
  readonly specialty: RouteSpecialty | null;
  readonly band: OperationalBand;
} {
  if (bandOverride) {
    const specialty = need?.trim()
      ? classifyRouteSpecialty(need).specialty
      : null;
    return Object.freeze({ specialty, band: bandOverride });
  }
  if (need && need.trim().length > 0) {
    const specialty = classifyRouteSpecialty(need).specialty;
    return Object.freeze({
      specialty,
      band: bandForSpecialty(specialty),
    });
  }
  return Object.freeze({ specialty: null, band: 'balanced' });
}
