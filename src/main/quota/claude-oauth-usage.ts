/**
 * Anthropic Claude Code OAuth usage probe.
 *
 * GET https://api.anthropic.com/api/oauth/usage
 * Authorization: Bearer <oauth access token>
 * anthropic-beta: oauth-2025-04-20
 *
 * Returns authoritative five_hour / seven_day utilization (0–100).
 * Pure parse is unit-tested; network is best-effort and never invents %.
 *
 * Fallback print-only (Codenotch, ClaudeUsageCLI.swift): `claude --print
 * --no-session-persistence --strict-mcp-config /usage` responde com as mesmas
 * janelas usando o login que o CLI já tem — cobre 429/backoff do endpoint e
 * token de keychain rodado. Só --print: sem isso cada chamada grava sessão em
 * ~/.claude/projects e pode levantar diálogo de workspace-trust;
 * --strict-mcp-config sem --mcp-config = zero servidor MCP. Timeout mata o
 * processo; exit ≠ 0 é «precisa de login» (null — a UI fica no «—» honesto).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type {
  QuotaReadHint,
  QuotaWindow,
} from '../../shared/quota-types';
import { knownWindow } from './quota-normalize';
import { claudeCliDeclaresMarker } from '../adapters/managed-claude-auth';

export const CLAUDE_OAUTH_USAGE_URL =
  'https://api.anthropic.com/api/oauth/usage';
export const CLAUDE_OAUTH_BETA = 'oauth-2025-04-20';

/** Default network timeout for usage probe. */
export const CLAUDE_USAGE_TIMEOUT_MS = 8_000;

interface UsageBucket {
  utilization?: unknown;
  resets_at?: unknown;
}

/**
 * Extract Claude Code OAuth access token from a credential blob
 * (keychain or vault snapshot JSON).
 */
export function extractClaudeAccessToken(blob: string): string | null {
  if (!blob || typeof blob !== 'string') return null;
  try {
    const parsed = JSON.parse(blob) as {
      claudeAiOauth?: { accessToken?: unknown };
    };
    const token = parsed.claudeAiOauth?.accessToken;
    if (typeof token === 'string' && token.length > 0) return token;
    return null;
  } catch {
    return null;
  }
}

function utilizationToRatio(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  // Anthropic OAuth usage reports percent 0–100 (incl. 0, 1, 2.0, 50…).
  // Always scale by 100 so utilization:1 → 1%, never 100% false positive.
  if (raw < 0) return 0;
  return Math.min(1, raw / 100);
}

function parseResetsAt(raw: unknown): number | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : undefined;
}

function bucketWindow(
  bucket: UsageBucket | null | undefined,
  kind: 'hours' | 'weekly',
  label: string,
  now: number,
): QuotaWindow | null {
  if (!bucket || typeof bucket !== 'object') return null;
  const ratio = utilizationToRatio(bucket.utilization);
  if (ratio === null) return null;
  return knownWindow({
    kind,
    label,
    usedRatio: ratio,
    source: 'provider-api',
    confidence: 'high',
    resetsAt: parseResetsAt(bucket.resets_at),
    now,
  });
}

/**
 * Parse Anthropic OAuth usage JSON into quota windows.
 * Empty array = could not extract any known window (caller keeps unknowns).
 * five_hour → **5 Horas**, seven_day → **Semanal** (same UX as Codex/GLM fleet).
 */
export function parseClaudeOauthUsage(
  body: unknown,
  now = Date.now(),
): QuotaWindow[] {
  if (!body || typeof body !== 'object') return [];
  const root = body as {
    five_hour?: UsageBucket | null;
    seven_day?: UsageBucket | null;
  };
  const out: QuotaWindow[] = [];
  // five_hour is the rolling ~5h window (Anthropic also labels it "session").
  const hours = bucketWindow(root.five_hour, 'hours', '5 Horas', now);
  if (hours) out.push(hours);
  const weekly = bucketWindow(root.seven_day, 'weekly', 'Semanal', now);
  if (weekly) out.push(weekly);
  return out;
}

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

/**
 * Fetch live Claude OAuth usage windows. Returns null on any failure
 * (network, auth, parse) so UI stays on honest "—" instead of inventing 0%.
 */
