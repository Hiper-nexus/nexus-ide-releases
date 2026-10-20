/**
 * F-724: provedor do adapter `deepseek` (CLI do Claude no endpoint
 * Anthropic-compatible) — a API direta da DeepSeek ou o Alibaba Model Studio
 * Token Plan, escolhido pelo operador em Providers › DeepSeek.
 *
 * A escolha mora no `upstream` do adapter (`deepseek` = API direta, o padrão
 * histórico; `deepseek-token-plan` = plano da Alibaba). Cada provedor tem
 * host e chave próprios e disjuntos: chave da DeepSeek nunca vai para a
 * Alibaba e chave do Token Plan (`sk-sp-…`) nunca vai para api.deepseek.com.
 *
 * Sondas de 02/10/2026 nos dois endpoints do Token Plan (Anthropic e
 * OpenAI-compatible): `deepseek-v4-pro` 200, `qwen3.8-max` 200,
 * `deepseek-v4-flash` 403 — no plano o único DeepSeek servido é o v4-pro.
 */

export const DEEPSEEK_DIRECT_PROVIDER = 'deepseek' as const;
export const DEEPSEEK_TOKEN_PLAN_PROVIDER = 'deepseek-token-plan' as const;

export type DeepseekProviderChoice =
  | typeof DEEPSEEK_DIRECT_PROVIDER
  | typeof DEEPSEEK_TOKEN_PLAN_PROVIDER;

export const DEEPSEEK_PROVIDER_CHOICES: readonly DeepseekProviderChoice[] = [
  DEEPSEEK_DIRECT_PROVIDER,
  DEEPSEEK_TOKEN_PLAN_PROVIDER,
];

export const DEEPSEEK_DIRECT_HOST = 'api.deepseek.com';
export const ALIBABA_TOKEN_PLAN_HOST =
  'token-plan.ap-southeast-1.maas.aliyuncs.com';
export const ALIBABA_TOKEN_PLAN_ANTHROPIC_BASE_URL =
  `https://${ALIBABA_TOKEN_PLAN_HOST}/apps/anthropic`;
/**
 * Endpoint OpenAI-compatible do mesmo Token Plan (o `/auth` do Qwen Code e a
 * doc oficial do Model Studio gravam este em `settings.json` ›
 * `modelProviders.openai[].baseUrl`). Chave `sk-sp-` só vale nele: no endpoint
 * padrão do DashScope ela morre em 401 "Invalid API-key".
 */
export const ALIBABA_TOKEN_PLAN_OPENAI_BASE_URL =
  `https://${ALIBABA_TOKEN_PLAN_HOST}/compatible-mode/v1`;

/** Único DeepSeek que o Token Plan serve (o flash responde 403). */
export const DEEPSEEK_TOKEN_PLAN_MODEL = 'deepseek-v4-pro';

/**
 * Ids que o provedor Token Plan não serve e que o Nexus troca pelo v4-pro —
 * uma tarefa trivial roteada para o `deepseek-flash` não pode morrer em 403.
 */
export const DEEPSEEK_TOKEN_PLAN_MODEL_ALIASES: Readonly<Record<string, string>> =
  Object.freeze({
    'deepseek-flash': DEEPSEEK_TOKEN_PLAN_MODEL,
    'deepseek-v4-flash': DEEPSEEK_TOKEN_PLAN_MODEL,
  });

/**
 * Flash do Qwen Code no Token Plan. A lista de modelos do plano (20/10/2026)
 * traz `deepseek-v4.1-flash-1017` (o mais novo), `deepseek-v4.1-flash`,
 * `deepseek-v4-flash-0731` e o `deepseek-v4-pro`; o id `deepseek-flash` do menu
 * do Qwen não existe lá e voltava "404 Model not exist". O que a pessoa pede
 * pelo nome inteiro segue como está; só os nomes genéricos do flash trocam.
 */
export const QWEN_TOKEN_PLAN_FLASH_MODEL = 'deepseek-v4.1-flash-1017';
export const QWEN_TOKEN_PLAN_MODEL_ALIASES: Readonly<Record<string, string>> =
  Object.freeze({
    'deepseek-flash': QWEN_TOKEN_PLAN_FLASH_MODEL,
    'deepseek-v4-flash': QWEN_TOKEN_PLAN_FLASH_MODEL,
  });

/** Variáveis do Qwen Code que carregam a chave do Token Plan. */
export const TOKEN_PLAN_KEY_ENV_VARS = [
  'BAILIAN_TOKEN_PLAN_API_KEY',
  'DASHSCOPE_API_KEY',
] as const;

/** Vaga do cofre que guarda a chave do Token Plan: a mesma do Qwen Code. */
export const TOKEN_PLAN_KEY_VAULT_SLOT = 'qwen';

