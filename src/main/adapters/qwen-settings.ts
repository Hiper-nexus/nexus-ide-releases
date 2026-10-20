import { readRegularFileCapped, readRegularFileCappedAsync } from '../redline/redline-safe-read';
/**
 * Leitor somente-leitura do `~/.qwen/settings.json` (F-238).
 *
 * O Qwen Code não tem `qwen auth`: a credencial e o catálogo de modelos vivem
 * no settings do operador (`env.BAILIAN_TOKEN_PLAN_API_KEY`,
 * `modelProviders.openai[].id`, `model.baseUrl`). Este módulo nunca devolve o
 * valor da chave — só presença, baseUrl e ids de modelo. Sem chave do Nexus o
 * overlay F-566 liga o arquivo sem copiá-lo; com a chave do Nexus (F-1567) ele
 * grava uma cópia mesclada SEM as credenciais Alibaba do operador
 * (`mergeQwenSettingsForInjection`, layer de usuário) e um settings de SISTEMA à
 * parte, só com o que o Nexus impõe por cima do workspace e do admin real
 * (`mergeQwenSystemSettingsForInjection`).
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
  QWEN_TOKEN_PLAN_FLASH_MODEL,
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
   * `security.auth.baseUrl` — endpoint da auth OpenAI-compatible. F-1567: a
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
  try { return parseQwenSettingsSummary(parseQwenOperatorSettingsText(fs.readFileSync(qwenSettingsPath(home), 'utf8'))); }
  catch { return parseQwenSettingsSummary(null); }
}

export async function readQwenSettingsSummaryAsync(home: string = os.homedir()): Promise<QwenSettingsSummary> {
  const result = await readRegularFileCappedAsync(qwenSettingsPath(home), 1024 * 1024);
  try { return parseQwenSettingsSummary(result.kind === 'text' ? parseQwenOperatorSettingsText(result.text) : null); }
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

  if (tokenPlan) {
    modelIds.add(DEEPSEEK_TOKEN_PLAN_MODEL);
    modelIds.add(QWEN_TOKEN_PLAN_FLASH_MODEL);
  }

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
 * Destinos onde a chave do Qwen pode seguir SEM o operador ter escolhido a URL:
 * lista FECHADA de autoridade + caminho exatos, extraída do bundle da Qwen Code
 * 0.25.2 (DashScope por região, Coding Plan, Token Plan Pequim/Singapura) mais
 * a API direta da DeepSeek. Nada de regex de subdomínio: `*.dashscope.aliyuncs.com`
 * ou `*.aliyuncs.com` abrigam hosts de terceiros. `plan` = host de plano, o
 * único onde a chave `sk-sp-` vale.
 */
const KNOWN_KEY_DESTINATIONS: ReadonlyMap<string, { readonly paths: readonly string[]; readonly plan: boolean }> =
  new Map([
    ['dashscope.aliyuncs.com', { paths: ['/compatible-mode/v1'], plan: false }],
    ['dashscope-intl.aliyuncs.com', { paths: ['/compatible-mode/v1'], plan: false }],
    ['dashscope-us.aliyuncs.com', { paths: ['/compatible-mode/v1'], plan: false }],
    ['cn-hongkong.dashscope.aliyuncs.com', { paths: ['/compatible-mode/v1'], plan: false }],
    ['coding.dashscope.aliyuncs.com', { paths: ['/v1'], plan: true }],
    ['coding-intl.dashscope.aliyuncs.com', { paths: ['/v1'], plan: true }],
    ['token-plan.cn-beijing.maas.aliyuncs.com', { paths: ['/compatible-mode/v1'], plan: true }],
    ['token-plan.ap-southeast-1.maas.aliyuncs.com', { paths: ['/compatible-mode/v1'], plan: true }],
    [DEEPSEEK_DIRECT_HOST, { paths: ['', '/v1'], plan: false }],
  ]);

