/**
 * Cursor usage probe — GET https://cursor.com/api/usage-summary
 * (Codenotch CursorUsage/CursorLocalProvider/CursorCredentials).
 *
 * A sessão é a que a conta já tem na máquina (só leitura):
 *   1) Store do editor Cursor:
 *      ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb
 *      ItemTable['cursorAuth/accessToken'] + stripeMembershipAuthId (ou JWT sub).
 *      WAL: abrir readonly SEM immutable — immutable lê o último checkpoint e
 *      pode servir token já rodado pelo editor.
 *   2) `cursor-agent login`: JWT no login keychain
 *      (service cursor-access-token / account cursor-user, via `security`)
 *      + authId do ~/.cursor/cli-config.json. O par é obrigatório — token
 *      sozinho ou Bearer header dá 401.
 *
 * Cookie: WorkosCursorSessionToken=<accountID>::<accessToken>.
 *
 * Cursor mede ALLOWANCE, não contagem: o anel é autoPercentUsed (Cursor
 * Models); apiPercentUsed é balde à parte; totalPercentUsed é mistura e
 * nunca vira janela. plan.used/limit fica a 0/0 no plano free mesmo com uso
 * real (a franquia chega como breakdown.bonus) — NUNCA usar. Enterprise/team
 * não expõe percentagens: overall.used/limit é a leitura. Zero é leitura.
 *
 * ponytail: teamUsage.onDemand não vira janela (uso do time não é o uso da
 * row individual); upgrade: contas de team no account-store.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { QuotaWindow } from '../../shared/quota-types';
import { knownWindow } from './quota-normalize';
import type { FetchLike } from './claude-oauth-usage';

export const CURSOR_USAGE_SUMMARY_URL = 'https://cursor.com/api/usage-summary';
export const CURSOR_USAGE_TIMEOUT_MS = 15_000;
const AGENT_KEYCHAIN_SERVICE = 'cursor-access-token';
const AGENT_KEYCHAIN_ACCOUNT = 'cursor-user';

export interface CursorSession {
  accountId: string;
  accessToken: string;
}

type ExecImpl = (
  file: string,
  args: string[],
) => Promise<{ code: number; stdout: string }>;

function percentToRatio(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  return Math.max(0, Math.min(1, raw / 100));
}

function parseDateMs(raw: unknown): number | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : undefined;
}

function ratioWindow(input: {
  kind: QuotaWindow['kind'];
  label: string;
  usedRatio: number;
  resetsAt?: number;
  now: number;
}): QuotaWindow {
  return knownWindow({
    kind: input.kind,
    label: input.label,
    usedRatio: input.usedRatio,
    source: 'provider-api',
    confidence: 'high',
    resetsAt: input.resetsAt,
    now: input.now,
  });
}

function spendWindow(
  bucket: unknown,
  label: string,
  resetsAt: number | undefined,
  now: number,
): QuotaWindow | null {
  if (!bucket || typeof bucket !== 'object') return null;
  const b = bucket as Record<string, unknown>;
  if (b.enabled !== true) return null;
  const limit = typeof b.limit === 'number' ? b.limit : NaN;
  const used = typeof b.used === 'number' ? b.used : NaN;
  if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(used)) return null;
  return ratioWindow({
    kind: 'credits',
    label,
    usedRatio: Math.max(0, Math.min(1, used / limit)),
    resetsAt,
    now,
  });
}

/**
 * Parse /api/usage-summary → janelas.
 */
