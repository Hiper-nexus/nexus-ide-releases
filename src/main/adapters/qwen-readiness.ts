/**
 * Sonda de prontidão do Qwen Code (F-238) — usada SÓ pelo painel de
 * Providers/diagnóstico (`testProviderKey`), nunca no caminho do spawn.
 *
 * `GET {baseUrl}/models` com Bearer, teto de 4 s:
 *   - 401 → `invalid-credential` (chave do Token Plan recusada);
 *   - falha de rede → `unknown` (não bloqueia spawn nem seat);
 *   - sem credencial → `no-credential`.
 * O segredo sai do settings/env apenas em memória — nunca é copiado, gravado
 * ou registrado.
 */
import { qwenSettingsPath, readQwenSettingsSummary } from './qwen-settings';
import fs from 'node:fs';
import os from 'node:os';

export type QwenReadinessState =
  | 'present'
  | 'no-credential'
  | 'invalid-credential'
  | 'unknown';

export interface QwenReadinessResult {
  readonly state: QwenReadinessState;
  readonly detail?: string;
}

export const QWEN_PROBE_TIMEOUT_MS = 4_000;

export const QWEN_INVALID_CREDENTIAL_MESSAGE =
  'Chave do Token Plan recusada (401) — renove em ModelStudio › Token Plan e cole em Providers › Qwen';

const DEFAULT_BASE_URL =
  'https://dashscope.aliyuncs.com/compatible-mode/v1';

type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ status: number }>;

/**
 * Chave do operador em ~/.qwen/settings.json, para uso apenas em memória
 * (Bearer da sonda). Retorna null quando ausente; nunca loga nem copia.
 */
function readQwenSettingsApiKey(home: string): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(qwenSettingsPath(home), 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const env = (raw as Record<string, unknown>).env;
    if (!env || typeof env !== 'object' || Array.isArray(env)) return null;
    for (const [name, value] of Object.entries(env as Record<string, unknown>)) {
      if (
        /(_API_KEY|_TOKEN|_SECRET)$/i.test(name) &&
        typeof value === 'string' &&
        value.trim().length > 0
      ) {
        return value.trim();
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function probeQwenCredential(options: {
  home?: string;
  /** Chave já resolvida (vault/launcher/env); o settings é o fallback. */
  key?: string | null;
  baseUrl?: string | null;
  fetchImpl?: FetchLike;
} = {}): Promise<QwenReadinessResult> {
  const home = options.home ?? os.homedir();
  const summary = readQwenSettingsSummary(home);
  const key =
    (typeof options.key === 'string' && options.key.trim().length > 0
      ? options.key.trim()
      : null) ?? readQwenSettingsApiKey(home);
  if (!key) {
    return summary.hasCredential
      ? { state: 'present' }
      : { state: 'no-credential' };
  }
  const baseUrl = options.baseUrl ?? summary.baseUrl ?? DEFAULT_BASE_URL;
  let endpoint: string;
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:') return { state: 'unknown' };
    endpoint = `${url.origin}${url.pathname.replace(/\/+$/, '')}/models`;
  } catch {
    return { state: 'unknown' };
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QWEN_PROBE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(endpoint, {
      method: 'GET',
      headers: { authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return {
        state: 'invalid-credential',
        detail: QWEN_INVALID_CREDENTIAL_MESSAGE,
      };
    }
    return { state: 'present' };
  } catch {
    // Rede fora do ar não bloqueia o spawn — a CLI decide na hora.
    return { state: 'unknown' };
  } finally {
    clearTimeout(timer);
  }
}
