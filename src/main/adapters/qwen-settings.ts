import { readRegularFileCappedAsync } from '../redline/redline-safe-read';
/**
 * Leitor somente-leitura do `~/.qwen/settings.json` (F-238).
 *
 * O Qwen Code não tem `qwen auth`: a credencial e o catálogo de modelos vivem
 * no settings do operador (`env.BAILIAN_TOKEN_PLAN_API_KEY`,
 * `modelProviders.openai[].id`, `model.baseUrl`). Este módulo nunca devolve o
 * valor da chave — só presença, baseUrl e ids de modelo. O spawn deixa a
 * própria CLI ler o settings; o overlay F-566 liga o arquivo sem copiá-lo.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MODEL_ID_PATTERN } from '../../shared/model-id';
import {
  ALIBABA_TOKEN_PLAN_OPENAI_BASE_URL,
  DEEPSEEK_DIRECT_HOST,
  DEEPSEEK_TOKEN_PLAN_MODEL,
  httpsHostOf,
  isAlibabaPlanKey,
  isAlibabaTokenPlanUrl,
} from './deepseek-provider';

export interface QwenSettingsSummary {
  /** Alguma credencial utilizável presente no settings (`env.*` ou envKey). */
  readonly hasCredential: boolean;
  /** `model.baseUrl` — endpoint OpenAI-compatible configurado. */
  readonly baseUrl: string | null;
  /**
   * `security.auth.baseUrl` — endpoint da auth OpenAI-compatible. F-1565: a
   * resolução da base URL do spawn lê os dois (a auth vence o `model`).
   */
  readonly authBaseUrl: string | null;
  /**
   * F-724: a autenticação OpenAI-compatible do Qwen Code aponta para o
   * Alibaba Model Studio Token Plan.
   */
  readonly tokenPlan: boolean;
  /**
   * Ids `qwen*` do catálogo `modelProviders.*[]` (outros providers não
   * entram), o `deepseek-flash` quando o endpoint é o da DeepSeek direta
   * (o id não é servido por DashScope) e, só no Token Plan, o
   * `deepseek-v4-pro` que o plano serve.
   */
  readonly modelIds: readonly string[];
}

const QWEN_MODEL_ID = /^qwen[0-9a-z.-]*$/i;
/** Menu canônico do Flash: o `deepseek-v4-flash` é o mesmo modelo, via alias. */
const DEEPSEEK_FLASH_MODEL = 'deepseek-flash';
const DEEPSEEK_FLASH_ALIASES: ReadonlySet<string> = new Set([
  DEEPSEEK_FLASH_MODEL,
  'deepseek-v4-flash',
]);

function objectField(value: unknown, key: string): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const field = (value as Record<string, unknown>)[key];
  return field && typeof field === 'object' && !Array.isArray(field)
    ? (field as Record<string, unknown>)
    : null;
}

/**
 * F-724: o Qwen Code autentica no Token Plan quando a auth selecionada é a
 * OpenAI-compatible e a base URL dela (ou a do modelo) é o Token Plan. Uma
 * auth de outro tipo (ex.: OAuth) nunca vira Token Plan pela base URL.
 */
function settingsUseTokenPlan(settings: Record<string, unknown>): boolean {
  const auth = objectField(objectField(settings, 'security'), 'auth');
  const selectedType = nonEmptyString(auth?.selectedType);
  if (selectedType && selectedType !== 'openai') return false;
  const model = objectField(settings, 'model');
  return [auth?.baseUrl, model?.baseUrl].some(
    (url) => typeof url === 'string' && isAlibabaTokenPlanUrl(url),
  );
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

/** Primeiro valor não vazio — a base URL da linha vence a do modelo/auth. */
function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    const text = nonEmptyString(value);
    if (text) return text;
  }
  return null;
}

export function qwenSettingsPath(home: string = os.homedir()): string {
  return path.join(process.env.QWEN_HOME ?? path.join(home, '.qwen'), 'settings.json');
}

export function readQwenSettingsSummary(home: string = os.homedir()): QwenSettingsSummary {
  try { return parseQwenSettingsSummary(JSON.parse(fs.readFileSync(qwenSettingsPath(home), 'utf8'))); }
  catch { return parseQwenSettingsSummary(null); }
}