export function parseCursorUsageSummary(
  body: unknown,
  now = Date.now(),
): QuotaWindow[] {
  if (!body || typeof body !== 'object') return [];
  const root = body as Record<string, unknown>;
  const usage =
    root.individualUsage && typeof root.individualUsage === 'object'
      ? (root.individualUsage as Record<string, unknown>)
      : {};
  const plan =
    usage.plan && typeof usage.plan === 'object'
      ? (usage.plan as Record<string, unknown>)
      : {};

  const resetsAt = parseDateMs(root.billingCycleEnd);
  const out: QuotaWindow[] = [];

  // O anel: Cursor Models (Auto). Zero é leitura, não ausência.
  const auto = percentToRatio(plan.autoPercentUsed);
  if (auto !== null) {
    out.push(ratioWindow({ kind: 'monthly', label: 'Mensal', usedRatio: auto, resetsAt, now }));
  }
  const api = percentToRatio(plan.apiPercentUsed);
  if (api !== null && api > 0) {
    out.push(ratioWindow({ kind: 'monthly', label: 'Uso API', usedRatio: api, resetsAt, now }));
  }
  const onDemand = spendWindow(usage.onDemand, 'On demand', resetsAt, now);
  if (onDemand) out.push(onDemand);

  // Enterprise/team: sem percentagens, o teto duro é a leitura.
  if (out.length === 0) {
    const overall = spendWindow(usage.overall, 'Mensal', resetsAt, now);
    if (overall) out.push(overall);
  }
  return out;
}

/** Cookie Workos: o par accountID::token é obrigatório (token só = 401). */
export function cursorWorkosCookie(session: CursorSession): string {
  return `WorkosCursorSessionToken=${session.accountId}::${session.accessToken}`;
}

/** ItemTable[key] de um state.vscdb aberto readonly (WAL-aware). */
async function editorStoreValue(
  db: SqliteDatabase,
  key: string,
): Promise<string | null> {
  try {
    const row = db
      .prepare('SELECT value FROM ItemTable WHERE key = ?')
      .get(key) as { value?: unknown } | undefined;
    const value = row?.value;
    return typeof value === 'string'
      ? value
      : value && typeof value === 'object' && 'toString' in (value as object)
        ? String(value)
        : null;
  } catch {
    return null;
  }
}

/** Tipo mínimo do better-sqlite3 (mesmo rito de persistence/db.ts). */
type SqliteDatabase = {
  prepare(sql: string): { get(...args: unknown[]): unknown };
  close(): void;
};

/**
 * Sessão do store do editor. Abre readonly (lê WAL, nunca immutable —
 * immutable serve o último checkpoint, pode ser token já rodado).
 */
export async function cursorSessionFromEditorStore(
  dbPath = path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'Cursor',
    'User',
    'globalStorage',
    'state.vscdb',
  ),
): Promise<CursorSession | null> {
  if (!fs.existsSync(dbPath)) return null;
  let Database: | (new (
      file: string,
      options?: { readonly?: boolean; fileMustExist?: boolean },
    ) => SqliteDatabase)
    | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    Database = require('better-sqlite3');
  } catch {
    return null;
  }
  if (!Database) return null;
  let db: SqliteDatabase | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const token = await editorStoreValue(db, 'cursorAuth/accessToken');
    if (!token) return null;
    const authId = await editorStoreValue(db, 'cursorAuth/stripeMembershipAuthId');
    const accountId = authId || jwtSubject(token);
    if (!accountId) return null;
    return { accountId, accessToken: token };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** base64url decode do payload — sem dependências. */
function jwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function jwtSubject(token: string): string | null {
  const sub = jwtClaims(token)?.sub;
  return typeof sub === 'string' && sub ? sub : null;
}

function jwtExpired(token: string, now = Date.now()): boolean {
  const exp = jwtClaims(token)?.exp;
  return typeof exp === 'number' ? exp * 1000 <= now : false;
}

function defaultExec(file: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: 5_000, encoding: 'utf8' },
      (err, stdout) => {
        resolve({
          // execFile devolve erro em exit ≠ 0 e em timeout — mesmo destino.
          code: err ? 1 : 0,
          stdout: typeof stdout === 'string' ? stdout : '',
        });
      },
    );
  });
}

/** JWT do `cursor-agent login` no login keychain (via `security`). */
async function readCursorAgentToken(
  exec: ExecImpl = defaultExec,
): Promise<string | null> {
  const { code, stdout } = await exec('security', [
    'find-generic-password',
    '-w',
    '-s',
    AGENT_KEYCHAIN_SERVICE,
    '-a',
    AGENT_KEYCHAIN_ACCOUNT,
  ]);
  const token = stdout.trim();
  if (code !== 0 || !token) return null;
  return token;
}

