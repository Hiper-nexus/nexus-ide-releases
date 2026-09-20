/**
 * Build the public ranking DTO from catalog quality blocks and/or rank results.
 * Safe for landing pages: no secrets, accounts, or private paths.
 */

import type { ModelCatalog } from '../adapters/model-catalog';
import {
  PUBLIC_MODEL_RANKING_SCHEMA_VERSION,
  type PublicModelRankingEntry,
  type PublicModelRankingSnapshot,
} from '../../shared/eval-ranking-types';
import type { ModelRankResult } from './suite-types';
import { toModelQualityEvaluation } from './ranker';

const PUBLIC_DESCRIPTION =
  'Nexus multi-dimension LLM ranking (coding, reasoning, frontend, security). ' +
  'Produced by the nexus-eval suite for automatic routing and public comparison.';

function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Parse suite id / revision from `nexus-eval/<suite>/<rev>` sources. */
export function parseEvalSource(
  source: string,
): { suiteId: string; suiteRevision: string } | null {
  const m = /^nexus-eval\/([A-Za-z0-9._-]+)(?:\/([A-Za-z0-9._-]+))?$/.exec(
    source.trim(),
  );
  if (!m) return null;
  return { suiteId: m[1]!, suiteRevision: m[2] ?? 'unknown' };
}

/**
 * Suite revisions produced by the offline fixture pipeline — estimates, never
 * real audits. A future live evaluation ships a run id (git-ish) instead and
 * never matches this set.
 */
const FIXTURE_SUITE_REVISIONS: ReadonlySet<string> = new Set([
  'fixture',
  'offline-fixture',
]);

/** Public badge copy stamped on fixture-derived entries (UI copy is pt-BR). */
export const FIXTURE_ESTIMATE_SOURCE_LABEL = 'estimativa (fixture)';

/** True when the nexus-eval source names an offline fixture revision. */
export function isFixtureEvalSource(source: string): boolean {
  const parsed = parseEvalSource(source);
  return parsed !== null && FIXTURE_SUITE_REVISIONS.has(parsed.suiteRevision);
}

/**
 * Stamp the estimate mark on fixture-derived entries (idempotent). Real-audit
 * entries pass through untouched, so a future live evaluation never carries
 * the mark.
 */
export function withFixtureEstimateMark(
  entry: PublicModelRankingEntry,
): PublicModelRankingEntry {
  if (!isFixtureEvalSource(entry.source)) return entry;
  return {
    ...entry,
    estimate: true,
    sourceLabel: entry.sourceLabel ?? FIXTURE_ESTIMATE_SOURCE_LABEL,
  };
}

export function latestEvaluatedAt(
  entries: readonly PublicModelRankingEntry[],
): string | undefined {
  let best: string | undefined;
  let bestMs = -Infinity;
  for (const e of entries) {
    const ms = Date.parse(e.evaluatedAt);
    if (!Number.isNaN(ms) && ms >= bestMs) {
      bestMs = ms;
      best = e.evaluatedAt;
    }
  }
  return best;
}

/**
 * Uma entrada por id (a primeira vence — os fluxos chegam ordenados por
 * overall desc), com rank renumerado denso. Catálogos já deduplicam por id,
 * mas payloads pré-construídos (model-ranking.json empacotado) podem carregar
 * resíduo de régens — e o React pinta "two children with the same key" na
 * corrida do ranking.
 */
export function dedupeRankingEntries(
  entries: readonly PublicModelRankingEntry[],
): PublicModelRankingEntry[] {
  const byId = new Map<string, PublicModelRankingEntry>();
  for (const e of entries) {
    if (!byId.has(e.id)) byId.set(e.id, e);
  }
  return [...byId.values()].map((e, i) => ({ ...e, rank: i + 1 }));
}

export function publicEntriesFromRanks(
  ranks: readonly ModelRankResult[],
): PublicModelRankingEntry[] {
  const sorted = [...ranks].sort((a, b) => b.overall - a.overall);
  return sorted.map((rank, index) => {
    const q = toModelQualityEvaluation(rank);
    return {
      id: `${rank.subject.adapterId}/${rank.subject.modelId}`,
      adapterId: rank.subject.adapterId,
      modelId: rank.subject.modelId,
      overall: clampScore(q.overall),
      coding: q.coding !== undefined ? clampScore(q.coding) : undefined,
      reasoning: q.reasoning !== undefined ? clampScore(q.reasoning) : undefined,
      frontend: q.frontend !== undefined ? clampScore(q.frontend) : undefined,
      security: q.security !== undefined ? clampScore(q.security) : undefined,
      costTier: rank.subject.costTier,
      availability: rank.subject.availability,
      evaluatedAt: q.evaluatedAt,
      source: q.source,
      confidence: rank.confidence,
      rank: index + 1,
    };
  });
}