export interface ClaudeOauthUsageProbe {
  windows: QuotaWindow[] | null;
  /** `auth-expired` só em 401/403 — grant morto, re-login. 429/5xx/rede é transitório. */
  failure?: 'auth-expired' | 'unavailable';
}

/**
 * Probe OAuth que distingue grant morto (401/403) de falha transitória
 * (429, 5xx, timeout). `/usage` do CLI sai quieto sem sessão — este
 * endpoint é o sinal definitivo de auth para a linha nativa.
 */
export async function probeClaudeOauthUsage(
  accessToken: string,
  opts?: {
    fetchImpl?: FetchLike;
    timeoutMs?: number;
    now?: number;
  },
): Promise<ClaudeOauthUsageProbe> {
  const token = accessToken?.trim();
  if (!token) return { windows: null, failure: 'unavailable' };

  const fetchImpl = opts?.fetchImpl ?? (globalThis.fetch as FetchLike);
  if (typeof fetchImpl !== 'function') {
    return { windows: null, failure: 'unavailable' };
  }

  const timeoutMs = opts?.timeoutMs ?? CLAUDE_USAGE_TIMEOUT_MS;
  const now = opts?.now ?? Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(CLAUDE_OAUTH_USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': CLAUDE_OAUTH_BETA,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      return {
        windows: null,
        failure:
          res.status === 401 || res.status === 403
            ? 'auth-expired'
            : 'unavailable',
      };
    }
    const body = await res.json();
    const windows = parseClaudeOauthUsage(body, now);
    return windows.length > 0
      ? { windows }
      : { windows: null, failure: 'unavailable' };
  } catch {
    return { windows: null, failure: 'unavailable' };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchClaudeOauthUsageWindows(
  accessToken: string,
  opts?: {
    fetchImpl?: FetchLike;
    timeoutMs?: number;
    now?: number;
  },
): Promise<QuotaWindow[] | null> {
  return (await probeClaudeOauthUsage(accessToken, opts)).windows;
}

// ---------------------------------------------------------------------------
// CLI /usage fallback (print-only) — Codenotch ClaudeUsageCLI.swift
// ---------------------------------------------------------------------------

export const CLAUDE_CLI_USAGE_ARGS = [
  '--print',
  '--no-session-persistence',
  '--strict-mcp-config',
  '/usage',
] as const;

/** Frio + Node a arrancar numa máquina ocupada; wedge não segura o probe. */
export const CLAUDE_CLI_USAGE_TIMEOUT_MS = 20_000;

export interface ClaudeCliRunResult {
  code: number;
  stdout: string;
  /** Opcional no contrato — runnables antigos de teste não capturavam. */
  stderr?: string;
}

export type ClaudeCliRunImpl = (
  binary: string,
  args: readonly string[],
  cwd: string,
  env?: Record<string, string>,
) => Promise<ClaudeCliRunResult>;

/**
 * `Current session: 38% used · resets Sep 7 at 2:59pm (Asia/Jakarta)`
 * `Current week (all models): 4% used · resets Sep 14 at 5:59am (Asia/Jakarta)`
 * O resto do output é prosa aproximada — nunca janela.
 */
const CLI_LINE_RE =
  /^Current (?:(session)|week \(([^)]+)\)):\s*(\d{1,3})%\s*used(?:\s*·\s*resets\s*(.+?))?\s*$/gm;

/** Sep→0 … Dec→11. */
const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function tzOffsetMs(instantUtcMs: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(instantUtcMs))) {
    parts[p.type] = p.value;
  }
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - instantUtcMs;
}

/** Componentes de parede numa zona IANA → epoch ms (duas passadas: DST). */
function wallTimeInZoneMs(
  y: number, mo: number, d: number, h: number, mi: number,
  timeZone: string,
): number {
  const naive = Date.UTC(y, mo, d, h, mi);
  let ms = naive - tzOffsetMs(naive, timeZone);
  ms = naive - tzOffsetMs(ms, timeZone);
  return ms;
}

/**
 * `Sep 7 at 2:59pm (Asia/Jakarta)` → epoch ms.
 * Sem ano impresso: o candidato mais próximo de `now` entre [ano-1, ano,
 * ano+1] — Dec 31 lido a 2 de janeiro é do ano passado, e não o contrário.
 */