/** Upstream salvo → provedor. Qualquer valor que não seja o plano é a API direta. */
export function deepseekProviderChoice(
  upstream: string | null | undefined,
): DeepseekProviderChoice {
  return upstream?.trim() === DEEPSEEK_TOKEN_PLAN_PROVIDER
    ? DEEPSEEK_TOKEN_PLAN_PROVIDER
    : DEEPSEEK_DIRECT_PROVIDER;
}

export function isDeepseekProviderChoice(
  value: string | null | undefined,
): value is DeepseekProviderChoice {
  return (DEEPSEEK_PROVIDER_CHOICES as readonly string[]).includes(value ?? '');
}

/** Host para onde o provedor escolhido manda a chave. */
export function deepseekProviderHost(choice: DeepseekProviderChoice): string {
  return choice === DEEPSEEK_TOKEN_PLAN_PROVIDER
    ? ALIBABA_TOKEN_PLAN_HOST
    : DEEPSEEK_DIRECT_HOST;
}

/**
 * Chave de plano da Alibaba Model Studio (Token Plan): prefixo `sk-sp-`. A
 * DeepSeek emite `sk-<hex>` — uma chave `sk-sp-` nunca é da DeepSeek.
 */
export function isAlibabaPlanKey(key: string | null | undefined): boolean {
  return typeof key === 'string' && key.trim().startsWith('sk-sp-');
}

/** Hostname de uma URL HTTPS sem credenciais embutidas; senão null. */
export function httpsHostOf(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Base URL OpenAI/Anthropic-compatible do Token Plan conferido (02/10). */
export function isAlibabaTokenPlanUrl(raw: string | null | undefined): boolean {
  return httpsHostOf(raw) === ALIBABA_TOKEN_PLAN_HOST;
}

/**
 * Provedor do DeepSeek enquanto o operador não escolheu um em Providers ›
 * DeepSeek: segue o slot `deepseek` do launcher. `deepseek-base-url` no host
 * do Token Plan, ou uma chave `sk-sp-` sem base-url, dizem que a credencial
 * que o operador deu ao DeepSeek é do plano da Alibaba — na API direta ela só
 * daria 401. Sem esses sinais, a API direta (o padrão histórico).
 */
export function defaultDeepseekProviderChoice(launcher: {
  readonly key: string | null;
  readonly baseUrl: string | null;
}): DeepseekProviderChoice {
  if (launcher.baseUrl !== null) {
    return isAlibabaTokenPlanUrl(launcher.baseUrl)
      ? DEEPSEEK_TOKEN_PLAN_PROVIDER
      : DEEPSEEK_DIRECT_PROVIDER;
  }
  return isAlibabaPlanKey(launcher.key)
    ? DEEPSEEK_TOKEN_PLAN_PROVIDER
    : DEEPSEEK_DIRECT_PROVIDER;
}

/** Modelo que o provedor escolhido realmente serve para um id pedido. */
export function deepseekModelForProvider(
  model: string,
  choice: DeepseekProviderChoice,
): string {
  if (choice !== DEEPSEEK_TOKEN_PLAN_PROVIDER) return model;
  return DEEPSEEK_TOKEN_PLAN_MODEL_ALIASES[model.trim()] ?? model;
}

/** Id do DeepSeek Flash no menu (o `deepseek-v4-flash` é alias dele). */
export const DEEPSEEK_FLASH_MODEL = 'deepseek-flash';

/**
 * F-1576: o Claude Code só serve o `deepseek-flash` quando o upstream
 * escolhido é a DeepSeek direta. Na Anthropic (assinatura ou API key) o id
 * não existe: no menu ele aparecia em 1º no grupo Claude (custo "free") e a
 * lane visual podia rotear `claude --model deepseek-flash` para a Anthropic.
 */
export function claudeModelsForUpstream(
  models: readonly string[],
  upstreamBaseUrl: string | null | undefined,
): string[] {
  if (httpsHostOf(upstreamBaseUrl) === DEEPSEEK_DIRECT_HOST) return [...models];
  return models.filter(
    (model) => model !== DEEPSEEK_FLASH_MODEL && model !== 'deepseek-v4-flash',
  );
}

/**
 * Catálogo do adapter sob o provedor: no plano saem os flash (403) e o
 * v4-pro fica garantido; na API direta nada muda.
 */
export function deepseekModelsForProvider(
  models: readonly string[],
  choice: DeepseekProviderChoice,
): string[] {
  if (choice !== DEEPSEEK_TOKEN_PLAN_PROVIDER) return [...models];
  const served = models.filter(
    (model) => !(model in DEEPSEEK_TOKEN_PLAN_MODEL_ALIASES),
  );
  return served.includes(DEEPSEEK_TOKEN_PLAN_MODEL)
    ? served
    : [DEEPSEEK_TOKEN_PLAN_MODEL, ...served];
}