/**
 * A URL canônica se (e só se) for destino conhecido da chave: https, sem
 * userinfo, porta 443 implícita, sem query/fragmento e caminho exato da lista.
 * `new URL` já resolve punycode/maiúsculas; o `Map` compara a forma ASCII.
 */
function knownKeyDestination(raw: string | null | undefined): { href: string; plan: boolean } | null {
  const text = raw?.trim();
  if (!text || text.includes('#') || text.includes('?')) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const entry = KNOWN_KEY_DESTINATIONS.get(url.hostname);
    const pathname = url.pathname.replace(/\/+$/, '');
    if (!entry || !entry.paths.includes(pathname)) return null;
    return { href: `https://${url.hostname}${pathname}`, plan: entry.plan };
  } catch {
    return null;
  }
}

/** Exact OpenAI-compatible endpoint for the bounded readiness probe. */
export function qwenOpenAiModelsEndpoint(raw: string | null | undefined): string | null {
  const destination = knownKeyDestination(raw);
  return destination ? `${destination.href}/models` : null;
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
 * F-1567: a base URL que o pane do Qwen usa quando o Nexus injeta a chave
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
  const settings = knownKeyDestination(input.settingsBaseUrl);
  if (settings && (!planKey || settings.plan)) return settings.href;
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
  try {
    return asRecord(parseQwenOperatorSettingsText(read.text)) ?? {};
  } catch {
    return {};
  }
}

/**
 * Mesmo parser do leitor do overlay e dos resumos (BOM + comentários + vírgula
 * final, como a CLI): a decisão da base URL e o overlay enxergam o mesmo
 * arquivo. Estrito primeiro; JSONC só se falhar. Lança se nenhum dos dois lê.
 */
export function parseQwenOperatorSettingsText(raw: string): unknown {
  const text = raw.replace(/^\uFEFF/, '');
  try {
    return JSON.parse(text);
  } catch {
    return parseJsonc(text);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Per-spawn secret variable names must be unpredictable to operator settings. */
export const QWEN_INJECTED_KEY_ENV_PREFIX = 'NEXUS_QWEN_KEY_';
const INJECTED_KEY_ENV = new RegExp(`^${QWEN_INJECTED_KEY_ENV_PREFIX}[a-f0-9]{32}$`, 'i');
/** Nomes de credencial que o `env` do operador não leva para a cópia: a injetada e as velhas. */
const OPERATOR_NEXUS_KEY_ENV = /^(?:BAILIAN_|DASHSCOPE_|OPENAI_API_KEY$|OPENAI_BASE_URL$|NEXUS_QWEN_KEY_)/i;
/** O mesmo conjunto em qualquer ponto de um nome interpolado (`${X:-$BAILIAN_…}`). */
const PROTECTED_ENV_TOKEN = /BAILIAN_|DASHSCOPE_|OPENAI_API_KEY|OPENAI_BASE_URL|NEXUS_QWEN_KEY_/i;
/**
 * A sintaxe que a Qwen Code 0.25.2 expande em QUALQUER string de um settings:
 * `\$(?:(\w+)|{([^}]+)})`, numa passada. Não há escape (`$$X` ainda expande o
 * `$X`) nem `:-padrão` (`${X:-d}` procura uma variável chamada `X:-d`). Este
 * detector é de propósito um SUPERCONJUNTO dessas formas.
 */
const INTERPOLATION = /\$(?:\{([^}]+)\}|(\w+))/g;
/** Placeholders de runtime que a CLI deixa literais: não consultam o ambiente. */
const RUNTIME_PLACEHOLDER = /^(?:session_id|qwen_code_session_id)$/i;

function isNexusKeyEnv(name: string): boolean {
  return OPERATOR_NEXUS_KEY_ENV.test(name);
}

function interpolatedNames(value: string): string[] {
  return [...value.matchAll(INTERPOLATION)]
    .map((match) => match[1] ?? match[2] ?? '')
    .filter((name) => !RUNTIME_PLACEHOLDER.test(name));
}

/** Caminhos (só nomes de chave/índices, nunca valores) das strings que interpolam. */
function interpolationPaths(value: unknown, at: string): string[] {
  if (typeof value === 'string') return interpolatedNames(value).length > 0 ? [at] : [];
  if (Array.isArray(value)) return value.flatMap((item, i) => interpolationPaths(item, `${at}[${i}]`));
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, item]) => interpolationPaths(item, `${at}.${key}`));
}

