/** Bounded credential probe. The key is used in memory only at a trusted provider endpoint. */
import { createHash } from 'node:crypto';
import os from 'node:os';
import {
  QWEN_DASHSCOPE_DEFAULT_BASE_URL,
  qwenSettingsPath,
  resolveQwenInjectionBaseUrl,
} from './qwen-settings';
import { ALIBABA_TOKEN_PLAN_HOST, TOKEN_PLAN_KEY_ENV_VARS } from './deepseek-provider';
import { readRegularFileCappedAsync } from '../redline/redline-safe-read';

export type QwenReadinessState = 'present' | 'no-credential' | 'invalid-credential' | 'unknown';
export interface QwenReadinessResult { readonly state: QwenReadinessState; readonly detail?: string }
export const QWEN_PROBE_TIMEOUT_MS = 4_000;
/**
 * F-1565: 401/403 aqui é a CREDENCIAL recusada — nunca limite/cota. A chave
 * sk-sp-… do Token Plan só vale na URL exclusiva do plano; uma base URL
 * DashScope com ela dá exatamente este erro.
 */
export const QWEN_INVALID_CREDENTIAL_MESSAGE =
  'Chave inválida ou base URL incompatível com a chave (401/403) — chave ' +
  'sk-sp-… do Token Plan só vale na URL exclusiva do plano. Confira a chave ' +
  'e Avançado › Base URL em Providers › Qwen';
const DEFAULT_BASE_URL = QWEN_DASHSCOPE_DEFAULT_BASE_URL;

/**
 * F-1565: a base URL configurada em Providers › Qwen › Avançado. O dono do
 * providers.json é o provider-config-store, que registra este lookup no init
 * (este módulo é folha do grafo — importá-lo de lá criaria um ciclo).
 */
let configuredBaseUrlLookup: () => string | null = () => null;
export function setQwenProbeConfiguredBaseUrlLookup(
  lookup: (() => string | null) | null,
): void {
  configuredBaseUrlLookup = lookup ?? (() => null);
}

type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal; redirect?: 'error' }) =>
  Promise<{ status: number; body?: { cancel(): Promise<void> } | null }>;
export interface QwenProbeOptions {
  home?: string;
  key?: string | null;
  baseUrl?: string | null;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  /** Private cache identity only. Never persist, display or forward this digest. */
  onIdentity?: (identity: string) => void;
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() && value.length <= 8192 ? value.trim() : null;

function probeEndpoint(base: string): string | null {
  try {
    const url = new URL(base);
    if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' ||
        url.search || url.hash || !['dashscope.aliyuncs.com', ALIBABA_TOKEN_PLAN_HOST].includes(url.hostname) ||
        url.pathname.replace(/\/+$/, '') !== '/compatible-mode/v1') return null;
    return `${url.origin}/compatible-mode/v1/models`;
  } catch { return null; }
}

async function resolveProbe(options: QwenProbeOptions) {
  const file = await readRegularFileCappedAsync(qwenSettingsPath(options.home ?? os.homedir()), 1024 * 1024);
  let settings: Record<string, unknown> = {};
  try { if (file.kind === 'text') settings = object(JSON.parse(file.text)); } catch { /* Unknown config is not an auth rejection. */ }
  const model = object(settings.model);
  const auth = object(object(settings.security).auth);
  const env = object(settings.env);
  const rows = object(settings.modelProviders).openai;
  const candidates = Array.isArray(rows) ? rows.slice(0, 256).map(object) : [];
  const selected = candidates.find(row => row.id === model.name) ?? (candidates.length === 1 ? candidates[0] : undefined);
  const envKey = text(selected?.envKey);
  const explicitKey = text(options.key);
  const openaiAuth = !text(auth.selectedType) || auth.selectedType === 'openai';
  // Match the CLI's provider selection and env-before-settings resolution.
  // Nexus injects a configured key as BAILIAN_TOKEN_PLAN_API_KEY.
  const envValue = (name: string) => name === 'BAILIAN_TOKEN_PLAN_API_KEY' && explicitKey
    ? explicitKey : text(process.env[name]) ?? text(env[name]);
  const selectedKey = envKey ? envValue(envKey) : null;
  const environmentBase = text(process.env.OPENAI_BASE_URL);
  // An unrelated OPENAI_API_KEY must never be sent to Alibaba by fallback.
  const environmentKey = environmentBase && probeEndpoint(environmentBase) ? text(process.env.OPENAI_API_KEY) : null;
  const key = openaiAuth ? explicitKey ?? selectedKey ?? environmentKey ?? text(auth.apiKey) ??
    TOKEN_PLAN_KEY_ENV_VARS.map(envValue).find(Boolean) ?? null : explicitKey;
  // F-1565: com a chave configurada (explicitKey), o spawn a torna
  // autoritativa pelas entradas modelProviders do overlay, na base URL
  // resolvida pela mesma regra (resolveQwenInjectionBaseUrl). A sonda testa
  // o MESMO par chave+base URL que vai ao fio — antes ela provava a chave
  // nova contra a URL padrão enquanto o pane usava o apiKey velho embutido
  // no settings (ou a URL do DashScope com chave sk-sp-): o 401 do incidente.
  const base = explicitKey
    ? text(options.baseUrl) ?? resolveQwenInjectionBaseUrl({
        configured: configuredBaseUrlLookup(),
        settingsBaseUrl: text(auth.baseUrl) ?? text(model.baseUrl),
        key: explicitKey,
      }) ?? DEFAULT_BASE_URL
    : text(options.baseUrl) ?? text(selected?.baseUrl) ?? text(process.env.OPENAI_BASE_URL) ??
      text(auth.baseUrl) ?? text(model.baseUrl) ?? DEFAULT_BASE_URL;
  const identity = createHash('sha256').update(JSON.stringify([key, base, text(model.name), text(auth.selectedType)])).digest('hex');
  return { key, base, identity, nativeAuth: !openaiAuth && !explicitKey };
}

export async function probeQwenCredential(options: QwenProbeOptions = {}): Promise<QwenReadinessResult> {
  const config = await resolveProbe(options);
  options.onIdentity?.(config.identity);
  if (config.nativeAuth) return { state: 'unknown' };
  if (!config.key) return { state: 'no-credential' };
  const endpoint = probeEndpoint(config.base);
  if (!endpoint) return { state: 'unknown' };
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal?.aborted) abort(); else options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, QWEN_PROBE_TIMEOUT_MS);
  try {
    const res = await (options.fetchImpl ?? fetch)(endpoint, {
      method: 'GET', headers: { authorization: `Bearer ${config.key}` },
      signal: controller.signal, redirect: 'error',
    });
    await res.body?.cancel().catch(() => undefined);
    const current = await resolveProbe(options);
    options.onIdentity?.(current.identity);
    if (controller.signal.aborted || current.identity !== config.identity) return { state: 'unknown' };
    if (res.status === 401 || res.status === 403) return { state: 'invalid-credential', detail: QWEN_INVALID_CREDENTIAL_MESSAGE };
    return { state: res.status >= 200 && res.status < 300 ? 'present' : 'unknown' };
  } catch { return { state: 'unknown' }; }
  finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
}
