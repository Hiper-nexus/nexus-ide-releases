import { readRegularFileCappedAsync } from '../redline/redline-safe-read';
import type { PeriodicTaskContext } from '../observability/periodic-task';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Adapter } from '../../shared/adapter-types';
import { MODEL_ID_PATTERN } from '../../shared/model-id';
import { parseKimiConfigModelAliases } from './kimi-runtime-env';
import { readQwenSettingsSummary, readQwenSettingsSummaryAsync } from './qwen-settings';
import { cachedCliBinaryVersion, resolveCliBinary } from '../path-resolver';
import { compareAppVersions, isValidAppVersion } from '../../shared/app-version';
import { modelListAuthority } from './model-availability';

export interface CliModelCacheReadOptions {
  /** Version of the resolved binary, never a synchronous CLI probe. */
  clientVersion?: string | null | (() => string | null | undefined);
}

export interface CliModelCacheSource {
  adapterId: string;
  files: string[];
  /** Custom reader for non-`models`-shaped files (e.g. Qwen settings.json). */
  read?(file: string): string[];
  readAsync?(file: string): Promise<string[]>;
  clientVersion?: () => string | null | undefined;
}

export function cliCacheConsumerVersion(adapterId: string): string | null | undefined {
  const binary = resolveCliBinary(adapterId)?.binPath;
  return binary ? cachedCliBinaryVersion(binary, adapterId) : null;
}

const MAX_CACHE_BYTES = 4 * 1024 * 1024;

function readCacheText(file: string): string {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_CACHE_BYTES) throw new Error('invalid CLI model cache size');
    const bytes = Buffer.alloc(Math.min(stat.size, MAX_CACHE_BYTES) + 1);
    let read = 0;
    while (read < bytes.length) {
      const count = fs.readSync(fd, bytes, read, bytes.length - read, null);
      if (count === 0) break;
      read += count;
    }
    if (read === bytes.length) throw new Error('CLI model cache grew during read');
    return bytes.subarray(0, read).toString('utf8');
  } finally { fs.closeSync(fd); }
}

function cacheMatchesConsumer(raw: unknown, options: CliModelCacheReadOptions): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !('client_version' in raw)) return true;
  const producer = (raw as { client_version: unknown }).client_version;
  const consumer = typeof options.clientVersion === 'function' ? options.clientVersion() : options.clientVersion;
  if (typeof producer !== 'string' || producer.length > 128 || !isValidAppVersion(producer) ||
      typeof consumer !== 'string' || consumer.length > 128 || !isValidAppVersion(consumer)) return false;
  return compareAppVersions(producer, consumer) <= 0;
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
  {
    adapterId: 'openclaude',
    files: [path.join(home, '.openclaude', 'models_cache.json')],
  },
  { adapterId: 'agy', files: [path.join(home, '.gemini', 'models_cache.json')] },
  {
    adapterId: 'kimi',
    files: [
      // Kimi Code 2.x: os aliases de `[models."…"]` são o que `--model` aceita.
      path.join(home, '.kimi-code', 'config.toml'),
      path.join(home, '.kimi', 'models_cache.json'),
    ],
  },
  {
    adapterId: 'opencode',
    files: [
      path.join(home, '.cache', 'opencode', 'models.json'),
      path.join(home, '.config', 'opencode', 'models.json'),
    ],
  },
  // OpenCode's cache is a provider-keyed map (not `{ models: [] }`), so this
  // reader usually yields nothing; live `opencode models` in model-discovery
  // is the official listing. Claude/Codex have no list command — this cache
  // (when the CLI writes it) is their official mechanism.
  {
    adapterId: 'qwen',
    // F-238: sem subcomando de listar — o catálogo vivo é o
    // `modelProviders.*[].id` do settings do operador (só ids qwen*). F-724:
    // com a auth no Alibaba Token Plan entra também o `deepseek-v4-pro`.
    files: [path.join(home, '.qwen', 'settings.json')],
    read: (file) =>
      readQwenSettingsSummary(path.dirname(path.dirname(file))).modelIds as string[],
    readAsync: async (file) => [...(await readQwenSettingsSummaryAsync(path.dirname(path.dirname(file)))).modelIds],
  },
];