/** Alguma string do valor, em qualquer profundidade, interpola uma variável. */
function containsInterpolation(value: unknown): boolean {
  if (typeof value === 'string') return interpolatedNames(value).length > 0;
  if (Array.isArray(value)) return value.some(containsInterpolation);
  return Boolean(value && typeof value === 'object' && Object.values(value).some(containsInterpolation));
}

function containsNexusInterpolation(value: unknown): boolean {
  if (typeof value === 'string') {
    return interpolatedNames(value).some((name) => PROTECTED_ENV_TOKEN.test(name));
  }
  if (Array.isArray(value)) return value.some(containsNexusInterpolation);
  return Boolean(value && typeof value === 'object' && Object.values(value).some(containsNexusInterpolation));
}

/** Drop protected interpolations from unrelated settings without mutating operator data. */
function redactNexusInterpolations(value: unknown): unknown {
  if (typeof value === 'string') return containsNexusInterpolation(value) ? undefined : value;
  if (Array.isArray(value)) return value
    .map(redactNexusInterpolations)
    .filter((item) => item !== undefined);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      const redacted = redactNexusInterpolations(item);
      return redacted === undefined ? [] : [[key, redacted]];
    }),
  );
}

function sameEnvKey(a: string | null, b: string): boolean {
  return a !== null && a.toUpperCase() === b.toUpperCase();
}

/** Instrução do Nexus para os dois arquivos do overlay (sem segredo). */
interface QwenInjectionOptions {
  readonly baseUrl: string;
  readonly models: readonly string[];
  /** A chave injetada é do Token Plan (`sk-sp-`). */
  readonly tokenPlanKey: boolean;
  /** Per-spawn random variable that is the only path to the vault key. */
  readonly envKey: string;
}

function assertInjectedKeyEnv(envKey: string): void {
  if (!INJECTED_KEY_ENV.test(envKey)) {
    throw new Error('invalid Qwen injected key environment name');
  }
}

/** Destino que uma linha do operador alimentada pela NOSSA variável pode manter. */
function safeRowDestination(entry: Record<string, unknown>, options: QwenInjectionOptions): string | null {
  const injectedUrl = normalizeHttpsBaseUrl(options.baseUrl);
  const url = nonEmptyString(entry.baseUrl);
  if (injectedUrl && normalizeHttpsBaseUrl(url) === injectedUrl) return injectedUrl;
  const known = knownKeyDestination(url);
  return known !== null && (!options.tokenPlanKey || known.plan) ? known.href : null;
}

/**
 * F4: a mescla descarta a ENTRADA que interpola, nunca o bloco. Um `$` perdido em
 * uma variável, em uma linha do catálogo ou em um campo da auth tira só aquela
 * peça; o resto da config legítima do operador atravessa intacto.
 */
function operatorEnvEntries(env: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(env).filter(([name, value]) => !isNexusKeyEnv(name) && !containsInterpolation(value)),
  );
}

/** A auth da cópia: o que o operador tinha, sem a chave embutida e sem campo que interpole. */
function operatorAuthFields(auth: Record<string, unknown> | null): Record<string, unknown> {
  const kept = Object.fromEntries(
    Object.entries(auth ?? {}).filter(([, value]) => !containsInterpolation(value)),
  );
  delete kept.apiKey;
  return { ...kept, selectedType: 'openai' };
}

