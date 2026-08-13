/**
 * Specialty routing — the missing axis between "how hard is this?" (task
 * tier) and "which CLI/model should run it?".
 *
 * WHY THIS EXISTS
 * ---------------
 * `classifyTask` only answers complexity. `classifyWorkKind` answers the
 * deliverable type (bug/feature/visual/…) for squads and design authority.
 * Neither one picks a provider. The live router therefore dumped every
 * medium worker on whatever led DEFAULT_ROUTING_TABLE (GLM), including a
 * three-pane fan-out that all resolved before any pane existed.
 *
 * This module is the stable vocabulary the router, the future Nexus
 * benchmark, and the UI can share:
 *   - classify the specialty ONCE
 *   - expose a heuristic prior (honest: not a measurement)
 *   - accept a benchmark table later without changing call sites
 *
 * HONESTY CONTRACT
 * ----------------
 * Heuristic adapter order is a prior, not a score. It must never be labeled
 * `nexus-eval` or `benchmark`. An empty benchmark specialty falls through to
 * the heuristic. `unknown` work with no security overlay is `general` — the
 * complexity table + squad diversity decide, we do not invent a winner.
 */

import { classifyWorkKind, type WorkKind } from './mission-work-kind';

export const ROUTE_SPECIALTIES = [
  'visual',
  'security',
  'bug',
  'feature',
  'doc',
  'ops',
  'general',
] as const;

export type RouteSpecialty = (typeof ROUTE_SPECIALTIES)[number];

export const ROUTE_POLICY_SOURCES = [
  'heuristic',
  'nexus-eval',
  'benchmark',
] as const;

export type RoutePolicySource = (typeof ROUTE_POLICY_SOURCES)[number];

export const ROUTE_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;
export type RouteEffort = (typeof ROUTE_EFFORTS)[number];

export interface SpecialtyBenchmarkEntry {
  readonly adapterId: string;
  readonly model?: string;
  readonly effort?: RouteEffort;
  /** 0..100. Only meaningful when source is a real benchmark revision. */
  readonly score?: number;
}

export interface SpecialtyBenchmark {
  readonly schemaVersion: 1;
  readonly source: string;
  readonly updatedAt?: string;
  readonly description?: string;
  readonly specialties: Partial<
    Record<RouteSpecialty, readonly SpecialtyBenchmarkEntry[]>
  >;
}

export interface RouteSpecialtyVerdict {
  readonly specialty: RouteSpecialty;
  readonly workKind: WorkKind;
  readonly confidence: 'high' | 'low';
  readonly reason: string;
}

export interface SpecialtyRoutePolicy {
  readonly specialty: RouteSpecialty;
  readonly source: Exclude<RoutePolicySource, 'nexus-eval'>;
  readonly preferAdapterIds: readonly string[];
  /** Minimum reasoning effort; never lowers a stronger table/eval pick. */
  readonly effortFloor?: RouteEffort;
}

/**
 * Empty published table. The eval pipeline will fill `specialties.visual`,
 * `.security`, etc. without a router rewrite. Until then every specialty
 * resolves as heuristic.
 */
export const EMPTY_SPECIALTY_BENCHMARK: SpecialtyBenchmark = Object.freeze({
  schemaVersion: 1,
  source: 'nexus-benchmark/unpublished',
  description:
    'Tabela vazia de propósito: o motor usa heurística até existir benchmark Nexus por especialidade.',
  specialties: Object.freeze({}),
});

/**
 * Soft CLI order per specialty. Not a quality score — a prior so UI work
 * does not default to the cheapest coding model and security work does not
 * stay on a fast-and-loose lead. Empty arrays mean "no prior; use the
 * complexity table + diversity".
 */
export const HEURISTIC_SPECIALTY_ADAPTERS: Readonly<
  Record<RouteSpecialty, readonly string[]>
> = Object.freeze({
  visual: Object.freeze(['agy', 'claude', 'codex']),
  security: Object.freeze(['claude', 'codex', 'kimi']),
  bug: Object.freeze(['codex', 'claude', 'grok']),
  feature: Object.freeze([]),
  doc: Object.freeze(['kimi', 'agy', 'grok']),
  ops: Object.freeze(['codex', 'claude', 'agy']),
  general: Object.freeze([]),
});

const HEURISTIC_EFFORT_FLOOR: Readonly<
  Partial<Record<RouteSpecialty, RouteEffort>>
> = Object.freeze({
  security: 'high',
  bug: 'high',
  ops: 'high',
  visual: 'medium',
});

/**
 * Security overlay — a feature/bug that is actually an auth/payment/secret
 * surface should not ride the generic coding ladder. Doc stays doc: writing
 * about auth is still a document.
 */
const SECURITY_SPECIALTY_SIGNALS = [
  'security',
  'cybersecurity',
  'ciberseg',
  'ciberata',
  'segurança',
  'seguranca',
  'vulnerab',
  'oauth',
  'auth',
  'autentica',
  'reautentic',
  'authoriza',
  'autoriza',
  'payment',
  'pagamento',
  'billing',
  'cobrança',
  'cobranca',
  'encrypt',
  'decrypt',
  'encripta',
  'reencript',
  'desencripta',
  'descriptografa',
  'rls',
  'multitenant',
  'secret',
] as const;

const securityMatchers = new Map<string, RegExp>();