const MODEL_ID = MODEL_ID_PATTERN;

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

export function readCliModelCache(file: string, options: CliModelCacheReadOptions = {}): string[] {
  try { return parseCliModelCacheText(file, readCacheText(file), options); } catch { return []; }
}

export async function readCliModelCacheAsync(file: string, options: CliModelCacheReadOptions = {}): Promise<string[]> {
  const result = await readRegularFileCappedAsync(file, 1024 * 1024);
  return result.kind === 'text' ? parseCliModelCacheText(file, result.text, options) : [];
}

function parseCliModelCacheText(file: string, text: string, options: CliModelCacheReadOptions): string[] {
  try {
    if (file.endsWith('.toml')) {
      return parseKimiConfigModelAliases(text)
        .filter((alias) => MODEL_ID.test(alias));
    }
    const raw = JSON.parse(text) as unknown;
    if (!cacheMatchesConsumer(raw, options)) return [];
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
export function readCliEfforts(file: string, options: CliModelCacheReadOptions = {}): string[] {
  try { return parseCliEffortsText(readCacheText(file), options); } catch { return []; }
}

export async function readCliEffortsAsync(file: string, options: CliModelCacheReadOptions = {}): Promise<string[]> {
  const result = await readRegularFileCappedAsync(file, 1024 * 1024);
  return result.kind === 'text' ? parseCliEffortsText(result.text, options) : [];
}

function parseCliEffortsText(text: string, options: CliModelCacheReadOptions): string[] {
  try {
    const raw = JSON.parse(text) as unknown;
    if (!cacheMatchesConsumer(raw, options)) return [];
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
      const models = source.read ? source.read(file) : readCliModelCache(file, {
        clientVersion: source.clientVersion ?? (() => cliCacheConsumerVersion(source.adapterId)),
      });
      for (const id of models) ids.add(id);
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
      for (const effort of readCliEfforts(file, {
        clientVersion: source.clientVersion ?? (() => cliCacheConsumerVersion(source.adapterId)),
      })) levels.add(effort);
    }
    if (levels.size > 0) discovered.set(source.adapterId, [...levels]);
  }
  return discovered;
}

export async function discoverCliModelsAsync(sources: readonly CliModelCacheSource[] = CLI_MODEL_CACHE_SOURCES, context?: PeriodicTaskContext): Promise<Map<string, string[]>> {
  const discovered = new Map<string, string[]>();
  for (const source of sources) {
    await context?.checkpoint();
    const ids = new Set<string>();
    for (const file of source.files) {
      await context?.checkpoint();
      const models = source.readAsync ? await source.readAsync(file) : source.read ? source.read(file) : await readCliModelCacheAsync(file, {
        clientVersion: source.clientVersion ?? (() => cliCacheConsumerVersion(source.adapterId)),
      });
      context?.assertCurrent();
      for (const id of models) ids.add(id);
    }
    if (ids.size) discovered.set(source.adapterId, [...ids]);
  }
  return discovered;
}

export async function discoverCliEffortsAsync(sources: readonly CliModelCacheSource[] = CLI_MODEL_CACHE_SOURCES, context?: PeriodicTaskContext): Promise<Map<string, string[]>> {
  const discovered = new Map<string, string[]>();
  for (const source of sources) {
    await context?.checkpoint();
    const levels = new Set<string>();
    for (const file of source.files) {
      await context?.checkpoint();
      const efforts = await readCliEffortsAsync(file, { clientVersion: source.clientVersion ?? (() => cliCacheConsumerVersion(source.adapterId)) });
      context?.assertCurrent();
      for (const effort of efforts) levels.add(effort);
    }
    if (levels.size) discovered.set(source.adapterId, [...levels]);
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

/**
 * Cache oficial ∪ lista do adapter — só para CLI SEM listagem (`bundled`).
 * F-964: CLI que sabe listar não ganha união; a oferta dela sai do
 * resolvedor (model-availability.ts), que usa este cache como fallback.
 */
export function applyDiscoveredModelsToAdapter(
  adapter: Adapter,
  discovered: ReadonlyMap<string, readonly string[]>,
): Adapter {
  if (modelListAuthority(adapter.id) !== 'bundled') return adapter;
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
