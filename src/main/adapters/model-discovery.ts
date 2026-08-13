import { execFile } from 'node:child_process';
import { isModelId } from '../../shared/model-id';
import { getEffectivePath } from '../path-resolver';

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

/** AGY `models` — TSV `id\\tlabel`, ou JSON `{ command.data.models[].id }`. */
export function parseAgyModelsOutput(stdout: string): string[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const fromJson = agyModelIdsFromJson(parsed);
      if (fromJson.length > 0) return fromJson;
    } catch {
      // Fall through to TSV — older CLIs print id\\tlabel on stdout.
    }
  }
  return trimmed
    .split(/\r?\n/)
    .map((line) => line.trim().split(/[\t ]+/, 1)[0] ?? '')
    .filter((id) => id.length > 0);
}

function agyModelIdsFromJson(parsed: unknown): string[] {
  if (Array.isArray(parsed)) {
    return parsed.flatMap((row) => {
      if (typeof row === 'string') return [row];
      if (row && typeof row === 'object' && typeof (row as { id?: unknown }).id === 'string') {
        return [(row as { id: string }).id];
      }
      return [];
    });
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const command = (parsed as { command?: { data?: { models?: unknown } } }).command;
  const models = command?.data?.models;
  if (!Array.isArray(models)) return [];
  return models.flatMap((row) =>
    row && typeof row === 'object' && typeof (row as { id?: unknown }).id === 'string'
      ? [(row as { id: string }).id]
      : [],
  );
}

/** Grok `models` — bullets `- grok-4.6` / `* grok-4.5 (default)`. */
export function parseGrokModelsOutput(stdout: string): string[] {
  const ids: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const bullet = /^\s*[-*]\s+(\S+)/.exec(line);
    if (!bullet) continue;
    ids.push(bullet[1]);
  }
  return ids;
}

export function parseKimiModelsOutput(stdout: string): string[] {
  const parsed: unknown = JSON.parse(stdout);
  if (!parsed || typeof parsed !== 'object') return [];
  const models = (parsed as { models?: Record<string, unknown> }).models;
  return models && typeof models === 'object' ? Object.keys(models) : [];
}

/** OpenCode `models` — one `provider/id` per line. */
export function parseOpenCodeModelsOutput(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((id) => id.length > 0);
}

/** Cursor Agent `models` — `id - Label` (header "Available models" ignored). */
export function parseCursorAgentModelsOutput(stdout: string): string[] {
  const ids: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\S+)\s+-\s+/.exec(line);
    if (match) ids.push(match[1]);
  }
  return ids;
}

/** Qoder `qodercli --list-models` — header `MODEL`, then one id per line. */
export function parseQoderModelsOutput(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((id) => id.length > 0 && id.toUpperCase() !== 'MODEL');
}

/** Prime Agent `model list` — whitespace table; column 1 is the model id. */
export function parsePrimeAgentModelsOutput(stdout: string): string[] {
  const ids: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^(provider|-)/i.test(trimmed)) continue;
    const cols = trimmed.split(/\s+/);
    if (cols.length < 2) continue;
    ids.push(cols[1]);
  }
  return ids;
}

/** OMP `models --json` — `{ models: [{ selector, id }] }`. Prefer selector. */
export function parseOmpModelsOutput(stdout: string): string[] {
  const parsed: unknown = JSON.parse(stdout);
  if (!parsed || typeof parsed !== 'object') return [];
  const models = (parsed as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];
  return models.flatMap((row) => {
    if (!row || typeof row !== 'object') return [];
    const rec = row as { selector?: unknown; id?: unknown };
    const selector = typeof rec.selector === 'string' ? rec.selector.trim() : '';
    const id = typeof rec.id === 'string' ? rec.id.trim() : '';
    const candidate = selector || id;
    return candidate ? [candidate] : [];
  });
}

export type ModelDiscoveryKind = 'cli' | 'cache' | 'bundled';

export interface ModelDiscoveryInventoryEntry {
  readonly kind: ModelDiscoveryKind;
  /** Exact argv when kind is `cli`. */
  readonly command?: string;
  /** Why there is no live CLI listing (kind `cache` | `bundled`). */
  readonly reason?: string;
}