/**
 * Sessão via cursor-agent: token do keychain + authId do cli-config.json
 * (fallback userId numérico, depois JWT sub).
 */
export async function cursorAgentSession(
  token: string,
  agentConfigPath = path.join(os.homedir(), '.cursor', 'cli-config.json'),
  now = Date.now(),
): Promise<CursorSession | null> {
  const trimmed = token?.trim();
  if (!trimmed || jwtExpired(trimmed, now)) return null;
  let authId: string | null = null;
  let userId: string | null = null;
  try {
    const parsed = JSON.parse(
      fs.readFileSync(agentConfigPath, 'utf8'),
    ) as { authInfo?: { authId?: unknown; userId?: unknown } };
    const info = parsed.authInfo;
    if (info && typeof info === 'object') {
      if (typeof info.authId === 'string' && info.authId) authId = info.authId;
      if (typeof info.userId === 'number') userId = String(info.userId);
      else if (typeof info.userId === 'string' && info.userId) userId = info.userId;
    }
  } catch {
    // sem cli-config → cai no sub do JWT
  }
  const accountId = authId || userId || jwtSubject(trimmed);
  return accountId ? { accountId, accessToken: trimmed } : null;
}

/** Cache do token do keychain enquanto o JWT não expira (evita prompt loop). */
let cachedAgentToken: string | null = null;
let cachedAgentTokenCheckedAt = 0;
const AGENT_TOKEN_CACHE_TTL_MS = 60_000;

async function loadCursorSession(exec?: ExecImpl): Promise<CursorSession | null> {
  // Editor primeiro (mesma precedência do Codenotch): só cai no keychain
  // quando o editor não tem sessão — máquinas com os dois não oscilam.
  const editor = await cursorSessionFromEditorStore();
  if (editor) return editor;

  // Sem cli-config.json com authInfo não há par accountID::token possível.
  const agentConfig = path.join(os.homedir(), '.cursor', 'cli-config.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(agentConfig, 'utf8')) as {
      authInfo?: unknown;
    };
    if (!parsed.authInfo) return null;
  } catch {
    return null;
  }

  if (
    cachedAgentToken &&
    Date.now() - cachedAgentTokenCheckedAt < AGENT_TOKEN_CACHE_TTL_MS &&
    !jwtExpired(cachedAgentToken)
  ) {
    return cursorAgentSession(cachedAgentToken, agentConfig);
  }
  const token = await readCursorAgentToken(exec);
  cachedAgentToken = token;
  cachedAgentTokenCheckedAt = Date.now();
  return token ? cursorAgentSession(token, agentConfig) : null;
}

/**
 * Probe live completo (sessão local + GET). null honesto em qualquer falha.
 */
export async function fetchCursorUsageWindowsLive(opts?: {
  fetchImpl?: FetchLike;
  now?: number;
  execImpl?: ExecImpl;
}): Promise<QuotaWindow[] | null> {
  const session = await loadCursorSession(opts?.execImpl);
  if (!session) return null;
  return fetchCursorUsageWindows(session, opts);
}

/**
 * GET /api/usage-summary com a sessão dada. null em 401/403/rede/parse.
 */
export async function fetchCursorUsageWindows(
  session: CursorSession | null,
  opts?: {
    fetchImpl?: FetchLike;
    timeoutMs?: number;
    now?: number;
  },
): Promise<QuotaWindow[] | null> {
  if (!session?.accountId?.trim() || !session?.accessToken?.trim()) return null;
  const fetchImpl = opts?.fetchImpl ?? (globalThis.fetch as FetchLike);
  if (typeof fetchImpl !== 'function') return null;

  const timeoutMs = opts?.timeoutMs ?? CURSOR_USAGE_TIMEOUT_MS;
  const now = opts?.now ?? Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(CURSOR_USAGE_SUMMARY_URL, {
      method: 'GET',
      headers: {
        Cookie: cursorWorkosCookie(session),
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = await res.json();
    const windows = parseCursorUsageSummary(body, now);
    return windows.length > 0 ? windows : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
