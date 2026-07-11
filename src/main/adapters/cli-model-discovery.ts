import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Adapter } from '../../shared/adapter-types';

export interface CliModelCacheSource {
  adapterId: string;
  files: string[];
}

const home = os.homedir();

/**
 * Model caches owned by the CLIs themselves. Missing files are expected: a
 * provider starts participating automatically as soon as its CLI creates one.
 */
export const CLI_MODEL_CACHE_SOURCES: CliModelCacheSource[] = [
  { adapterId: 'codex', files: [path.join(home, '.codex', 'models_cache.json')] },
  { adapterId: 'grok', files: [path.join(home, '.grok', 'models_cache.json')] },
  { adapterId: 'claude', files: [path.join(home, '.claude', 'models_cache.json')] },
  { adapterId: 'agy', files: [path.join(home, '.gemini', 'models_cache.json')] },
  { adapterId: 'kimi', files: [path.join(home, '.kimi', 'models_cache.json')] },
  {
    adapterId: 'opencode',
    files: [
      path.join(home, '.cache', 'opencode', 'models.json'),
      path.join(home, '.config', 'opencode', 'models.json'),
    ],
  },
];

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}$/;

function modelId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (row.visibility === 'hidden' || row.hidden === true) return null;
  if (row.info && typeof row.info === 'object') {
    return modelId(row.info);
  }
  for (const key of ['slug', 'id', 'model', 'name']) {
    const candidate = typeof row[key] === 'string' ? row[key].trim() : '';
    if (MODEL_ID.test(candidate)) return candidate;
  }
  return null;
}

export function readCliModelCache(file: string): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    const models = raw && typeof raw === 'object'
      ? (raw as { models?: unknown }).models
      : undefined;
    const rows = Array.isArray(raw)
      ? raw
      : Array.isArray(models)
        ? models
        : models && typeof models === 'object'
          ? Object.entries(models as Record<string, unknown>).map(([id, value]) =>
              value && typeof value === 'object' ? { id, ...(value as object) } : { id },
            )
          : [];
    return [...new Set(rows.map(modelId).filter((id): id is string => id !== null))];
  } catch {
    return [];
  }
}

const EFFORT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

/**
 * Read reasoning levels advertised by the CLI's own model cache. Codex, for
 * example, publishes `supported_reasoning_levels` per model. Keeping this
 * separate from model ids lets older/other CLI cache shapes degrade safely.
 */
export function readCliEfforts(file: string): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    const models = raw && typeof raw === 'object'
      ? (raw as { models?: unknown }).models
      : undefined;
    const rows = Array.isArray(raw)
      ? raw
      : Array.isArray(models)
        ? models
        : models && typeof models === 'object'
          ? Object.values(models as Record<string, unknown>)
          : [];
    const levels = new Set<string>();
    for (const value of rows) {
      if (!value || typeof value !== 'object') continue;
      const row = value as Record<string, unknown>;
      const advertised = row.supported_reasoning_levels ?? row.reasoning_levels;
      if (!Array.isArray(advertised)) continue;
      for (const entry of advertised) {
        const effort = typeof entry === 'string'
          ? entry.trim()
          : entry && typeof entry === 'object' && typeof (entry as { effort?: unknown }).effort === 'string'
            ? (entry as { effort: string }).effort.trim()
            : '';
        if (EFFORT_ID.test(effort)) levels.add(effort);
      }
    }
    return [...levels];
  } catch {
    return [];
  }
}

export function discoverCliModels(
  sources: readonly CliModelCacheSource[] = CLI_MODEL_CACHE_SOURCES,
): Map<string, string[]> {
  const discovered = new Map<string, string[]>();
  for (const source of sources) {
    const ids = new Set<string>();
    for (const file of source.files) {
      for (const id of readCliModelCache(file)) ids.add(id);
    }
    if (ids.size > 0) discovered.set(source.adapterId, [...ids]);
  }
  return discovered;
}

export function discoverCliEfforts(
  sources: readonly CliModelCacheSource[] = CLI_MODEL_CACHE_SOURCES,
): Map<string, string[]> {
  const discovered = new Map<string, string[]>();
  for (const source of sources) {
    const levels = new Set<string>();
    for (const file of source.files) {
      for (const effort of readCliEfforts(file)) levels.add(effort);
    }
    if (levels.size > 0) discovered.set(source.adapterId, [...levels]);
  }
  return discovered;
}

export function applyDiscoveredEffortsToAdapter(
  adapter: Adapter,
  discovered: ReadonlyMap<string, readonly string[]>,
): Adapter {
  if (adapter.kind !== 'cli-pty' || !adapter.control?.effort) return adapter;
  const live = discovered.get(adapter.id) ?? [];
  if (live.length === 0) return adapter;
  return {
    ...adapter,
    control: {
      ...adapter.control,
      effort: {
        ...adapter.control.effort,
        levels: [...new Set([...adapter.control.effort.levels, ...live])],
      },
    },
  };
}

export function applyDiscoveredModelsToAdapter(
  adapter: Adapter,
  discovered: ReadonlyMap<string, readonly string[]>,
): Adapter {
  const live = discovered.get(adapter.id) ?? [];
  if (live.length === 0) return adapter;
  const list = [...new Set([...adapter.models.list, ...live])];
  return {
    ...adapter,
    models: {
      ...adapter.models,
      list,
    },
  };
}

export function cliModelCacheDirectories(
  sources: readonly CliModelCacheSource[] = CLI_MODEL_CACHE_SOURCES,
): string[] {
  return [...new Set(sources.flatMap((source) => source.files.map(path.dirname)))];
}