export function parseClaudeCliResetDate(
  raw: string,
  now: number,
): number | undefined {
  let stamp = raw.trim();
  let timeZone: string | undefined;

  const zone = stamp.match(/\(([^)]+)\)\s*$/);
  if (zone) {
    timeZone = zone[1];
    stamp = stamp.slice(0, zone.index).trim();
  }
  stamp = stamp.replace(/am/g, 'AM').replace(/pm/g, 'PM');
  const m = stamp.match(
    /^([A-Za-z]{3,4})\s+(\d{1,2})\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/,
  );
  if (!m) return undefined;

  const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
  if (mo === undefined) return undefined;
  const day = Number(m[2]);
  let h = Number(m[3]);
  const mi = m[4] ? Number(m[4]) : 0;
  if (m[5] === 'AM') {
    if (h === 12) h = 0;
  } else if (h !== 12) {
    h += 12;
  }

  const nowDate = new Date(now);
  const thisYear = nowDate.getFullYear();
  // now em UTC vs getFullYear local: diff sub-ano, irrelevante p/ vizinhança.
  const years = [thisYear - 1, thisYear, thisYear + 1];
  const toInstant = (year: number): number =>
    timeZone
      ? wallTimeInZoneMs(year, mo, day, h, mi, timeZone)
      : new Date(year, mo, day, h, mi).getTime();
  return years
    .map(toInstant)
    .reduce((best, t) =>
      Math.abs(t - now) < Math.abs(best - now) ? t : best,
    );
}

function cliWindowKindAndLabel(
  session: string | undefined,
  weekName: string | undefined,
): { kind: 'session' | 'weekly'; label: string } {
  if (session) return { kind: 'session', label: 'Sessão' };
  const name = (weekName ?? '').trim().toLowerCase();
  if (!name || name === 'all models') return { kind: 'weekly', label: 'Semanal' };
  const pretty = weekName!.trim().replace(/\s+/g, ' ');
  return { kind: 'weekly', label: `Semanal (${pretty})` };
}

/**
 * Parse do print do `claude /usage` → janelas. Percentagem que parseou é
 * mantida mesmo com reset ilegível (resetsAt é opcional por contrato).
 */
