/**
 * Meta Muse subscription quota probe (Muse Code plans: Everyday/High/
 * Power/Maximum Usage).
 *
 * The Meta Model API publishes no usage/quota endpoint. The numbers the
 * `muse` CLI shows in `/usage` (Current window + Weekly) travel inline in
 * inference responses: a streamed `POST https://api.meta.ai/v1/responses`
 * carries an SSE event with a `subscription` snapshot
 * (`window` = rolling prompt window, usually 300 min; `weekly` = weekly
 * quota; percent/reset values arrive as strings).
 *
 * A probe is therefore one minimal real request ("ping", 16 output tokens)
 * whose stream is closed as soon as the snapshot arrives. It spends a
 * negligible prompt from the same 5h window it measures — the QuotaService
 * TTL/backoff bounds how often that can happen. Never invents percentages:
 * any failure returns null windows.
 */

import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import {
  readRegularFileCapped,
  readRegularFileCappedAsync,
} from '../redline/redline-safe-read';
import type { QuotaWindow } from '../../shared/quota-types';
import { knownWindow } from './quota-normalize';
import type { FetchLike } from './claude-oauth-usage';
import {
  MUSE_KEYCHAIN_SERVICE,
  museAuthBlobIsUsable,
  museKeychainDelegatedProviders,
} from '../adapters/subscription-auth';

export const MUSE_RESPONSES_URL = 'https://api.meta.ai/v1/responses';
export const MUSE_USAGE_TIMEOUT_MS = 10_000;
export const MUSE_DEFAULT_PROBE_MODEL = 'muse-spark-1.3';

interface MuseWindowRaw {
  used_percent?: unknown;
  resets_at?: unknown;
  window_duration_mins?: unknown;
}

interface MuseSubscriptionRaw {
  window?: MuseWindowRaw;
  weekly?: MuseWindowRaw;
}

function percentToRatio(raw: unknown): number | null {
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n / 100));
}

function resetAtMs(raw: unknown): number | undefined {
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return undefined;
  return n > 1e12 ? n : n * 1000;
}

function windowLabel(raw: MuseWindowRaw): string {
  const mins = typeof raw.window_duration_mins === 'string'
    ? Number(raw.window_duration_mins)
    : raw.window_duration_mins;
  if (typeof mins !== 'number' || !Number.isFinite(mins) || mins === 300) return '5 Horas';
  return mins >= 60 ? `${Math.round(mins / 60)} Horas` : 'Atual';
}

/** First usable subscription snapshot in a value, or null (placeholders skip). */
function usableSubscription(value: unknown): MuseSubscriptionRaw | null {
  if (!value || typeof value !== 'object') return null;
  const sub = value as MuseSubscriptionRaw;
  const hasWindow = percentToRatio(sub.window?.used_percent) !== null;
  const hasWeekly = percentToRatio(sub.weekly?.used_percent) !== null;
  return hasWindow || hasWeekly ? sub : null;
}

function subscriptionFromEvent(event: unknown): MuseSubscriptionRaw | null {
  if (!event || typeof event !== 'object') return null;
  const root = event as Record<string, unknown>;
  return (
    usableSubscription(root.subscription) ??
    usableSubscription(root.subs_usage) ??
    usableSubscription(
      root.response && typeof root.response === 'object'
        ? (root.response as Record<string, unknown>).subscription
        : null,
    )
  );
}

/**
 * Parse SSE text (or a plain JSON body) into quota windows from the first
 * usable `subscription` snapshot. Placeholder frames such as
 * `{"subscription":{"window":{}}}` are skipped, never read as 0%.
 */
