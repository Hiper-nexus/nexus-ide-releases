/**
 * Alibaba Cloud Model Studio Token Plan — shared quota for Qwen Code,
 * DeepSeek (deepseek-token-plan) and GLM on the same `BAILIAN_TOKEN_PLAN_API_KEY`
 * / `sk-sp-` key. One plan, one Credits pool (Personal Edition).
 *
 * Console usage API (INTL / Qwen Cloud, verified against CodexBar + oh-my-pi):
 *   1. GET https://home.qwencloud.com/tool/user/info.json  (Cookie) → secToken
 *   2. POST https://cs-data.qwencloud.com/data/api.json
 *        ?product=sfm_bailian
 *        &action=IntlBroadScopeAspnGateway
 *        &api=zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage
 *      body: URL-encoded cornerstoneParam (domain=home.qwencloud.com,
 *            consoleSite=QWENCLOUD) + optional secToken
 *
 * Response (nested): data.DataV2.data.data = {
 *   per5HourPercentage, per5HourResetTime,
 *   per1WeekPercentage, per1WeekResetTime,
 *   per1MonthPercentage, per1MonthResetTime
 * }
 * Percentages are 0..1 fractions (0.0104 → 1.04% used). Reset times are
 * epoch ms. Some plans report only the monthly bucket.
 *
 * Auth: console Cookie (not the inference API key). `bl usage token-plan` /
 * `bl console call --api zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage`
 * is the CLI path when the Bailian CLI is signed in.
 *
 * Never invents percentages: missing field → window omitted / null ratio.
 */

import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { QuotaWindow } from '../../shared/quota-types';
import { knownWindow } from './quota-normalize';
import type { FetchLike } from './claude-oauth-usage';

export const ALIBABA_TOKEN_PLAN_USAGE_URL =
  'https://cs-data.qwencloud.com/data/api.json' +
  '?product=sfm_bailian&action=IntlBroadScopeAspnGateway' +
  '&api=zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage';
export const ALIBABA_TOKEN_PLAN_USER_INFO_URL =
  'https://home.qwencloud.com/tool/user/info.json';
export const ALIBABA_TOKEN_PLAN_TIMEOUT_MS = 8_000;

export interface AlibabaTokenPlanUsageRaw {
  per5HourPercentage?: unknown;
  per5HourResetTime?: unknown;
  per1WeekPercentage?: unknown;
  per1WeekResetTime?: unknown;
  per1MonthPercentage?: unknown;
  per1MonthResetTime?: unknown;
}

/**
 * Contrato documentado: fração 0..1 (0.0104 = 1,04% usado). Um estouro do
 * plano passa um pouco de 1 (1.04 = 104%) — dividir por 100 o transformava em
 * 1,04% (F-1417). Acima deste teto o número já não cabe no contrato: parece
 * percentual 0..100 (ex.: 12 = 12%) e lê-lo como fração viraria 100%.
 * Ambíguo → a leitura inteira fica indisponível, nunca "esgotado".
 */
export const ALIBABA_MAX_OVERRUN_FRACTION = 2;