/**
 * Linhas de `modelProviders.<authType>`: sai a que interpola (F4: só ela); fica
 * a que tem outra `envKey`, inclusive os nomes legados `BAILIAN_*`, `DASHSCOPE_*`
 * e `OPENAI_*` (F1: credencial do próprio operador, que a cópia deixou sem
 * valor, então a linha falha às claras em vez de usar a chave velha); a que usa
 * a NOSSA variável (caixa à parte, como no Windows) vai para um destino conhecido
 * ou para a URL resolvida. Uma linha legada de um modelo que o Nexus cobre é
 * RELIGADA à nossa variável (os campos do operador, como `generationConfig`,
 * ficam): ela leria justo a variável que a cópia esvaziou, e deixá-la sombrear a
 * nossa (mesmo id) devolveria o pane ao "chave salva que nunca chega ao fio".
 */
function guardOperatorRows(authType: string, rows: unknown, options: QwenInjectionOptions): unknown {
  if (!Array.isArray(rows)) return containsInterpolation(rows) ? undefined : rows;
  const covered = new Set(options.models.map((model) => model.trim().toLowerCase()));
  return rows.flatMap((row): unknown[] => {
    if (containsInterpolation(row)) return [];
    const entry = asRecord(row);
    if (!entry) return [row];
    const envKey = nonEmptyString(entry.envKey);
    const id = nonEmptyString(entry.id)?.toLowerCase();
    const legacyForCoveredModel =
      authType === 'openai' && envKey !== null && isNexusKeyEnv(envKey) && id !== undefined && covered.has(id);
    if (!sameEnvKey(envKey, options.envKey) && !legacyForCoveredModel) return [row];
    // Outro protocolo nunca recebe a chave OpenAI-compatible do cofre.
    if (authType !== 'openai') return [];
    return [{ ...entry, baseUrl: safeRowDestination(entry, options) ?? options.baseUrl, envKey: options.envKey }];
  });
}

/** Acrescenta ao catálogo as linhas do Nexus (id ainda não definido), sem segredo. */
function appendInjectedRows(rows: readonly unknown[], options: QwenInjectionOptions): unknown[] {
  const merged = [...rows];
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
      envKey: options.envKey,
    });
  }
  return merged;
}

/**
 * F-1567: mescla as entradas do Nexus no `settings.json` de USUÁRIO do overlay
 * do pane (o arquivo do operador nunca é tocado). O Qwen Code só honra a variável
 * da chave injetada quando um `modelProviders.openai[]` aponta para ela via
 * `envKey` — sem a entrada, a chave injetada morria no env e a CLI usava o
 * `security.auth.apiKey` embutido (velho) ou caía em "No auth type".
 * A entrada NUNCA carrega o segredo: só `envKey` + `baseUrl` (a forma oficial
 * da doc do Model Studio). Entrada do operador com o mesmo id vence a nossa,
 * salvo a que lê uma credencial legada, que é religada à nossa variável (ver
 * `guardOperatorRows`).
 *
 * A cópia é a única credencial Alibaba do pane: sai o `security.auth.apiKey`
 * (venceria a env para um modelo fora de `models` e ficaria em disco) e as
 * `env.BAILIAN_*`/`DASHSCOPE_*`/OpenAI do operador. A variável injetada tem um
 * sufixo aleatório por spawn, e a entrada de `env`/`modelProviders`/`security.auth`
 * que interpola `$` é descartada (só ela, F4): um settings que o operador possa
 * reescrever não descobre nem redireciona a chave do cofre. Uma coincidência
 * de nome (inclusive por caixa no Windows) é normalizada para o destino
 * injetado conhecido.
 *
 * Este é o layer de USUÁRIO: a precedência user<workspace da CLI fica como o
 * operador a conhece. O que o Nexus IMPÕE por cima do workspace vai à parte, em
 * `mergeQwenSystemSettingsForInjection`.
 */