/**
 * Read quality blocks already present on a ModelCatalog (after normalizer).
 * Used by the in-app API so UI and landing share the same catalog truth.
 */
export function publicEntriesFromCatalog(
  catalog: ModelCatalog,
): PublicModelRankingEntry[] {
  const entries: PublicModelRankingEntry[] = [];
  for (const [adapterId, adapter] of Object.entries(catalog.adapters ?? {})) {
    for (const model of adapter.models ?? []) {
      const q = model.quality;
      if (!q || typeof q.overall !== 'number') continue;
      if (!q.source?.startsWith('nexus-eval/')) continue;
      if (typeof q.evaluatedAt !== 'string' || Number.isNaN(Date.parse(q.evaluatedAt))) {
        continue;
      }
      entries.push({
        id: `${adapterId}/${model.id}`,
        adapterId,
        modelId: model.id,
        overall: clampScore(q.overall),
        coding: q.coding !== undefined ? clampScore(q.coding) : undefined,
        reasoning: q.reasoning !== undefined ? clampScore(q.reasoning) : undefined,
        frontend: q.frontend !== undefined ? clampScore(q.frontend) : undefined,
        security: q.security !== undefined ? clampScore(q.security) : undefined,
        costTier: model.costTier,
        availability: model.availability,
        evaluatedAt: q.evaluatedAt,
        source: q.source,
      });
    }
  }
  entries.sort((a, b) => b.overall - a.overall);
  return entries.map((e, i) => ({ ...e, rank: i + 1 }));
}

export function buildPublicRankingSnapshot(input: {
  entries: PublicModelRankingEntry[];
  suiteId: string;
  suiteRevision: string;
  generatedAt?: string;
}): PublicModelRankingSnapshot {
  const generatedAt =
    input.generatedAt ??
    latestEvaluatedAt(input.entries) ??
    new Date().toISOString();
  return {
    schemaVersion: PUBLIC_MODEL_RANKING_SCHEMA_VERSION,
    generatedAt,
    suiteId: input.suiteId,
    suiteRevision: input.suiteRevision,
    description: PUBLIC_DESCRIPTION,
    entries: dedupeRankingEntries(
      input.entries.map((e, i) =>
        withFixtureEstimateMark({
          ...e,
          overall: clampScore(e.overall),
          rank: e.rank ?? i + 1,
        }),
      ),
    ),
  };
}

export function buildPublicRankingFromRanks(
  ranks: readonly ModelRankResult[],
  suiteId: string,
  suiteRevision: string,
  generatedAt?: string,
): PublicModelRankingSnapshot {
  return buildPublicRankingSnapshot({
    entries: publicEntriesFromRanks(ranks),
    suiteId,
    suiteRevision,
    generatedAt,
  });
}

export function buildPublicRankingFromCatalog(
  catalog: ModelCatalog,
  suiteId?: string,
  suiteRevision?: string,
  generatedAt?: string,
): PublicModelRankingSnapshot {
  const entries = publicEntriesFromCatalog(catalog);
  const parsed = entries[0] ? parseEvalSource(entries[0].source) : null;
  return buildPublicRankingSnapshot({
    entries,
    suiteId: suiteId ?? parsed?.suiteId ?? 'v1',
    suiteRevision: suiteRevision ?? parsed?.suiteRevision ?? 'unknown',
    generatedAt: generatedAt ?? latestEvaluatedAt(entries),
  });
}

/** Validate a raw JSON payload before exposing it as public ranking. */
export function isPublicModelRankingSnapshot(
  raw: unknown,
): raw is PublicModelRankingSnapshot {
  if (!raw || typeof raw !== 'object') return false;
  const o = raw as Partial<PublicModelRankingSnapshot>;
  if (o.schemaVersion !== PUBLIC_MODEL_RANKING_SCHEMA_VERSION) return false;
  if (typeof o.generatedAt !== 'string') return false;
  if (typeof o.suiteId !== 'string' || typeof o.suiteRevision !== 'string') {
    return false;
  }
  if (typeof o.description !== 'string') return false;
  if (!Array.isArray(o.entries)) return false;
  return o.entries.every((e) => {
    if (!e || typeof e !== 'object') return false;
    // Optional estimate mark (schema v1 extension): type-checked when present,
    // absent on pre-mark payloads — both shapes stay valid.
    if (e.estimate !== undefined && typeof e.estimate !== 'boolean') return false;
    if (e.sourceLabel !== undefined && typeof e.sourceLabel !== 'string') {
      return false;
    }
    return (
      typeof e.id === 'string' &&
      typeof e.adapterId === 'string' &&
      typeof e.modelId === 'string' &&
      typeof e.overall === 'number' &&
      e.overall >= 0 &&
      e.overall <= 100 &&
      typeof e.evaluatedAt === 'string' &&
      typeof e.source === 'string' &&
      e.source.startsWith('nexus-eval/')
    );
  });
}