export async function readQwenSettingsSummaryAsync(home: string = os.homedir()): Promise<QwenSettingsSummary> {
  const result = await readRegularFileCappedAsync(qwenSettingsPath(home), 1024 * 1024);
  try { return parseQwenSettingsSummary(result.kind === 'text' ? JSON.parse(result.text) : null); }
  catch { return parseQwenSettingsSummary(null); }
}

function parseQwenSettingsSummary(raw: unknown): QwenSettingsSummary {
  const empty: QwenSettingsSummary = {
    hasCredential: false,
    baseUrl: null,
    authBaseUrl: null,
    tokenPlan: false,
    modelIds: [],
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty;
  const settings = raw as Record<string, unknown>;

  const env = settings.env;
  let hasCredential = false;
  if (env && typeof env === 'object' && !Array.isArray(env)) {
    for (const value of Object.values(env as Record<string, unknown>)) {
      if (nonEmptyString(value)) {
        hasCredential = true;
        break;
      }
    }
  }

  const auth = objectField(objectField(settings, 'security'), 'auth');
  const model = objectField(settings, 'model');
  const baseUrl = nonEmptyString(model?.baseUrl);
  // F-724: o Token Plan serve o deepseek-v4-pro pelo mesmo endpoint do Qwen
  // (sonda 02/10: v4-pro 200, v4-flash 403). Só ele entra no plano.
  const tokenPlan = settingsUseTokenPlan(settings);

  const modelIds = new Set<string>();
  const providers = settings.modelProviders;
  if (providers && typeof providers === 'object' && !Array.isArray(providers)) {
    for (const rows of Object.values(providers as Record<string, unknown>)) {
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const entry = row as Record<string, unknown>;
        const id = nonEmptyString(entry.id);
        // `envKey` aponta para uma variável de ambiente com a chave daquele
        // modelo — presença no env processo também conta como credencial.
        const envKey = nonEmptyString(entry.envKey);
        if (
          !hasCredential &&
          envKey &&
          nonEmptyString(process.env[envKey])
        ) {
          hasCredential = true;
        }
        if (!id || !MODEL_ID_PATTERN.test(id)) continue;
        if (QWEN_MODEL_ID.test(id)) {
          modelIds.add(id);
          continue;
        }
        // DeepSeek Flash também roda pelo Qwen Code quando o endpoint da
        // linha (ou o do modelo/auth) é o da DeepSeek direta. No Token Plan
        // e no DashScope o id não é servido, então continua fora.
        if (
          DEEPSEEK_FLASH_ALIASES.has(id) &&
          httpsHostOf(firstNonEmptyString(entry.baseUrl, model?.baseUrl, auth?.baseUrl)) ===
            DEEPSEEK_DIRECT_HOST
        ) {
          modelIds.add(DEEPSEEK_FLASH_MODEL);
        }
      }
    }
  }

  if (tokenPlan) modelIds.add(DEEPSEEK_TOKEN_PLAN_MODEL);

  return {
    hasCredential,
    baseUrl,
    authBaseUrl: nonEmptyString(auth?.baseUrl),
    tokenPlan,
    modelIds: [...modelIds],
  };
}

/**
 * Endpoint padrão do Qwen Code sem configuração (o `DEFAULT_BASE_URL` da
 * própria CLI): DashScope compatível com OpenAI. Chave `sk-sp-` (Token Plan)
 * NÃO é aceita ali — só na URL exclusiva do plano.
 */
export const QWEN_DASHSCOPE_DEFAULT_BASE_URL =
  'https://dashscope.aliyuncs.com/compatible-mode/v1';

function isAliyunHost(url: string): boolean {
  const host = httpsHostOf(url);
  return host === 'aliyuncs.com' || (host?.endsWith('.aliyuncs.com') ?? false);
}

/**
 * F-1565: a base URL que o pane do Qwen usa quando o Nexus injeta a chave
 * configurada (vault ou conta). Ordem:
 *  1. `configured` — o campo "Base URL da API" de Providers › Qwen › Avançado
 *     (escolha explícita do operador; validada como https sem credencial).
 *  2. A base URL do `~/.qwen/settings.json` — EXCETO quando a chave é do
 *     Token Plan (`sk-sp-`) e ela aponta para outro host Alibaba (DashScope):
 *     essa combinação é o 401 do incidente, então a URL exclusiva do plano
 *     vence. Um host fora da Alibaba (proxy do operador) é respeitado.
 *  3. Chave `sk-sp-` sem nenhuma base configurada → a URL do Token Plan.
 *  4. Demais casos → `null` (a CLI usa o padrão DashScope dela).
 */