export function parseClaudeCliUsage(
  text: string,
  now = Date.now(),
): QuotaWindow[] {
  if (!text) return [];
  const out: QuotaWindow[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(CLI_LINE_RE)) {
    const pct = Number(m[3]);
    if (!Number.isFinite(pct)) continue;
    const { kind, label } = cliWindowKindAndLabel(m[1], m[2]);
    const key = `${kind}:${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(
      knownWindow({
        kind,
        label,
        usedRatio: Math.max(0, Math.min(1, pct / 100)),
        source: 'provider-api',
        confidence: 'medium',
        resetsAt: m[4] ? parseClaudeCliResetDate(m[4], now) : undefined,
        now,
      }),
    );
  }
  return out;
}

/** Caminhos onde o instalador nativo/npm/version managers deixam o `claude`. */
export function claudeCliBinaryCandidates(
  home = os.homedir(),
  nvmDir = path.join(home, '.nvm', 'versions', 'node'),
): string[] {
  const fixed = [
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.claude', 'local', 'claude'),
    path.join(home, '.bun', 'bin', 'claude'),
    path.join(home, '.volta', 'bin', 'claude'),
    path.join(home, 'Library', 'pnpm', 'claude'),
    path.join(home, '.npm-global', 'bin', 'claude'),
  ];
  let nvm: string[] = [];
  try {
    nvm = fs
      .readdirSync(nvmDir)
      .filter((d) => /^v\d/.test(d))
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
      .reverse()
      .map((v) => path.join(nvmDir, v, 'bin', 'claude'));
  } catch {
    // sem nvm
  }
  return [
    ...fixed,
    ...nvm,
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
}

function locateClaudeBinary(): string | null {
  for (const candidate of claudeCliBinaryCandidates()) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // next
    }
  }
  return null;
}

/** Execução real (injetável nos testes). */
async function runClaudeCli(
  binary: string,
  args: readonly string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<ClaudeCliRunResult> {
  return new Promise((resolve) => {
    const child = spawn(binary, [...args], {
      cwd,
      // stderr tem que ser capturado: o `/usage` sai com code 0 e stdout só
      // com a tabela de custo quando a sessão está morta — a mensagem de
      // auth («OAuth session expired») sai por aqui.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env, PWD: cwd },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, CLAUDE_CLI_USAGE_TIMEOUT_MS);
    timer.unref?.();
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: '', stderr: '' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * O `--print` sai com code 0 mesmo sem sessão — o texto é o sinal real.
 * «Failed to authenticate» / refresh morto = a credencial daquele escopo
 * precisa de re-login, não de retry.
 */
const CLAUDE_CLI_AUTH_FAILURE_RE =
  /failed to authenticate|could not be refreshed|oauth session expired|not logged in|please run \/login|authentication required/i;

export function claudeCliOutputIsAuthFailure(stdout: string): boolean {
  return CLAUDE_CLI_AUTH_FAILURE_RE.test(stdout);
}

export type ClaudeCliUsageFailure =
  | 'cli-missing'
  | 'cli-unsupported'
  | 'auth-expired'
  | 'unavailable';

/** Falha de probe CLI → hint de leitura para a UI. */
export function cliFailureHint(
  failure: ClaudeCliUsageFailure,
): QuotaReadHint {
  switch (failure) {
    case 'auth-expired':
      return 'auth-expired';
    case 'cli-missing':
      return 'cli-missing';
    default:
      return 'unavailable';
  }
}

export interface ClaudeCliUsageProbe {
  windows: QuotaWindow[] | null;
  /** Motivo quando `windows` é null — para a UI dizer mais que «—». */
  failure?: ClaudeCliUsageFailure;
}

/**
 * Probe completo pelo binário do CLI: devolve as janelas ou o motivo da
 * falha (binário ausente, env não suportada, sessão morta, saída sem dados).
 */
export async function probeClaudeCliUsage(opts?: {
  runImpl?: ClaudeCliRunImpl;
  now?: number;
  cwd?: string;
  env?: Record<string, string>;
}): Promise<ClaudeCliUsageProbe> {
  const run = opts?.runImpl ?? runClaudeCli;
  const cwd =
    opts?.cwd ??
    path.join(os.tmpdir(), 'nexus-ide-claude-usage');
  try {
    fs.mkdirSync(cwd, { recursive: true });
  } catch {
    // cwd fixo é defesa, não requisito
  }
  const binary = locateClaudeBinary();
  if (!binary) return { windows: null, failure: 'cli-missing' };
  if (opts?.env) {
    for (const name of Object.keys(opts.env)) {
      try {
        if (!claudeCliDeclaresMarker(binary, name)) {
          return { windows: null, failure: 'cli-unsupported' };
        }
      } catch {
        return { windows: null, failure: 'cli-unsupported' };
      }
    }
  }

  const { code, stdout, stderr } = await run(
    binary,
    CLAUDE_CLI_USAGE_ARGS,
    cwd,
    opts?.env,
  );
  // O `/usage` falha quieto no stdout (só tabela de custo) — a mensagem de
  // sessão morta sai no stderr. Os dois lados contam como sinal.
  if (
    claudeCliOutputIsAuthFailure(stdout) ||
    claudeCliOutputIsAuthFailure(stderr ?? '')
  ) {
    return { windows: null, failure: 'auth-expired' };
  }
  if (code !== 0 || !stdout.trim()) return { windows: null, failure: 'unavailable' };
  const windows = parseClaudeCliUsage(stdout, opts?.now ?? Date.now());
  return windows.length > 0
    ? { windows }
    : { windows: null, failure: 'unavailable' };
}

/**
 * Probe pelo binário do próprio CLI. null em qualquer falha — login ausente
 * (exit ≠ 0), binário ausente, timeout. Nunca inventa janela.
 */
export async function fetchClaudeCliUsageWindows(opts?: {
  runImpl?: ClaudeCliRunImpl;
  now?: number;
  cwd?: string;
  /**
   * Env extra que isola a conta do run: CLAUDE_SECURESTORAGE_CONFIG_DIR
   * (auth gerenciada Nexus) ou CLAUDE_CONFIG_DIR (perfil `~/.claude-<slug>`).
   * O binário precisa declarar cada nome passado — um CLI antigo que ignora
   * a variável cai na credencial nativa e devolveria o uso de OUTRA conta
   * nesta linha, fabricação por conta que este probe existe para evitar.
   */
  env?: Record<string, string>;
}): Promise<QuotaWindow[] | null> {
  return (await probeClaudeCliUsage(opts)).windows;
}