export function parseMuseSubscriptionWindows(
  text: string,
  now = Date.now(),
): QuotaWindow[] {
  if (!text) return [];
  let snapshot: MuseSubscriptionRaw | null = null;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    const payload = trimmed.startsWith('data:')
      ? trimmed.slice(5).trim()
      : trimmed.startsWith('{')
        ? trimmed
        : '';
    if (!payload || payload === '[DONE]') continue;
    try {
      snapshot = subscriptionFromEvent(JSON.parse(payload));
    } catch {
      snapshot = null;
    }
    if (snapshot) break;
  }
  if (!snapshot) {
    try {
      snapshot = subscriptionFromEvent(JSON.parse(text));
    } catch {
      snapshot = null;
    }
  }
  if (!snapshot) return [];

  const out: QuotaWindow[] = [];
  const win = snapshot.window;
  if (win) {
    const ratio = percentToRatio(win.used_percent);
    if (ratio !== null) {
      out.push(knownWindow({
        kind: 'hours',
        label: windowLabel(win),
        usedRatio: ratio,
        source: 'provider-api',
        confidence: 'high',
        resetsAt: resetAtMs(win.resets_at),
        now,
      }));
    }
  }
  const weekly = snapshot.weekly;
  if (weekly) {
    const ratio = percentToRatio(weekly.used_percent);
    if (ratio !== null) {
      out.push(knownWindow({
        kind: 'weekly',
        label: 'Semanal',
        usedRatio: ratio,
        source: 'provider-api',
        confidence: 'high',
        resetsAt: resetAtMs(weekly.resets_at),
        now,
      }));
    }
  }
  return out;
}

export interface MuseUsageProbe {
  windows: QuotaWindow[] | null;
  /** 401/403 — credential rejected by Meta (dead grant → re-login). */
  authFailed?: boolean;
}

interface StreamBodyLike {
  getReader?: () => {
    read(): Promise<{ done: boolean; value?: Uint8Array }>;
    cancel?: () => Promise<void>;
  };
}

/** Read a streamed body only until the snapshot parses; then stop. */
async function readStreamUntilSnapshot(
  body: StreamBodyLike,
  stop: () => void,
  now: number,
): Promise<QuotaWindow[] | null> {
  const reader = body.getReader?.();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) text += decoder.decode(value, { stream: true });
      const windows = parseMuseSubscriptionWindows(text, now);
      if (windows.length > 0) {
        // Snapshot in hand: close instead of holding the dummy generation
        // open against the operator's own window.
        stop();
        await reader.cancel?.().catch(() => undefined);
        return windows;
      }
      if (text.length > 512_000) break;
    }
  } catch {
    // Abort after a successful parse lands here too — re-parse what we have.
  }
  const windows = parseMuseSubscriptionWindows(text, now);
  return windows.length > 0 ? windows : null;
}

/**
 * One minimal streamed probe against the Responses API. Returns the
 * subscription windows or an honest failure (`authFailed` only on 401/403).
 */
export async function probeMuseUsageWindows(
  apiKey: string,
  opts?: {
    fetchImpl?: FetchLike;
    timeoutMs?: number;
    now?: number;
    model?: string;
  },
): Promise<MuseUsageProbe> {
  const key = apiKey?.trim();
  if (!key) return { windows: null };
  const fetchImpl = opts?.fetchImpl ?? (globalThis.fetch as FetchLike);
  if (typeof fetchImpl !== 'function') return { windows: null };

  const timeoutMs = opts?.timeoutMs ?? MUSE_USAGE_TIMEOUT_MS;
  const now = opts?.now ?? Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(MUSE_RESPONSES_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model: opts?.model?.trim() || MUSE_DEFAULT_PROBE_MODEL,
        input: 'ping',
        stream: true,
        max_output_tokens: 16,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      return { windows: null, authFailed: res.status === 401 || res.status === 403 };
    }
    const body = (res as { body?: StreamBodyLike }).body;
    if (body?.getReader) {
      const windows = await readStreamUntilSnapshot(body, () => controller.abort(), now);
      return { windows };
    }
    const text = await res.text();
    const windows = parseMuseSubscriptionWindows(text, now);
    return { windows: windows.length > 0 ? windows : null };
  } catch {
    return { windows: null };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Credential resolution (mesmas fontes do `muse login`; segredo nunca sai
// da memória, nunca é registrado nem gravado).
// ---------------------------------------------------------------------------

export interface MuseLoginCredential {
  apiKey: string;
  model: string;
}

export interface MuseLoginResolveOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Test seam: conteúdo bruto do auth.json (null = ausente/ilegível). */
  readAuthFile?: () => string | null | Promise<string | null>;
  /** Test seam: segredo do cofre do SO para a conta do provider. */
  readPlatformSecret?: (account: string) => string | null | Promise<string | null>;
}

/** F-1417: auth.json/settings.json de terceiros — teto e só arquivo regular. */
export const MUSE_CONFIG_MAX_BYTES = 256 * 1024;

/** Mesma resolução de caminho de `museAuthPath` (subscription-auth). */
function museAuthFilePath(
  home: string,
  env: NodeJS.ProcessEnv,
): string {
  const override = env.MUSE_AUTH_PATH?.trim();
  if (override) return override;
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(home, '.config'), 'muse', 'auth.json');
}