function securityMatcher(signal: string): RegExp {
  let matcher = securityMatchers.get(signal);
  if (!matcher) {
    const escaped = signal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    matcher = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}`, 'u');
    securityMatchers.set(signal, matcher);
  }
  return matcher;
}

export function hasSecuritySpecialtySignals(text: string): boolean {
  const canonical = text.toLowerCase();
  return SECURITY_SPECIALTY_SIGNALS.some((signal) =>
    securityMatcher(signal).test(canonical),
  );
}

function workKindToSpecialty(kind: WorkKind): RouteSpecialty {
  switch (kind) {
    case 'visual':
    case 'bug':
    case 'feature':
    case 'doc':
    case 'ops':
      return kind;
    default:
      return 'general';
  }
}

/**
 * Compose work-kind + security overlay into the routing specialty.
 * Pure: same bytes in, same bytes out.
 */
export function classifyRouteSpecialty(taskText: string): RouteSpecialtyVerdict {
  const work = classifyWorkKind(taskText);
  const security = hasSecuritySpecialtySignals(taskText);
  if (security && work.kind !== 'doc' && work.kind !== 'visual') {
    return Object.freeze({
      specialty: 'security',
      workKind: work.kind,
      confidence: work.confidence === 'high' || work.kind === 'unknown'
        ? 'high'
        : work.confidence,
      reason: `overlay de segurança sobre work-kind ${work.kind}`,
    });
  }
  const specialty = workKindToSpecialty(work.kind);
  return Object.freeze({
    specialty,
    workKind: work.kind,
    confidence: work.confidence,
    reason: work.reason,
  });
}

const EFFORT_RANK: Readonly<Record<RouteEffort, number>> = Object.freeze({
  low: 0,
  medium: 1,
  high: 2,
  xhigh: 3,
});

export function isRouteEffort(value: string | undefined): value is RouteEffort {
  return (
    typeof value === 'string' &&
    (ROUTE_EFFORTS as readonly string[]).includes(value)
  );
}

/** Raise effort to the specialty floor; never lower a stronger pick. */
export function applyEffortFloor(
  current: string | undefined,
  floor: RouteEffort | undefined,
): string | undefined {
  if (!floor) return current;
  if (!isRouteEffort(current)) return floor;
  return EFFORT_RANK[current] >= EFFORT_RANK[floor] ? current : floor;
}

function uniqueAdapterIds(
  entries: readonly SpecialtyBenchmarkEntry[],
): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const entry of [...entries].sort(
    (left, right) => (right.score ?? 0) - (left.score ?? 0),
  )) {
    const id = entry.adapterId.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function isRouteSpecialty(value: unknown): value is RouteSpecialty {
  return (
    typeof value === 'string' &&
    (ROUTE_SPECIALTIES as readonly string[]).includes(value)
  );
}

/**
 * Rows only count as a measured prior when the table source is not a
 * placeholder or fixture dump. `unpublished` / `fixture` / `estimate` fall
 * through to the heuristic — otherwise Settings estimates would start
 * steering live routing under a `benchmark` label.
 */
export function specialtyBenchmarkIsMeasured(
  source: string | undefined,
): boolean {
  if (typeof source !== 'string' || source.trim().length === 0) return false;
  const segments = source.toLowerCase().split(/[\/._-]+/);
  return (
    !segments.includes('unpublished') &&
    !segments.includes('fixture') &&
    !segments.includes('estimate')
  );
}

/**
 * Resolve the adapter prior for a specialty. Benchmark rows, when present
 * for THAT specialty AND measured, win. Otherwise the heuristic prior.
 * Never invents scores.
 */
export function resolveSpecialtyPolicy(
  specialty: RouteSpecialty,
  benchmark: SpecialtyBenchmark | null | undefined = EMPTY_SPECIALTY_BENCHMARK,
): SpecialtyRoutePolicy {
  const rows = benchmark?.specialties[specialty];
  if (
    rows &&
    rows.length > 0 &&
    specialtyBenchmarkIsMeasured(benchmark?.source)
  ) {
    const preferAdapterIds = uniqueAdapterIds(rows);
    const topEffort = rows
      .slice()
      .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))[0]
      ?.effort;
    return Object.freeze({
      specialty,
      source: 'benchmark',
      preferAdapterIds: Object.freeze(preferAdapterIds),
      effortFloor:
        (isRouteEffort(topEffort) ? topEffort : undefined) ??
        HEURISTIC_EFFORT_FLOOR[specialty],
    });
  }
  return Object.freeze({
    specialty,
    source: 'heuristic',
    preferAdapterIds: HEURISTIC_SPECIALTY_ADAPTERS[specialty],
    effortFloor: HEURISTIC_EFFORT_FLOOR[specialty],
  });
}

/**
 * Stable partition: preferred adapters (policy order) then the rest
 * (original relative order). Empty prefer list is a no-op.
 */
export function preferAdapterOrder<T>(
  items: readonly T[],
  adapterIdOf: (item: T) => string,
  preferred: readonly string[],
): T[] {
  if (preferred.length === 0) return [...items];
  const rank = new Map(preferred.map((id, index) => [id, index]));
  const head: T[] = [];
  const tail: T[] = [];
  for (const item of items) {
    if (rank.has(adapterIdOf(item))) head.push(item);
    else tail.push(item);
  }
  head.sort(
    (left, right) =>
      (rank.get(adapterIdOf(left)) ?? 0) - (rank.get(adapterIdOf(right)) ?? 0),
  );
  return [...head, ...tail];
}
