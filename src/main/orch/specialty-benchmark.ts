/**
 * Load the specialty benchmark the router consults before the heuristic prior.
 *
 * Published file (bundled) starts empty on purpose. A user overlay at
 * ~/.nexus/mission-specialty-benchmark.json wins per-specialty when it has
 * rows — that is the slot the upcoming Nexus benchmark write path fills.
 *
 * Not imported by task-router (keeps unit tests off the operator's disk).
 * tools-domain injects the merged table into RouteContext.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import publishedRaw from '../../../resources/mission-specialty-benchmark.json';
import {
  EMPTY_SPECIALTY_BENCHMARK,
  isRouteEffort,
  isRouteSpecialty,
  type RouteSpecialty,
  type SpecialtyBenchmark,
  type SpecialtyBenchmarkEntry,
} from '../../shared/mission-route-specialty';

export const USER_SPECIALTY_BENCHMARK_FILE = path.join(
  os.homedir(),
  '.nexus',
  'mission-specialty-benchmark.json',
);

function parseEntries(raw: unknown): SpecialtyBenchmarkEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: SpecialtyBenchmarkEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (typeof row.adapterId !== 'string' || row.adapterId.trim().length === 0) {
      continue;
    }
    const score =
      typeof row.score === 'number' &&
      Number.isFinite(row.score) &&
      row.score >= 0 &&
      row.score <= 100
        ? row.score
        : undefined;
    const effort =
      typeof row.effort === 'string' && isRouteEffort(row.effort)
        ? row.effort
        : undefined;
    const model =
      typeof row.model === 'string' && row.model.trim().length > 0
        ? row.model.trim()
        : undefined;
    entries.push({
      adapterId: row.adapterId.trim(),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(score !== undefined ? { score } : {}),
    });
  }
  return entries;
}

export function parseSpecialtyBenchmark(raw: unknown): SpecialtyBenchmark | null {
  if (!raw || typeof raw !== 'object') return null;
  const input = raw as Record<string, unknown>;
  if (input.schemaVersion !== 1) return null;
  if (typeof input.source !== 'string' || input.source.trim().length === 0) {
    return null;
  }
  const specialties: SpecialtyBenchmark['specialties'] = {};
  const bag =
    input.specialties && typeof input.specialties === 'object'
      ? (input.specialties as Record<string, unknown>)
      : {};
  for (const [key, value] of Object.entries(bag)) {
    if (!isRouteSpecialty(key)) continue;
    const entries = parseEntries(value);
    if (entries.length > 0) {
      specialties[key as RouteSpecialty] = entries;
    }
  }
  return {
    schemaVersion: 1,
    source: input.source.trim(),
    ...(typeof input.updatedAt === 'string' ? { updatedAt: input.updatedAt } : {}),
    ...(typeof input.description === 'string'
      ? { description: input.description }
      : {}),
    specialties,
  };
}

// A6 (perf spawn): o overlay do operador era relido (stat + read + parse) a
// cada rota. Cache por mtime — arquivo imutável entre spawns reaproveita o
// parse; qualquer escrita (mtime novo) invalida.
let overlayCache: { mtimeMs: number; value: SpecialtyBenchmark | null } | undefined;

/** Test hook. */
export function __resetSpecialtyBenchmarkCacheForTests(): void {
  overlayCache = undefined;
}

function readUserOverlay(): SpecialtyBenchmark | null {
  try {
    const stat = fs.statSync(USER_SPECIALTY_BENCHMARK_FILE);
    // mtime.getTime() (ms inteiro): utimesSync e Date truncam para ms;
    // comparar mtimeMs cru (float sub-ms no APFS) nunca casava.
    const mtimeMs = stat.mtime.getTime();
    if (overlayCache && overlayCache.mtimeMs === mtimeMs) return overlayCache.value;
    const raw: unknown = JSON.parse(
      fs.readFileSync(USER_SPECIALTY_BENCHMARK_FILE, 'utf8'),
    );
    const value = parseSpecialtyBenchmark(raw);
    overlayCache = { mtimeMs, value };
    return value;
  } catch {
    return null;
  }
}

function mergeSpecialtyBenchmarks(
  base: SpecialtyBenchmark,
  overlay: SpecialtyBenchmark | null,
): SpecialtyBenchmark {
  if (!overlay) return base;
  return {
    schemaVersion: 1,
    source: overlay.source || base.source,
    updatedAt: overlay.updatedAt ?? base.updatedAt,
    description: overlay.description ?? base.description,
    specialties: { ...base.specialties, ...overlay.specialties },
  };
}

const publishedBenchmark =
  parseSpecialtyBenchmark(publishedRaw) ?? EMPTY_SPECIALTY_BENCHMARK;

/**
 * Published table plus optional operator overlay. Overlay specialties replace
 * the published ones of the same id; missing overlay keys keep the published
 * (still empty today).
 */
export function loadSpecialtyBenchmark(): SpecialtyBenchmark {
  return mergeSpecialtyBenchmarks(publishedBenchmark, readUserOverlay());
}
