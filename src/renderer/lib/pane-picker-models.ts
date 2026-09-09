import type { ModelCatalogEntryInfo } from '../../shared/adapter-types';
import type { ProviderSettingsInfo } from '../../shared/provider-settings-types';
import {
  classifyOperationalBand,
  type OperationalBand,
} from '../../shared/model-operational-bands';

/**
 * Ordem dos modelos no "+ Pane": geração mais nova primeiro e, dentro dela,
 * o mais forte primeiro. O catálogo não guarda data de lançamento nem uma
 * "força" explícita; o que ele guarda é costTier/availability (curados à
 * mão) e ids com a geração embutida (claude-opus-4-8, gpt-5.6-sol,
 * gemini-3.7-flash-high). Este módulo lê SÓ isso — nunca fixtures de
 * avaliação — e é puro de propósito: é o que os testes exercitam.
 */

export interface PickerModelRow {
  readonly id: string;
  /** Faixa operacional do catálogo; null quando ele não conhece o modelo. */
  readonly band: OperationalBand | null;
  /** api-only/deprecated: escolhível à mão, mas nunca acima dos utilizáveis. */
  readonly restricted: boolean;
  readonly isDefault: boolean;
  readonly warning?: string;
}

/** `[major, minor]` extraídos do id; `[0, 0]` quando o id não versiona. */
export type ModelVersion = readonly [major: number, minor: number];

/**
 * Primeiro número do id que parece geração, com o minor separado por `.` ou
 * `-`: `claude-opus-4-8` → 4.8, `gpt-5.6-sol` → 5.6, `kimi-code/k3` → 3,
 * `gpt-4o-mini` → 4, `qwen3-coder` → 3. Tamanho de modelo (`120b`, `70b`) e
 * datas (`20250929`) não são geração e ficam de fora.
 */
const VERSION_PATTERN =
  /(?:^|[-_/])[a-z]*?(\d+)(?:[.-](\d+))?([a-z]?)(?=$|[-_/.[(:])/g;

/** Quatro dígitos ou mais é data/build, nunca geração. */
const MAX_MAJOR_DIGITS = 3;
const MAX_MINOR_DIGITS = 2;

export function parseModelVersion(id: string): ModelVersion {
  const pattern = new RegExp(VERSION_PATTERN.source, 'g');
  const lower = id.toLowerCase();
  for (let match = pattern.exec(lower); match; match = pattern.exec(lower)) {
    const [, major, minor, suffix] = match;
    if (major.length > MAX_MAJOR_DIGITS) continue;
    // `120b`, `7b`: contagem de parâmetros, não versão.
    if (suffix === 'b' && minor === undefined) continue;
    // `qwen3-235b` (o "minor" era tamanho) e `gpt-4-0613` (build): só o major.
    const minorIsVersion =
      minor !== undefined && suffix !== 'b' && minor.length <= MAX_MINOR_DIGITS;
    return [Number(major), minorIsVersion ? Number(minor) : 0];
  }
  return [0, 0];
}

const COST_STRENGTH: Readonly<Record<string, number>> = Object.freeze({
  high: 3,
  medium: 2,
  low: 1,
  free: 0,
});

/** Famílias que os vendors vendem como topo de linha. */
const STRONG_TOKENS: ReadonlySet<string> = new Set([
  'opus',
  'fable',
  'mythos',
  'pro',
  'ultra',
  'max',
  'sol',
  'astra',
  'reasoner',
]);

/** Sufixos de custo/velocidade: mesma geração, menos capacidade. */
const LIGHT_TOKENS: ReadonlySet<string> = new Set([
  'haiku',
  'mini',
  'flash',
  'fast',
  'air',
  'turbo',
  'highspeed',
  'lite',
  'nano',
  'small',
  'micro',
]);

/** Esforço de raciocínio embutido no id (gemini-3.7-flash-high/medium/low). */
const EFFORT_NUDGE: Readonly<Record<string, number>> = Object.freeze({
  high: 0.2,
  medium: 0.1,
  low: 0,
});

/** Desempate a favor da família forte quando o custo é o mesmo (sol × terra). */
const STRONG_NUDGE = 0.05;
const LIGHT_NUDGE = -0.3;

function tokensOf(id: string): string[] {
  return id.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Força relativa dentro de uma mesma geração. Custo do catálogo manda; sem
 * custo, a família no id decide (opus/pro = forte, mini/flash = leve, o
 * resto = meio). Sufixos de esforço e de velocidade só desempatam.
 */
export function modelStrength(
  id: string,
  info?: ModelCatalogEntryInfo | null,
): number {
  const tokens = tokensOf(id);
  const strong = tokens.some((token) => STRONG_TOKENS.has(token));
  const light = tokens.some((token) => LIGHT_TOKENS.has(token));
  const tier =
    info?.costTier && info.costTier !== 'unknown'
      ? COST_STRENGTH[info.costTier]
      : undefined;
  const base = tier ?? (strong ? 3 : light ? 1 : 2);
  const effort = tokens.reduce(
    (max, token) => Math.max(max, EFFORT_NUDGE[token] ?? 0),
    0,
  );
  return (
    base + effort + (strong ? STRONG_NUDGE : 0) + (light ? LIGHT_NUDGE : 0)
  );
}

function isRestricted(info: ModelCatalogEntryInfo | undefined): boolean {
  return info?.availability === 'api-only' || info?.availability === 'deprecated';
}

function bandOf(info: ModelCatalogEntryInfo | undefined): OperationalBand | null {
  if (!info) return null;
  const knowsCost = info.costTier !== undefined && info.costTier !== 'unknown';
  if (!knowsCost && !info.availability) return null;
  return classifyOperationalBand(info);
}

/**
 * Catálogo do provider em ordem de escolha: utilizáveis antes dos restritos;
 * geração (major) mais nova primeiro; dentro dela o mais forte; depois o
 * minor mais novo; e por fim a ordem do próprio catálogo (default primeiro),
 * que é o único desempate para ids sem versão (`codex-default`).
 */
export function rankPickerModels(
  provider: Pick<ProviderSettingsInfo, 'models' | 'defaultModel' | 'modelInfo'>,
): PickerModelRow[] {
  const defaultModel = provider.defaultModel?.trim() ?? '';
  const ordered = [defaultModel, ...provider.models]
    .map((model) => model?.trim() ?? '')
    .filter((model) => model.length > 0);
  const scored = [...new Set(ordered)].map((id, index) => {
    const info = provider.modelInfo?.[id];
    return {
      id,
      index,
      info,
      restricted: isRestricted(info),
      version: parseModelVersion(id),
      strength: modelStrength(id, info),
    };
  });
  scored.sort(
    (a, b) =>
      Number(a.restricted) - Number(b.restricted) ||
      b.version[0] - a.version[0] ||
      b.strength - a.strength ||
      b.version[1] - a.version[1] ||
      a.index - b.index,
  );
  return scored.map((entry) => ({
    id: entry.id,
    band: bandOf(entry.info),
    restricted: entry.restricted,
    isDefault: entry.id === defaultModel,
    ...(entry.info?.warning ? { warning: entry.info.warning } : {}),
  }));
}