export function mergeQwenSettingsForInjection(
  raw: unknown,
  options: QwenInjectionOptions,
): Record<string, unknown> {
  assertInjectedKeyEnv(options.envKey);
  const rawSettings = asRecord(raw) ?? {};
  const settings = { ...(asRecord(redactNexusInterpolations(rawSettings)) ?? {}) };
  // A chave injetada é a credencial deste pane: a auth tem de ser a
  // OpenAI-compatible, mesmo que o perfil diga qwen-oauth (a cópia é efêmera).
  settings.security = {
    ...(objectField(settings, 'security') ?? {}),
    auth: operatorAuthFields(objectField(objectField(rawSettings, 'security'), 'auth')),
  };
  // L2: o descarte por `$` não é silencioso — só caminhos, nunca valores.
  const dropped = [
    ...interpolationPaths(rawSettings.env, 'env'),
    ...interpolationPaths(rawSettings.modelProviders, 'modelProviders'),
    ...interpolationPaths(objectField(rawSettings, 'security')?.auth, 'security.auth'),
  ];
  if (dropped.length > 0) {
    console.warn(`[qwen-settings] entradas com interpolação "$" descartadas da cópia do pane: ${dropped.join(', ')}`);
  }
  const rawEnv = objectField(rawSettings, 'env');
  if (rawEnv) settings.env = operatorEnvEntries(rawEnv);
  else delete settings.env;

  // fromEntries (e não `providers[type] = …`): uma chave `__proto__` vinda do
  // JSON do operador vira propriedade própria, nunca troca o protótipo.
  const guarded = Object.fromEntries(
    Object.entries(objectField(rawSettings, 'modelProviders') ?? {}).flatMap(
      ([authType, rows]): Array<[string, unknown]> => {
        const kept = guardOperatorRows(authType, rows, options);
        return kept === undefined ? [] : [[authType, kept]];
      },
    ),
  );
  settings.modelProviders = {
    ...guarded,
    openai: appendInjectedRows(Array.isArray(guarded.openai) ? guarded.openai : [], options),
  };
  return settings;
}

/**
 * Caminhos de settings de SISTEMA (admin) que a Qwen Code leria neste pane se o
 * Nexus não os redirecionasse — espelho do `getSystemSettingsPath` /
 * `getSystemDefaultsPath` da 0.25.2. Os defaults andam junto do arquivo de
 * sistema (`system-defaults.json` ao lado), então redirecionar um sem fixar o
 * outro também derruba os defaults do admin.
 */
export function qwenSystemSettingsPaths(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): { readonly settings: string; readonly defaults: string } {
  const flavor = platform === 'win32' ? path.win32 : path.posix;
  const settings = env.QWEN_CODE_SYSTEM_SETTINGS_PATH
    || (platform === 'darwin'
      ? '/Library/Application Support/QwenCode/settings.json'
      : platform === 'win32'
        ? 'C:\\ProgramData\\qwen-code\\settings.json'
        : '/etc/qwen-code/settings.json');
  const defaults = env.QWEN_CODE_SYSTEM_DEFAULTS_PATH
    || flavor.join(flavor.dirname(settings), 'system-defaults.json');
  return { settings, defaults };
}

/**
 * Lê o settings de SISTEMA do operador/admin (política, não preferência), com o
 * mesmo critério da CLI (`existsSync` e depois a leitura): o que ela não enxerga
 * (ausente, link pendurado, diretório pai sem acesso) é `{}`; o que ela enxerga e
 * não consegue ler (sem permissão, grande demais, não regular, inválido) LANÇA. A
 * CLI nativa também recusa subir com um arquivo de sistema quebrado, e ignorá-lo
 * em silêncio soltaria o pane sem a política que o admin pôs.
 */