export function resolveQwenInjectionBaseUrl(input: {
  readonly configured?: string | null;
  readonly settingsBaseUrl?: string | null;
  readonly key?: string | null;
}): string | null {
  const configured = input.configured?.trim();
  if (configured && httpsHostOf(configured)) return configured;
  const settings = input.settingsBaseUrl?.trim() || null;
  const planKey = isAlibabaPlanKey(input.key);
  if (settings) {
    if (planKey && isAliyunHost(settings) && !isAlibabaTokenPlanUrl(settings)) {
      return ALIBABA_TOKEN_PLAN_OPENAI_BASE_URL;
    }
    return settings;
  }
  return planKey ? ALIBABA_TOKEN_PLAN_OPENAI_BASE_URL : null;
}

/**
 * F-1565: mescla as entradas do Nexus no `settings.json` do OVERLAY do pane
 * (o arquivo do operador nunca é tocado). O Qwen Code só honra a variável
 * `BAILIAN_TOKEN_PLAN_API_KEY` quando um `modelProviders.openai[]` aponta para
 * ela via `envKey` — sem a entrada, a chave injetada morria no env e a CLI
 * usava o `security.auth.apiKey` embutido (velho) ou caía em "No auth type".
 * A entrada NUNCA carrega o segredo: só `envKey` + `baseUrl` (a forma oficial
 * da doc do Model Studio). Entrada do operador com o mesmo id vence a nossa —
 * exceto quando ela é alimentada pela NOSSA env (`envKey` igual) com uma base
 * URL Alibaba incompatível com a chave do plano: aí a base URL é corrigida na
 * cópia do overlay.
 */
export function mergeQwenSettingsForInjection(
  raw: unknown,
  options: {
    readonly baseUrl: string;
    readonly models: readonly string[];
    /** A chave injetada é do Token Plan (`sk-sp-`). */
    readonly tokenPlanKey: boolean;
  },
): Record<string, unknown> {
  const settings =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? ({ ...(raw as Record<string, unknown>) } as Record<string, unknown>)
      : {};
  const security = objectField(settings, 'security') ?? {};
  const auth = objectField(security, 'auth') ?? {};
  // A chave injetada é a credencial deste pane: a auth tem de ser a
  // OpenAI-compatible, mesmo que o perfil diga qwen-oauth (a cópia é efêmera).
  settings.security = { ...security, auth: { ...auth, selectedType: 'openai' } };

  const providers = objectField(settings, 'modelProviders') ?? {};
  const rows = Array.isArray(providers.openai) ? [...providers.openai] : [];
  const fixRow = (row: unknown): unknown => {
    const entry = row && typeof row === 'object' && !Array.isArray(row)
      ? (row as Record<string, unknown>)
      : null;
    if (!entry) return row;
    if (nonEmptyString(entry.envKey) !== 'BAILIAN_TOKEN_PLAN_API_KEY') return row;
    if (!options.tokenPlanKey) return row;
    const base = nonEmptyString(entry.baseUrl);
    if (base && isAliyunHost(base) && !isAlibabaTokenPlanUrl(base)) {
      return { ...entry, baseUrl: options.baseUrl };
    }
    return row;
  };
  const merged = rows.map(fixRow);
  const known = new Set(
    merged
      .map((row) =>
        row && typeof row === 'object' && !Array.isArray(row)
          ? nonEmptyString((row as Record<string, unknown>).id)?.toLowerCase()
          : null,
      )
      .filter((id): id is string => Boolean(id)),
  );
  const tokenPlan = isAlibabaTokenPlanUrl(options.baseUrl);
  for (const id of options.models) {
    const model = id.trim();
    if (!model || known.has(model.toLowerCase())) continue;
    known.add(model.toLowerCase());
    merged.push({
      id: model,
      ...(tokenPlan ? { name: `[ModelStudio Token Plan] ${model}` } : {}),
      baseUrl: options.baseUrl,
      envKey: 'BAILIAN_TOKEN_PLAN_API_KEY',
    });
  }
  settings.modelProviders = { ...providers, openai: merged };
  return settings;
}

/** Prontidão: a chave em settings conta como `present` — nunca lida p/ fora. */
export function qwenSettingsHasCredential(home: string = os.homedir()): boolean {
  return readQwenSettingsSummary(home).hasCredential;
}