function museSettingsModel(home: string, env: NodeJS.ProcessEnv): string | null {
  try {
    const xdg = env.XDG_CONFIG_HOME?.trim();
    const file = path.join(
      xdg && path.isAbsolute(xdg) ? xdg : path.join(home, '.config'), 'muse', 'settings.json',
    );
    // O_NONBLOCK + arquivo regular + teto: um FIFO aqui não pendura o Main.
    const read = readRegularFileCapped(file, MUSE_CONFIG_MAX_BYTES);
    if (read.kind !== 'text') return null;
    const parsed = JSON.parse(read.text) as { model?: unknown };
    return typeof parsed.model === 'string' && parsed.model.trim() ? parsed.model.trim() : null;
  } catch {
    return null;
  }
}

/** Probe model: META_MUSE_MODEL → settings.json do muse → padrão. */
export function resolveMuseProbeModel(
  home = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.META_MUSE_MODEL?.trim() || museSettingsModel(home, env) || MUSE_DEFAULT_PROBE_MODEL;
}

function cleanKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const key = raw.trim();
  return key && !/\s/.test(key) ? key : null;
}

/** Payload do cofre: JSON {api_key, access_token} ou o token cru. */
function platformSecretKey(payload: string): string | null {
  const trimmed = payload.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as { api_key?: unknown; access_token?: unknown };
    return cleanKey(parsed.api_key) ?? cleanKey(parsed.access_token);
  } catch {
    return cleanKey(trimmed);
  }
}

/** Sucesso guardado: o tick de cota não volta ao cofre a cada minuto. */
export const MUSE_SECRET_CACHE_TTL_MS = 10 * 60_000;
/** Negado/travado: não reabre o diálogo do Keychain em laço. */
export const MUSE_SECRET_DENIED_BACKOFF_MS = 5 * 60_000;

type MuseSecretCacheEntry = { value: string | null; until: number };
const museSecretCache = new Map<string, MuseSecretCacheEntry>();
const museSecretFlights = new Map<string, Promise<string | null>>();

/** Test seam + limpeza depois de `muse login`. */
export function clearMuseSecretCache(): void {
  museSecretCache.clear();
  museSecretFlights.clear();
}

type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: { timeout: number; killSignal: NodeJS.Signals; windowsHide: boolean; encoding: 'utf8' },
  callback: (error: (Error & { code?: unknown }) | null, stdout: string) => void,
) => unknown;

/**
 * Segredo do cofre do SO por conta do provider — ASSÍNCRONO (F-1417). O
 * `execFileSync` antigo rodava dentro do tick de cota e travava o Main até
 * 5 s por conta delegada. Agora: `execFile` com teto, uma leitura em voo por
 * conta, sucesso guardado por 10 min e negação em backoff de 5 min. O valor
 * só existe em memória; nunca é registrado nem gravado.
 */
