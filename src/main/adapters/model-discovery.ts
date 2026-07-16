import { execFile } from 'node:child_process';

/**
 * Descoberta VIVA de modelos por CLI: "saiu modelo novo → aparece no Nexus"
 * sem esperar release. Cada estratégia pergunta à própria CLI instalada quais
 * modelos ela conhece (a CLI se atualiza sozinha e é a fonte de verdade do
 * provider). O resultado entra em cache com TTL e é mesclado à lista estática
 * do adapter em listProviderSettings; "Atualizar modelos" força um refresh e
 * o broadcast de providers empurra a lista nova para a UI.
 */

interface DiscoveryStrategy {
  readonly bin: string;
  readonly args: readonly string[];
  readonly parse: (stdout: string) => string[];
}

const STRATEGIES: Readonly<Record<string, DiscoveryStrategy>> = Object.freeze({
  kimi: {
    bin: 'kimi',
    args: ['provider', 'list', '--json'],
    parse: (stdout) => {
      const parsed: unknown = JSON.parse(stdout);
      if (!parsed || typeof parsed !== 'object') return [];
      const models = (parsed as { models?: Record<string, unknown> }).models;
      return models && typeof models === 'object' ? Object.keys(models) : [];
    },
  },
});

const TTL_MS = 5 * 60_000;
const FAILURE_TTL_MS = 60_000;
const EXEC_TIMEOUT_MS = 4_000;
const MAX_MODELS = 64;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,127}$/;

interface CacheEntry {
  readonly models: readonly string[];
  readonly fetchedAt: number;
  readonly failed: boolean;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<void>>();

export function supportsModelDiscovery(adapterId: string): boolean {
  return adapterId in STRATEGIES;
}

/** Leitura síncrona do cache — usada na montagem de listProviderSettings. */
export function discoveredModelsFor(adapterId: string): readonly string[] {
  return cache.get(adapterId)?.models ?? [];
}

export function sanitizeDiscoveredModels(raw: readonly string[]): string[] {
  const unique: string[] = [];
  for (const id of raw) {
    if (typeof id !== 'string') continue;
    const trimmed = id.trim();
    if (!MODEL_ID_PATTERN.test(trimmed)) continue;
    if (unique.includes(trimmed)) continue;
    unique.push(trimmed);
    if (unique.length >= MAX_MODELS) break;
  }
  return unique;
}

function isFresh(entry: CacheEntry | undefined, now: number): boolean {
  if (!entry) return false;
  const ttl = entry.failed ? FAILURE_TTL_MS : TTL_MS;
  return now - entry.fetchedAt < ttl;
}

function execDiscovery(strategy: DiscoveryStrategy): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile(
      strategy.bin,
      [...strategy.args],
      { encoding: 'utf8', timeout: EXEC_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        try {
          resolve(sanitizeDiscoveredModels(strategy.parse(stdout)));
        } catch (parseError) {
          reject(
            parseError instanceof Error
              ? parseError
              : new Error(String(parseError)),
          );
        }
      },
    );
  });
}

/**
 * Atualiza o cache de um adapter (dedupe de chamadas concorrentes; falha vira
 * cache vazio com TTL curto — a CLI pode estar deslogada ou sem o comando).
 */
export function refreshDiscoveredModels(
  adapterId: string,
  options: { force?: boolean } = {},
): Promise<void> {
  const strategy = STRATEGIES[adapterId];
  if (!strategy) return Promise.resolve();
  const now = Date.now();
  if (!options.force && isFresh(cache.get(adapterId), now)) {
    return Promise.resolve();
  }
  const running = inFlight.get(adapterId);
  if (running) return running;
  const task = execDiscovery(strategy)
    .then((models) => {
      cache.set(adapterId, { models, fetchedAt: Date.now(), failed: false });
    })
    .catch(() => {
      cache.set(adapterId, {
        models: cache.get(adapterId)?.models ?? [],
        fetchedAt: Date.now(),
        failed: true,
      });
    })
    .finally(() => {
      inFlight.delete(adapterId);
    });
  inFlight.set(adapterId, task);
  return task;
}

/**
 * Dispara descoberta para vários adapters e chama onSettled quando TODAS
 * terminarem (para o chamador re-broadcastar a lista de providers).
 */
export function refreshAllDiscoveredModels(
  adapterIds: readonly string[],
  onSettled?: () => void,
): void {
  const tasks = adapterIds
    .filter((id) => supportsModelDiscovery(id))
    .map((id) => refreshDiscoveredModels(id));
  if (tasks.length === 0) return;
  void Promise.allSettled(tasks).then(() => onSettled?.());
}

export function resetModelDiscoveryForTests(): void {
  cache.clear();
  inFlight.clear();
}