/**
 * As 18 CLIs do catálogo (9 builtin + 9 overlay em ~/.nexus/plugins/adapters).
 * kind `cli` entra no refresh automático (abertura, settings/missão, 5 min).
 * Claude/Codex: cache oficial já lido por cli-model-discovery — sem comando list.
 * Sem listagem: lista bundled do adapter + enrich do catálogo; não fingimos.
 */
export const MODEL_DISCOVERY_INVENTORY: Readonly<
  Record<string, ModelDiscoveryInventoryEntry>
> = Object.freeze({
  agy: { kind: 'cli', command: 'agy models' },
  grok: { kind: 'cli', command: 'grok models' },
  kimi: { kind: 'cli', command: 'kimi provider list --json' },
  opencode: { kind: 'cli', command: 'opencode models' },
  'cursor-agent': { kind: 'cli', command: 'cursor-agent models' },
  qoder: { kind: 'cli', command: 'qodercli --list-models' },
  'prime-agent': { kind: 'cli', command: 'prime-agent model list' },
  omp: { kind: 'cli', command: 'omp models --json' },
  claude: {
    kind: 'cache',
    reason: 'sem subcomando list; usa ~/.claude/models_cache.json + bundled',
  },
  codex: {
    kind: 'cache',
    reason: 'sem subcomando list; usa ~/.codex/models_cache.json + bundled',
  },
  aider: {
    kind: 'bundled',
    reason: '--list-models é busca litellm (exige filtro), não catálogo da CLI',
  },
  glm: {
    kind: 'bundled',
    reason: 'wrapper da CLI claude + endpoint z.ai; listar claude traria ids errados',
  },
  longcat: {
    kind: 'bundled',
    reason: 'wrapper da CLI claude + endpoint LongCat; sem catálogo próprio',
  },
  deepseek: {
    kind: 'bundled',
    reason: 'wrapper da CLI claude + endpoint DeepSeek; sem catálogo próprio',
  },
  gemini: {
    kind: 'bundled',
    reason: 'Gemini CLI não expõe comando/API estável de listar modelos',
  },
  qwen: {
    kind: 'bundled',
    reason: 'Qwen Code não expõe comando de listar modelos',
  },
  muse: {
    kind: 'bundled',
    reason: 'Muse não expõe comando de listar modelos',
  },
  sakana: {
    kind: 'bundled',
    reason: 'codex-fugu (wrapper Codex) sem subcomando models',
  },
});

const STRATEGIES: Readonly<Record<string, DiscoveryStrategy>> = Object.freeze({
  agy: {
    bin: 'agy',
    args: ['models'],
    parse: parseAgyModelsOutput,
  },
  grok: {
    bin: 'grok',
    args: ['models'],
    parse: parseGrokModelsOutput,
  },
  kimi: {
    bin: 'kimi',
    args: ['provider', 'list', '--json'],
    parse: parseKimiModelsOutput,
  },
  opencode: {
    bin: 'opencode',
    args: ['models'],
    parse: parseOpenCodeModelsOutput,
  },
  'cursor-agent': {
    bin: 'cursor-agent',
    args: ['models'],
    parse: parseCursorAgentModelsOutput,
  },
  qoder: {
    bin: 'qodercli',
    args: ['--list-models'],
    parse: parseQoderModelsOutput,
  },
  'prime-agent': {
    bin: 'prime-agent',
    args: ['model', 'list'],
    parse: parsePrimeAgentModelsOutput,
  },
  omp: {
    bin: 'omp',
    args: ['models', '--json'],
    parse: parseOmpModelsOutput,
  },
});

const TTL_MS = 5 * 60_000;
const FAILURE_TTL_MS = 60_000;
/** Qoder/OMP listagens reais passam de 8s em máquina fria. */
const EXEC_TIMEOUT_MS = 15_000;
/** Cursor Agent ~200 ids; OMP ~275. Cap alto o bastante para não esconder modelo novo. */
export const MODEL_DISCOVERY_CAP = 256;
const MAX_MODELS = MODEL_DISCOVERY_CAP;
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
    if (!isModelId(trimmed)) continue;
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
      {
        encoding: 'utf8',
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, PATH: getEffectivePath() },
      },
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