export function readMusePlatformSecret(
  account: string,
  execImpl: ExecFileLike = execFile as unknown as ExecFileLike,
  now: () => number = Date.now,
): Promise<string | null> {
  const held = museSecretCache.get(account);
  if (held && now() < held.until) return Promise.resolve(held.value);
  const flight = museSecretFlights.get(account);
  if (flight) return flight;
  const command =
    process.platform === 'darwin'
      ? { file: 'security', args: ['find-generic-password', '-s', MUSE_KEYCHAIN_SERVICE, '-a', account, '-w'] }
      : process.platform === 'linux'
        ? { file: 'secret-tool', args: ['lookup', 'service', MUSE_KEYCHAIN_SERVICE, 'account', account] }
        : null;
  if (!command) return Promise.resolve(null);
  const pending = new Promise<string | null>((resolve) => {
    try {
      execImpl(command.file, command.args, {
        timeout: 5_000,
        killSignal: 'SIGKILL',
        windowsHide: true,
        encoding: 'utf8',
      }, (error, stdout) => {
        if (!error) {
          const value = typeof stdout === 'string' && stdout.trim() ? stdout : null;
          museSecretCache.set(account, { value, until: now() + MUSE_SECRET_CACHE_TTL_MS });
          resolve(value);
          return;
        }
        // 44 = item ausente no macOS: resposta definitiva, cache curto igual.
        const backoff = error.code === 44 ? MUSE_SECRET_CACHE_TTL_MS : MUSE_SECRET_DENIED_BACKOFF_MS;
        museSecretCache.set(account, { value: null, until: now() + backoff });
        resolve(null);
      });
    } catch {
      museSecretCache.set(account, { value: null, until: now() + MUSE_SECRET_DENIED_BACKOFF_MS });
      resolve(null);
    }
  }).finally(() => museSecretFlights.delete(account));
  museSecretFlights.set(account, pending);
  return pending;
}

async function authBlobAsync(opts: MuseLoginResolveOptions, home: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  if (opts.readAuthFile) return opts.readAuthFile();
  const read = await readRegularFileCappedAsync(museAuthFilePath(home, env), MUSE_CONFIG_MAX_BYTES);
  return read.kind === 'text' ? read.text : null;
}

function authBlobSync(opts: MuseLoginResolveOptions, home: string, env: NodeJS.ProcessEnv): string | null {
  if (opts.readAuthFile) {
    const value = opts.readAuthFile();
    return typeof value === 'string' ? value : null;
  }
  const read = readRegularFileCapped(museAuthFilePath(home, env), MUSE_CONFIG_MAX_BYTES);
  return read.kind === 'text' ? read.text : null;
}

/**
 * Resolve a credencial da assinatura Muse, na ordem: `META_API_KEY` do
 * ambiente → `providers.meta.api_key` (ou access_token) no auth.json →
 * cofre do SO para cada provider delegado declarado no auth.json.
 */
export async function resolveMuseLoginCredential(
  opts: MuseLoginResolveOptions = {},
): Promise<MuseLoginCredential | null> {
  const home = opts.home ?? os.homedir();
  const env = opts.env ?? process.env;
  const model = resolveMuseProbeModel(home, env);

  const envKey = cleanKey(env.META_API_KEY);
  if (envKey) return { apiKey: envKey, model };

  const blob = await authBlobAsync(opts, home, env);
  if (blob) {
    try {
      const parsed = JSON.parse(blob) as {
        providers?: Record<string, { api_key?: unknown; access_token?: unknown }>;
      };
      const meta = parsed.providers?.meta;
      const fileKey = cleanKey(meta?.api_key) ?? cleanKey(meta?.access_token);
      if (fileKey) return { apiKey: fileKey, model };
    } catch {
      // auth.json ilegível: tenta o cofre mesmo assim.
    }
    const readSecret = opts.readPlatformSecret ?? ((account: string) => readMusePlatformSecret(account));
    for (const account of museKeychainDelegatedProviders(blob)) {
      const payload = await readSecret(account);
      const key = payload ? platformSecretKey(payload) : null;
      if (key) return { apiKey: key, model };
    }
  }
  return null;
}

/**
 * Evidência pública de sessão Muse (sem tocar o segredo): chave no
 * ambiente, token no auth.json ou provider delegado ao cofre. Distingue
 * «conectado, cota sem fonte» de «sem credencial».
 */
export function museLoginSignedIn(opts: MuseLoginResolveOptions = {}): boolean {
  const home = opts.home ?? os.homedir();
  const env = opts.env ?? process.env;
  if (cleanKey(env.META_API_KEY)) return true;
  const blob = authBlobSync(opts, home, env);
  if (!blob) return false;
  return museAuthBlobIsUsable(blob) || museKeychainDelegatedProviders(blob).length > 0;
}

