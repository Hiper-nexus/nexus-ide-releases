import { readRegularFileCapped, readRegularFileCappedAsync } from '../redline/redline-safe-read';
/**
 * Leitor somente-leitura do `~/.qwen/settings.json` (F-238).
 *
 * O Qwen Code não tem `qwen auth`: a credencial e o catálogo de modelos vivem
 * no settings do operador (`env.BAILIAN_TOKEN_PLAN_API_KEY`,
 * `modelProviders.openai[].id`, `model.baseUrl`). Este módulo nunca devolve o
 * valor da chave — só presença, baseUrl e ids de modelo. Sem chave do Nexus o
 * overlay F-566 liga o arquivo sem copiá-lo; com a chave do Nexus (F-1565) ele
 * grava uma cópia mesclada SEM as credenciais Alibaba do operador
 * (`mergeQwenSettingsForInjection`).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseJsonc } from '../../shared/jsonc';
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

/**
 * Hosts onde a chave do Qwen pode seguir SEM o operador ter escolhido a URL:
 * DashScope em qualquer região (inclui o Coding Plan) e a API direta da
 * DeepSeek. A lista é a que a própria CLI 0.25.2 conhece (dashscope[-intl|-us],
 * cn-hongkong, coding[-intl], token-plan.<região>.maas) — nunca "qualquer
 * *.aliyuncs.com", onde OSS e Function Compute de cliente também vivem.
 */
const ALIBABA_DASHSCOPE_HOST = /^(?:[a-z0-9-]+\.)?dashscope(?:-(?:intl|us))?\.aliyuncs\.com$/;
/** Planos dedicados (Token Plan por região, Coding Plan): único lugar onde a chave `sk-sp-` vale. */
const ALIBABA_PLAN_HOST = /^(?:token-plan\.[a-z0-9-]+\.maas|coding(?:-intl)?\.dashscope)\.aliyuncs\.com$/;

function isAlibabaPlanHost(host: string | null): boolean {
  return host !== null && ALIBABA_PLAN_HOST.test(host);
}

function isKnownKeyHost(host: string | null): boolean {
  return (
    host !== null &&
    (host === DEEPSEEK_DIRECT_HOST || ALIBABA_DASHSCOPE_HOST.test(host) || isAlibabaPlanHost(host))
  );
}

/**
 * URL https sem credenciais embutidas, na forma canônica de `new URL().href`
 * (host minúsculo, porta padrão fora); qualquer outra coisa é `null`.
 */
export function normalizeHttpsBaseUrl(raw: string | null | undefined): string | null {
  const text = raw?.trim();
  return text && httpsHostOf(text) ? new URL(text).href : null;
}

/**
 * F-1565: a base URL que o pane do Qwen usa quando o Nexus injeta a chave
 * configurada (vault ou conta). Ordem:
 *  1. `configured` — o campo "Base URL da API" de Providers › Qwen › Avançado
 *     (escolha explícita do operador, confirmada por diálogo nativo; https sem
 *     credencial). É o ÚNICO jeito de mandar a chave a um host fora da lista
 *     de hosts conhecidos (proxy da empresa, por exemplo).
 *  2. A base URL do `~/.qwen/settings.json`, só se for host conhecido
 *     (DashScope, planos Alibaba, DeepSeek direta). O settings é um arquivo que
 *     outro processo do operador pode ter reescrito: uma URL dele fora da lista
 *     (http, userinfo, host qualquer, lixo) nunca vira destino da chave. Chave
 *     `sk-sp-` só aceita host de plano — URL regional válida do plano (Token
 *     Plan de Pequim, Coding Plan) fica; DashScope padrão (o 401 do incidente)
 *     e DeepSeek direta não.
 *  3. Chave `sk-sp-` sem base aproveitável → a URL do Token Plan (Singapura).
 *  4. Demais casos → `null` (a CLI usa o padrão DashScope dela).
 */
export function resolveQwenInjectionBaseUrl(input: {
  readonly configured?: string | null;
  readonly settingsBaseUrl?: string | null;
  readonly key?: string | null;
}): string | null {
  const configured = normalizeHttpsBaseUrl(input.configured);
  if (configured) return configured;
  const planKey = isAlibabaPlanKey(input.key);
  const settings = normalizeHttpsBaseUrl(input.settingsBaseUrl);
  const host = httpsHostOf(settings);
  if (settings && isKnownKeyHost(host) && (!planKey || isAlibabaPlanHost(host))) {
    return settings;
  }
  return planKey ? ALIBABA_TOKEN_PLAN_OPENAI_BASE_URL : null;
}

const QWEN_SETTINGS_MAX_BYTES = 1024 * 1024;

