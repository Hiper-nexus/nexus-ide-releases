/**
 * Devin usage probe — GetUserStatus (Codenotch DevinUsage/DevinLocalProvider).
 *
 * POST https://server.self-serve.windsurf.com/exa.seat_management_pb.SeatManagementService/GetUserStatus
 * Body: {"metadata":{"apiKey":…,"ideName":"windsurf",…}}
 * Headers: Content-Type application/json, Connect-Protocol-Version: 1
 *
 * A sessão vem do `devin auth login` — credentials.toml plano sob
 * $XDG_DATA_HOME (default ~/.local/share). Só leitura: o dono do login
 * minta e rodar o token, a sonda nunca refresca nem escreve.
 *
 * Parse (protobuf JSON):
 *   - percentuais são RESTANTES e podem ser fracionários — usado =
 *     (100 − remaining)/100;
 *   - timestamps 64-bit vêm como STRING (número aceito também);
 *   - o serviço omite *QuotaRemainingPercent em 0 (cota esgotada): percent
 *     ausente + reset presente = 100% usado, NÃO «sem cota»;
 *   - só percent E reset ausentes = sem leitura (null, nunca 0% inventado).
 *
 * ponytail: overageBalanceMicros (saldo $ de extra usage) não vira janela —
 * o contrato QuotaWindow é razão 0–1; sem slot de dinheiro, mostrar-lo como
 * «—» seria rebaixar um dado que existe. Upgrade: campo de saldo no tipo.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { QuotaWindow } from '../../shared/quota-types';
import { knownWindow } from './quota-normalize';
import { devinDataHome, devinTomlCredentialValue } from '../adapters/managed-credentials';
import type { FetchLike } from './claude-oauth-usage';

export const DEVIN_GET_USER_STATUS_URL =
  'https://server.self-serve.windsurf.com/exa.seat_management_pb.SeatManagementService/GetUserStatus';
export const DEVIN_USAGE_TIMEOUT_MS = 15_000;

function num(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function planStatusOf(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== 'object') return null;
  const root = body as { userStatus?: unknown };
  const plan =
    root.userStatus &&
    typeof root.userStatus === 'object' &&
    ((root.userStatus as { planStatus?: unknown }).planStatus ??
      null);
  return plan && typeof plan === 'object'
    ? (plan as Record<string, unknown>)
    : null;
}

/**
 * Parse GetUserStatus → janelas Diário (session) + Semanal (weekly).
 */
export function parseDevinUserStatus(
  body: unknown,
  now = Date.now(),
): QuotaWindow[] {
  const plan = planStatusOf(body);
  if (!plan) return [];

  const out: QuotaWindow[] = [];
  for (const [id, kind, label, hiddenKey] of [
    ['daily', 'session', 'Diário', 'hideDailyQuota'],
    ['weekly', 'weekly', 'Semanal', 'hideWeeklyQuota'],
  ] as const) {
    if (plan[hiddenKey] === true) continue;
    const resetRaw = num(plan[`${id}QuotaResetAtUnix`]);
    const resetsAt =
      resetRaw !== null && resetRaw > 0 ? resetRaw * 1000 : undefined;
    const remaining = num(plan[`${id}QuotaRemainingPercent`]);
    // Percent omitido com reset = cota esgotada (o serviço omite em 0).
    const usedRatio =
      remaining !== null && remaining >= 0 && remaining <= 100
        ? (100 - remaining) / 100
        : resetsAt !== undefined
          ? 1
          : null;
    if (usedRatio === null) continue;
    out.push(
      knownWindow({
        kind,
        label,
        usedRatio,
        source: 'provider-api',
        confidence: 'high',
        resetsAt,
        now,
      }),
    );
  }
  return out;
}

/** Ler `windsurf_api_key` (ou api_key/token) do TOML plano. Re-export fino. */
export function devinApiKeyFromToml(blob: string): string | null {
  return devinTomlCredentialValue(blob);
}

/**
 * Sessão do Devin CLI: `$XDG_DATA_HOME/devin/credentials.toml`.
 * Sem essa variável, Linux/macOS usam `~/.local/share` e o Windows usa
 * `%APPDATA%` — é lá que o `devin auth login` grava.
 */
export function resolveDevinApiKey(opts?: {
  xdgDataHome?: string;
  home?: string;
  env?: { XDG_DATA_HOME?: string; APPDATA?: string };
  platform?: NodeJS.Platform;
  operatorHome?: string;
}): string | null {
  const home = opts?.home ?? os.homedir();
  const root =
    opts?.xdgDataHome?.trim() ||
    devinDataHome(
      home,
      opts?.env ?? process.env,
      opts?.platform ?? process.platform,
      opts?.operatorHome ?? os.homedir(),
    );
  const filePath = path.join(root, 'devin', 'credentials.toml');
  try {
    return devinApiKeyFromToml(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Probe live. null em qualquer falha (auth, rede, parse) — UI fica no «—».
 */
export async function fetchDevinUsageWindows(
  apiKey: string,
  opts?: {
    fetchImpl?: FetchLike;
    timeoutMs?: number;
    now?: number;
  },
): Promise<QuotaWindow[] | null> {
  const key = apiKey?.trim();
  if (!key) return null;
  const fetchImpl = opts?.fetchImpl ?? (globalThis.fetch as FetchLike);
  if (typeof fetchImpl !== 'function') return null;

  const timeoutMs = opts?.timeoutMs ?? DEVIN_USAGE_TIMEOUT_MS;
  const now = opts?.now ?? Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(DEVIN_GET_USER_STATUS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        metadata: {
          apiKey: key,
          ideName: 'windsurf',
          ideVersion: '1.108.2',
          extensionName: 'windsurf',
          extensionVersion: '1.108.2',
          locale: 'en',
        },
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = await res.json();
    const windows = parseDevinUserStatus(body, now);
    return windows.length > 0 ? windows : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