export function readQwenSystemSettings(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  const read = readRegularFileCapped(file, QWEN_SETTINGS_MAX_BYTES);
  const parsed = read.kind === 'text' ? readableSystemSettings(read.text) : null;
  if (!parsed) {
    throw new Error(`Qwen system settings at ${file} are unreadable or invalid; fix or remove the file`);
  }
  return parsed;
}

function readableSystemSettings(text: string): Record<string, unknown> | null {
  try {
    return asRecord(parseQwenOperatorSettingsText(text));
  } catch {
    return null;
  }
}

/**
 * F2/F3: o layer de SISTEMA do pane (`QWEN_CODE_SYSTEM_SETTINGS_PATH`). Na CLI
 * ele vence o workspace e o usuário, então leva SÓ o que o Nexus impõe:
 *  - o catálogo `modelProviders.openai` com as linhas geradas (na CLI a lista de
 *    um layer mais alto SUBSTITUI a de baixo, então o catálogo imposto carrega as
 *    linhas que a CLI mostraria sem nós: as do admin, ou as do operador já
 *    saneadas) — um `modelProviders` do workspace não tira a linha da chave;
 *  - endurecimento: a auth fixada na OpenAI-compatible, com `apiKey` e
 *    `OPENAI_API_KEY` de `env` vazias (a credencial que o ADMIN provisionou é
 *    preservada: não é do Nexus apagá-la). Um modelo fora do catálogo cai nesses
 *    caminhos de ambiente/auth, e o settings de um workspace (que pode
 *    interpolar a variável do cofre se souber o nome) não pode abastecê-los.
 *    Sem pino de `OPENAI_BASE_URL`: sem chave ele não leva nada, e a CLI exporta
 *    todo valor de `env` ao pane e aos filhos (o `OPENAI_API_KEY=` vazio já é o
 *    custo mínimo; um dotenv sem override não o preenche).
 * O resto das chaves do operador (model, ui, env, …) fica no layer de USUÁRIO,
 * então a precedência user<workspace não muda. O settings de sistema REAL do
 * admin entra por baixo, intacto, e as chaves impostas vencem só onde colidem.
 * Não impomos `folderTrust` (ignoraria o `.qwen/settings.json` do projeto) nem
 * `disableAllHooks` (desligaria os hooks do operador): ver docs/qa/items/F-1567.md.
 */
export function mergeQwenSystemSettingsForInjection(
  rawSystem: unknown,
  userLayer: Record<string, unknown>,
  options: QwenInjectionOptions,
): Record<string, unknown> {
  assertInjectedKeyEnv(options.envKey);
  const system = asRecord(rawSystem) ?? {};
  const providers = objectField(system, 'modelProviders') ?? {};
  const userOpenai = objectField(userLayer, 'modelProviders')?.openai;
  const openai = Array.isArray(providers.openai)
    ? appendInjectedRows(providers.openai, options)
    : Array.isArray(userOpenai)
      ? userOpenai
      : appendInjectedRows([], options);
  const security = objectField(system, 'security') ?? {};
  const adminAuth = objectField(security, 'auth') ?? {};
  const adminEnv = objectField(system, 'env') ?? {};
  // L1: credencial provisionada pelo ADMIN fica (ela já vence o workspace, e a
  // chave do cofre só viaja pelo nome aleatório). O pino zera só o que está vazio.
  return {
    ...system,
    security: {
      ...security,
      auth: { ...adminAuth, selectedType: 'openai', apiKey: nonEmptyString(adminAuth.apiKey) ?? '' },
    },
    env: { ...adminEnv, OPENAI_API_KEY: nonEmptyString(adminEnv.OPENAI_API_KEY) ?? '' },
    modelProviders: { ...providers, openai },
  };
}

/** Prontidão: a chave em settings conta como `present` — nunca lida p/ fora. */
export function qwenSettingsHasCredential(home: string = os.homedir()): boolean {
  return readQwenSettingsSummary(home).hasCredential;
}