/**
 * Lê o `settings.json` do operador para o overlay do pane. A CLI aceita
 * comentários, vírgula final e BOM (strip-json-comments), então um settings
 * válido para ela não pode derrubar o spawn do Nexus: qualquer falha (ausente,
 * EACCES, não-regular, grande demais, JSON inválido, raiz que não é objeto)
 * vira `{}`. JSON estrito primeiro, para os valores saírem exatos; JSONC só se
 * o estrito falhar (o removedor de vírgula final dele não distingue vírgula
 * dentro de string).
 */
export function readQwenOperatorSettings(file: string): Record<string, unknown> {
  const read = readRegularFileCapped(file, QWEN_SETTINGS_MAX_BYTES);
  if (read.kind !== 'text') return {};
  const text = read.text.replace(/^\uFEFF/, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    try {
      parsed = parseJsonc(text);
    } catch {
      return {};
    }
  }
  return asRecord(parsed) ?? {};
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Variável que o Nexus injeta com a chave do cofre; as entradas geradas a referenciam. */
const INJECTED_KEY_ENV = 'BAILIAN_TOKEN_PLAN_API_KEY';
/** Credenciais Alibaba do operador em `env`: na cópia, a injetada é a única. */
const OPERATOR_ALIBABA_KEY_ENV = /^(?:BAILIAN|DASHSCOPE)_/i;

/**
 * F-1565: mescla as entradas do Nexus no `settings.json` do OVERLAY do pane
 * (o arquivo do operador nunca é tocado). O Qwen Code só honra a variável
 * `BAILIAN_TOKEN_PLAN_API_KEY` quando um `modelProviders.openai[]` aponta para
 * ela via `envKey` — sem a entrada, a chave injetada morria no env e a CLI
 * usava o `security.auth.apiKey` embutido (velho) ou caía em "No auth type".
 * A entrada NUNCA carrega o segredo: só `envKey` + `baseUrl` (a forma oficial
 * da doc do Model Studio). Entrada do operador com o mesmo id vence a nossa.
 *
 * A cópia é a única credencial Alibaba do pane: sai o `security.auth.apiKey`
 * (venceria a env para um modelo fora de `models` e ficaria em disco) e as
 * `env.BAILIAN_*`/`DASHSCOPE_*` do operador. E toda linha do operador
 * alimentada pela NOSSA env (`envKey` igual) só fica se o host dela for destino
 * conhecido da chave (ou o da própria injeção): senão o settings.json, que
 * qualquer processo do operador reescreve, mandaria a chave do cofre para onde
 * quisesse. Linha OpenAI vai para a base URL resolvida (o mesmo vale para chave
 * `sk-sp-` fora de host de plano); linha de outro protocolo é descartada.
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
  const settings = { ...asRecord(raw) };
  const security = objectField(settings, 'security') ?? {};
  // A chave injetada é a credencial deste pane: a auth tem de ser a
  // OpenAI-compatible, mesmo que o perfil diga qwen-oauth (a cópia é efêmera).
  const auth: Record<string, unknown> = { ...objectField(security, 'auth'), selectedType: 'openai' };
  delete auth.apiKey;
  settings.security = { ...security, auth };
  const env = objectField(settings, 'env');
  if (env) {
    settings.env = Object.fromEntries(
      Object.entries(env).filter(([name]) => !OPERATOR_ALIBABA_KEY_ENV.test(name)),
    );
  }

  const injectedHost = httpsHostOf(options.baseUrl);
  const destinationOk = (entry: Record<string, unknown>): boolean => {
    const host = httpsHostOf(nonEmptyString(entry.baseUrl));
    if (!host) return false;
    if (host === injectedHost) return true;
    return isKnownKeyHost(host) && (!options.tokenPlanKey || isAlibabaPlanHost(host));
  };
  const providers = objectField(settings, 'modelProviders') ?? {};
  // fromEntries (e não `providers[type] = …`): uma chave `__proto__` vinda do
  // JSON do operador vira propriedade própria, nunca troca o protótipo.
  const guarded = Object.fromEntries(
    Object.entries(providers).map(([authType, rows]): [string, unknown] => [
      authType,
      Array.isArray(rows)
        ? rows.flatMap((row): unknown[] => {
            const entry = asRecord(row);
            if (!entry || nonEmptyString(entry.envKey) !== INJECTED_KEY_ENV || destinationOk(entry)) {
              return [row];
            }
            return authType === 'openai' ? [{ ...entry, baseUrl: options.baseUrl }] : [];
          })
        : rows,
    ]),
  );
  const merged = Array.isArray(guarded.openai) ? [...guarded.openai] : [];
  const known = new Set(
    merged
      .map((row) => nonEmptyString(asRecord(row)?.id)?.toLowerCase())
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
      envKey: INJECTED_KEY_ENV,
    });
  }
  settings.modelProviders = { ...guarded, openai: merged };
  return settings;
}

/** Prontidão: a chave em settings conta como `present` — nunca lida p/ fora. */
export function qwenSettingsHasCredential(home: string = os.homedir()): boolean {
  return readQwenSettingsSummary(home).hasCredential;
}
