/**
 * Pure ranking view math — radar points, mission picks, cost efficiency.
 * No React; unit-tested so the ops surface stays honest about scores.
 */

import type {
  PublicModelRankingEntry,
  RankingQualityDimension,
} from '../../../shared/eval-ranking-types';

export type SortKey = RankingQualityDimension;

export const SORT_LABELS: Record<SortKey, string> = {
  overall: 'Overall',
  coding: 'Coding',
  reasoning: 'Reasoning',
  frontend: 'Frontend',
  security: 'Security',
};

export const SORT_MISSION: Record<SortKey, string> = {
  overall: 'Default do roteador',
  coding: 'Missões de código / refactor',
  reasoning: 'Arquitetura e análise profunda',
  frontend: 'UI, design systems, browser',
  security: 'Review e hardening',
};

export const RADAR_AXES: SortKey[] = [
  'overall',
  'coding',
  'reasoning',
  'frontend',
  'security',
];

export function scoreOf(
  entry: PublicModelRankingEntry,
  key: SortKey,
): number | null {
  const v = entry[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function scoreOrZero(entry: PublicModelRankingEntry, key: SortKey): number {
  return scoreOf(entry, key) ?? 0;
}

export function sortEntries(
  entries: readonly PublicModelRankingEntry[],
  key: SortKey,
): PublicModelRankingEntry[] {
  return [...entries].sort((a, b) => {
    const sa = scoreOf(a, key) ?? -1;
    const sb = scoreOf(b, key) ?? -1;
    if (sb !== sa) return sb - sa;
    return a.modelId.localeCompare(b.modelId);
  });
}

/** Best model for a mission dimension (requires a real score on that axis). */
export function pickForDimension(
  entries: readonly PublicModelRankingEntry[],
  key: SortKey,
): PublicModelRankingEntry | null {
  const ranked = sortEntries(entries, key).filter((e) => scoreOf(e, key) !== null);
  return ranked[0] ?? null;
}

/**
 * Best overall among low/cheap cost tiers — operational "value" pick.
 */
export function pickValue(
  entries: readonly PublicModelRankingEntry[],
): PublicModelRankingEntry | null {
  const cheap = entries.filter(
    (e) => e.costTier === 'low' || e.availability === 'cheap',
  );
  if (cheap.length === 0) return pickForDimension(entries, 'overall');
  return pickForDimension(cheap, 'overall');
}

/** Higher is better: overall / cost weight. */
export function costEfficiency(entry: PublicModelRankingEntry): number {
  const costWeight =
    entry.costTier === 'low' || entry.availability === 'cheap'
      ? 1
      : entry.costTier === 'medium'
        ? 1.6
        : entry.costTier === 'high'
          ? 2.4
          : 1.8;
  return Math.round((entry.overall / costWeight) * 10) / 10;
}

/**
 * Blend overall score with quota availability (0..1 free capacity).
 * Unknown quota (null) uses neutral 0.55 so we never invent a free ride.
 */
export function scoreWithQuota(
  entry: PublicModelRankingEntry,
  quotaAvailability: number | null,
): number {
  const q = quotaAvailability === null ? 0.55 : Math.max(0, Math.min(1, quotaAvailability));
  return Math.round(entry.overall * (0.65 + 0.35 * q) * 10) / 10;
}

export function sortEntriesWithQuota(
  entries: readonly PublicModelRankingEntry[],
  key: SortKey,
  quotaByAdapter: ReadonlyMap<string, number | null>,
): PublicModelRankingEntry[] {
  return [...entries].sort((a, b) => {
    if (key === 'overall') {
      const sa = scoreWithQuota(a, quotaByAdapter.get(a.adapterId) ?? null);
      const sb = scoreWithQuota(b, quotaByAdapter.get(b.adapterId) ?? null);
      if (sb !== sa) return sb - sa;
    } else {
      const sa = scoreOf(a, key) ?? -1;
      const sb = scoreOf(b, key) ?? -1;
      if (sb !== sa) return sb - sa;
    }
    return a.modelId.localeCompare(b.modelId);
  });
}

export interface RadarPoint {
  key: SortKey;
  label: string;
  score: number;
  x: number;
  y: number;
  /** Axis tip (score=100). */
  tipX: number;
  tipY: number;
}

/**
 * Polar layout for radar: center (cx,cy), radius r, scores 0..100.
 * Axis 0 points up (-Y).
 */
export function radarPoints(
  entry: PublicModelRankingEntry,
  cx: number,
  cy: number,
  r: number,
  axes: readonly SortKey[] = RADAR_AXES,
): RadarPoint[] {
  const n = axes.length;
  return axes.map((key, i) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    const score = scoreOrZero(entry, key);
    const t = Math.max(0, Math.min(100, score)) / 100;
    return {
      key,
      label: SORT_LABELS[key],
      score,
      x: cx + Math.cos(angle) * r * t,
      y: cy + Math.sin(angle) * r * t,
      tipX: cx + Math.cos(angle) * r,
      tipY: cy + Math.sin(angle) * r,
    };
  });
}

export function radarPolygon(points: readonly RadarPoint[]): string {
  if (points.length === 0) return '';
  return points.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
}

export function gridRingPath(
  cx: number,
  cy: number,
  r: number,
  axesCount: number,
  fraction: number,
): string {
  const pts: string[] = [];
  for (let i = 0; i < axesCount; i++) {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / axesCount;
    const x = cx + Math.cos(angle) * r * fraction;
    const y = cy + Math.sin(angle) * r * fraction;
    pts.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return pts.join(' ');
}

export function formatEvalTime(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toLocaleString();
}

export function costLabel(entry: PublicModelRankingEntry): string {
  if (entry.costTier) return entry.costTier;
  if (entry.availability) return entry.availability;
  return '—';
}