function rawNumber(raw: unknown): number | null {
  const n = typeof raw === 'string' ? Number(raw) : raw;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function fraction(raw: unknown): number | null {
  const n = rawNumber(raw);
  if (n === null || n < 0 || n > ALIBABA_MAX_OVERRUN_FRACTION) return null;
  return n;
}

function resetAt(raw: unknown): number | undefined {
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return undefined;
  return n > 1e12 ? n : n * 1000;
}

/** Nest-agnostic: find the first object carrying per5Hour/per1Week/per1Month fields. */
export function extractAlibabaTokenPlanUsage(body: unknown): AlibabaTokenPlanUsageRaw | null {
  const seen = new Set<unknown>();
  const walk = (value: unknown, depth: number): AlibabaTokenPlanUsageRaw | null => {
    if (!value || typeof value !== 'object' || depth > 8 || seen.has(value)) return null;
    seen.add(value);
    const root = value as Record<string, unknown>;
    if (
      'per5HourPercentage' in root ||
      'per1WeekPercentage' in root ||
      'per1MonthPercentage' in root
    ) {
      return root as AlibabaTokenPlanUsageRaw;
    }
    for (const key of ['data', 'DataV2', 'result', 'content']) {
      const hit = walk(root[key], depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  return walk(body, 0);
}

export function parseAlibabaTokenPlanUsage(
  body: unknown,
  now = Date.now(),
): QuotaWindow[] {
  const raw = extractAlibabaTokenPlanUsage(body);
  if (!raw) return [];
  // Revisão de segurança: um campo fora da escala de fração denuncia payload
  // em outra escala — nenhum número dele é confiável.
  const outOfScale = [raw.per5HourPercentage, raw.per1WeekPercentage, raw.per1MonthPercentage]
    .some((value) => {
      const n = rawNumber(value);
      return n !== null && n > ALIBABA_MAX_OVERRUN_FRACTION;
    });
  if (outOfScale) return [];
  const out: QuotaWindow[] = [];
  const push = (
    kind: 'hours' | 'weekly' | 'monthly',
    label: string,
    pct: unknown,
    rst: unknown,
  ): void => {
    const ratio = fraction(pct);
    if (ratio === null) return;
    out.push(
      knownWindow({
        kind,
        label,
        usedRatio: ratio,
        source: 'provider-api',
        confidence: 'high',
        resetsAt: resetAt(rst),
        now,
      }),
    );
  };
  push('hours', '5 Horas', raw.per5HourPercentage, raw.per5HourResetTime);
  push('weekly', 'Semanal', raw.per1WeekPercentage, raw.per1WeekResetTime);
  push('monthly', 'Mensal', raw.per1MonthPercentage, raw.per1MonthResetTime);
  return out;
}

export interface AlibabaTokenPlanProbe {
  windows: QuotaWindow[] | null;
  authFailed?: boolean;
}

/**
 * Console HTTP path. `cookie` is the browser Cookie header scoped to
 * home.qwencloud.com / cs-data.qwencloud.com (NOT the sk-sp- API key).
 */
export async function fetchAlibabaTokenPlanUsage(
  cookie: string,
  opts?: { fetchImpl?: FetchLike; now?: number; timeoutMs?: number },
): Promise<AlibabaTokenPlanProbe> {
  const fetchImpl = opts?.fetchImpl ?? (globalThis.fetch as FetchLike);
  if (typeof fetchImpl !== 'function' || !cookie?.trim()) {
    return { windows: null };
  }
  const now = opts?.now ?? Date.now();
  const timeoutMs = opts?.timeoutMs ?? ALIBABA_TOKEN_PLAN_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let secToken: string | undefined;
    try {
      const infoRes = await fetchImpl(ALIBABA_TOKEN_PLAN_USER_INFO_URL, {
        method: 'GET',
        headers: { Cookie: cookie.trim(), Accept: 'application/json' },
        signal: controller.signal,
      });
      if (infoRes.ok) {
        const info = (await infoRes.json()) as {
          data?: { secToken?: unknown };
        };
        const t = info?.data?.secToken;
        if (typeof t === 'string' && t) secToken = t;
      }
    } catch {
      // secToken is optional (CodexBar: cookie alone can suffice).
    }

    const params = new URLSearchParams();
    params.set(
      'cornerstoneParam',
      JSON.stringify({
        domain: 'home.qwencloud.com',
        consoleSite: 'QWENCLOUD',
        ...(secToken ? { secToken } : {}),
      }),
    );
    const res = await fetchImpl(ALIBABA_TOKEN_PLAN_USAGE_URL, {
      method: 'POST',
      headers: {
        Cookie: cookie.trim(),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: params.toString(),
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) return { windows: null, authFailed: true };
    if (!res.ok) return { windows: null };
    const body = await res.json();
    const windows = parseAlibabaTokenPlanUsage(body, now);
    return windows.length > 0 ? { windows } : { windows: null };
  } catch {
    return { windows: null };
  } finally {
    clearTimeout(timer);
  }
}

function locateBlBinary(): string | null {
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'bl'),
    '/opt/homebrew/bin/bl',
    '/usr/local/bin/bl',
  ];
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // next
    }
  }
  return null;
}

/** Mensagens de "sem sessão" do `bl`/gateway; nada genérico como "auth". */
export const BL_NOT_AUTHENTICATED =
  /\b(?:not (?:logged|signed) in|please (?:run )?`?(?:bl )?log ?in`?|login required|unauthenticated|unauthori[sz]ed|(?:token|session|credentials?) (?:has |have )?expired|invalid (?:access )?token)\b|\b(?:HTTP|status(?: code)?)[\s:=]*40[13]\b/i;

/**
 * Bailian CLI path (signed-in `bl`):
 *   bl console call --api zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage --data '{}' --output json
 * Older `bl usage token-plan --output json` also works for 5h/weekly plans.
 */
export async function fetchAlibabaTokenPlanUsageFromCli(opts?: {
  binary?: string;
  now?: number;
  timeoutMs?: number;
  runImpl?: (
    binary: string,
    args: readonly string[],
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
}): Promise<AlibabaTokenPlanProbe> {
  const binary = opts?.binary ?? locateBlBinary();
  // `runImpl` is a test seam: allow it without a real `bl` on disk.
  if (!binary && !opts?.runImpl) return { windows: null };
  const bin = binary ?? 'bl';
  const run =
    opts?.runImpl ??
    ((bin: string, args: readonly string[]) =>
      new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
        execFile(
          bin,
          [...args],
          {
            cwd: os.tmpdir(),
            timeout: opts?.timeoutMs ?? 15_000,
            maxBuffer: 1024 * 1024,
            env: {
              PATH: process.env.PATH ?? '',
              HOME: process.env.HOME ?? os.homedir(),
            },
          },
          (err, stdout, stderr) => {
            resolve({
              code: err && typeof (err as { code?: number }).code === 'number'
                ? (err as { code: number }).code
                : err
                  ? -1
                  : 0,
              stdout: String(stdout ?? ''),
              stderr: String(stderr ?? ''),
            });
          },
        );
      }));

  const attempts: readonly (readonly string[])[] = [
    [
      'console',
      'call',
      '--api',
      'zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage',
      '--data',
      '{}',
      '--output',
      'json',
    ],
    ['usage', 'token-plan', '--output', 'json'],
  ];
  let authFailed = false;
  for (const args of attempts) {
    const { code, stdout, stderr } = await run(bin, args);
    const text = stdout || stderr;
    // Revisão de segurança (BAIXA): só uma saída com ERRO que diz "não
    // autenticado" é sessão recusada. A regex antiga casava "auth", "login",
    // "expired", "401" em qualquer saída (até num campo JSON de sucesso).
    if (code !== 0 && BL_NOT_AUTHENTICATED.test(text)) authFailed = true;
    if (code !== 0 || !stdout.trim()) continue;
    try {
      const windows = parseAlibabaTokenPlanUsage(JSON.parse(stdout), opts?.now ?? Date.now());
      if (windows.length > 0) return { windows };
    } catch {
      // try next
    }
  }
  return { windows: null, ...(authFailed ? { authFailed: true } : {}) };
}

/**
 * Unified probe: console cookie first (when provided), then signed-in `bl`.
 * Qwen + DeepSeek share the result via the same credentialId (same key).
 */
export async function probeAlibabaTokenPlanUsage(opts?: {
  cookie?: string | null;
  fetchImpl?: FetchLike;
  now?: number;
  skipCli?: boolean;
}): Promise<AlibabaTokenPlanProbe> {
  if (opts?.cookie?.trim()) {
    const probe = await fetchAlibabaTokenPlanUsage(opts.cookie, {
      fetchImpl: opts.fetchImpl,
      now: opts.now,
    });
    if (probe.windows?.length || probe.authFailed) return probe;
  }
  if (opts?.skipCli) return { windows: null };
  return fetchAlibabaTokenPlanUsageFromCli({ now: opts?.now });
}
