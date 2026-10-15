import fsp from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { runPeriodicTask, stopPeriodicTask } from '../observability/periodic-task';
import { readRegularFileCappedAsync } from '../redline/redline-safe-read';
/**
 * Serialize Codex (ChatGPT) and Grok pane spawns that share one auth.json.
 *
 * The Codex CLI itself rotates the refresh token on boot when the access
 * token is stale. Nexus does not refresh that token. Each pane gets a
 * private CODEX_HOME overlay whose `mcp-oauth-locks/file-store.lock` is
 * the CLI's MCP-server OAuth store lock — per overlay, not per account —
 * so it cannot coordinate ChatGPT `auth.json` refresh. N panes of the
 * same managed (or native) account therefore all present the same
 * single-use refresh token; the first rotation revokes the family.
 *
 * This gate: one leader spawn per auth file while the token is stale;
 * followers wait (file lock + timeout) and reuse the rewritten token.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withGrokAuthFamilyGate, resetGrokAuthFamiliesForTests } from './grok-auth-family-gate';
import { grokSessionNeedsLogin } from './auth-freshness';
import {
  isFileAuthAdapter,
  MANAGED_PROVIDER_SPECS,
  type FileAuthAdapterId,
} from './managed-credentials';

export const ROTATING_REFRESH_SPAWN_ADAPTERS: ReadonlySet<string> = new Set([
  'codex',
  'grok',
]);

/** Treat the access token as stale this long before JWT exp. */
export const AUTH_SPAWN_GATE_SKEW_MS = 5 * 60_000;
/** Followers refuse the spawn if the first pane has not refreshed by then. */
export const AUTH_SPAWN_GATE_TIMEOUT_MS = 12_000;
export const AUTH_SPAWN_GATE_POLL_MS = 50;

export type AuthSpawnGateRole = 'fresh' | 'leader' | 'follower-fresh';

let watcherEpoch = 0;
const watchers = new Map<ReturnType<typeof setInterval>, { id: string; controller: AbortController }>();

export function resetManagedAuthSpawnGateForTests(): void {
  watcherEpoch++;
  for (const [timer, owner] of watchers) { clearInterval(timer); owner.controller.abort(new Error('auth gate watcher stopped')); void stopPeriodicTask(owner.id); }
  watchers.clear();
  resetGrokAuthFamiliesForTests();
}

export function rotatingAuthLockPath(authFile: string): string {
  return `${authFile}.nexus-spawn.lock`;
}

export function resolveRotatingAuthFile(
  adapterId: string,
  preparedEnv: Readonly<Record<string, string>> = {},
  home = os.homedir(),
): string | null {
  if (!ROTATING_REFRESH_SPAWN_ADAPTERS.has(adapterId)) return null;
  if (!isFileAuthAdapter(adapterId)) return null;
  const spec = MANAGED_PROVIDER_SPECS[adapterId as FileAuthAdapterId];
  // The caller must prepare the account first. A request without accountId
  // may still select a managed account; only its prepared environment tells
  // us which shared credential the CLI will actually read.
  const providerHome = preparedEnv[spec.homeEnvVar] || spec.systemHome(home);
  if (!providerHome) return null;
  return path.join(providerHome, spec.authRelativePath);
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const json = Buffer.from(padded, 'base64').toString('utf8');
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}


export interface AuthBlobFreshness {
  /** JWT `exp` in ms, when the access token is a JWT. */
  readonly expMs: number | null;
  /** Codex `last_refresh` wall clock, when present. */
  readonly lastRefreshMs: number | null;
}

export function authBlobFreshness(blob: string): AuthBlobFreshness {
  try {
    const parsed = JSON.parse(blob) as Record<string, unknown>;
    let lastRefreshMs: number | null = null;
    if (typeof parsed.last_refresh === 'string') {
      const t = Date.parse(parsed.last_refresh);
      if (Number.isFinite(t)) lastRefreshMs = t;
    }
    const tokens =
      parsed.tokens && typeof parsed.tokens === 'object'
        ? (parsed.tokens as Record<string, unknown>)
        : parsed;
    const grok = Object.values(parsed).find((value): value is Record<string, unknown> =>
      Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
        typeof (value as Record<string, unknown>).user_id === 'string'));
    const access = typeof tokens.access_token === 'string' ? tokens.access_token
      : typeof grok?.key === 'string' ? grok.key
        : typeof grok?.access_token === 'string' ? grok.access_token : null;
    const payload = access ? decodeJwtPayload(access) : null;
    const expMs =
      payload && typeof payload.exp === 'number' ? payload.exp * 1000 : null;
    return { expMs, lastRefreshMs };
  } catch {
    return { expMs: null, lastRefreshMs: null };
  }
}

export function authBlobIsFreshForSpawn(
  blob: string,
  now = Date.now(),
  skewMs = AUTH_SPAWN_GATE_SKEW_MS,
): boolean {
  const { expMs, lastRefreshMs } = authBlobFreshness(blob);
  // A rotation in the last minute is always reusable (JWT exp may lag the write).
  if (lastRefreshMs !== null && now - lastRefreshMs >= 0 && now - lastRefreshMs < 60_000) {
    return true;
  }
  if (expMs !== null) return expMs > now + skewMs;
  return false;
}

/**
 * F-1485: sessão Grok sem renovação possível (ver `grokSessionNeedsLogin`):
 * a CLI abriria o login por código no pane; num worker ninguém aprova, o
 * vigia de início derruba o pane aos ~110 s e o Maestro abre outro, que pede
 * login de novo.
 */
export const GROK_LOGIN_REQUIRED_MESSAGE =
  'A sessão do Grok expirou: a última renovação tem mais de 7 dias e o Grok não renova mais. ' +
  'Faça login uma vez — use "Entrar" no cartão do Grok na lista Atenção (ou em Configurações › ' +
  'Contas de IA), ou rode `grok login` num terminal — e os panes Grok voltam a abrir.';

/**
 * F-1485: o spawn usa a sessão OAuth do Grok — nenhuma API key/token foi
 * injetada no env preparado. Com `XAI_API_KEY` o OAuth vencido não importa.
 */
export function grokSpawnUsesOAuth(keyEnv: Readonly<Record<string, string>> = {}): boolean {
  return !Object.entries(keyEnv).some(
    ([name, value]) => /(?:_API_KEY|_AUTH_TOKEN)$/.test(name) && value.trim().length > 0,
  );
}

function rotationMarker(blob: string): number | null {
  const { expMs, lastRefreshMs } = authBlobFreshness(blob);
  return lastRefreshMs ?? expMs;
}

interface LockRecord {
  pid: number;
  at: number;
}

function readLock(lockPath: string): LockRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as {
      pid?: unknown;
      at?: unknown;
    };
    if (
      typeof parsed.pid !== 'number' ||
      !Number.isFinite(parsed.pid) ||
      typeof parsed.at !== 'number' ||
      !Number.isFinite(parsed.at)
    ) {
      return null;
    }
    return { pid: parsed.pid, at: parsed.at };
  } catch {
    return null;
  }
}

function tryAcquireLock(
  lockPath: string,
  now: number,
  timeoutMs: number,
): boolean {
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  } catch {
    // Parent may already exist.
  }
  try {
    fs.writeFileSync(
      lockPath,
      `${JSON.stringify({ pid: process.pid, at: now })}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return false;
    const existing = readLock(lockPath);
    if (!existing || now - existing.at > timeoutMs) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        return false;
      }
      return tryAcquireLock(lockPath, now, timeoutMs);
    }
    return false;
  }
}


async function watchUntilRefreshed(options: {
  authFile: string;
  lockPath: string;
  freshnessAtStart: number | null;
  timeoutMs: number;
  pollMs: number;
  now: () => number;
  readAuth: (file: string) => string | null | Promise<string | null>;
}): Promise<void> {
  const registrationEpoch = watcherEpoch;
  const deadline = options.now() + options.timeoutMs;
  const identity = await fsp.lstat(options.lockPath).catch(() => null);
  if (registrationEpoch !== watcherEpoch || !identity || !identity.isFile() || identity.isSymbolicLink()) return;
  const controller = new AbortController();
  const id = `managed-auth-refresh-watch:${randomUUID()}`;
  const timer = setInterval(() => {
    void runPeriodicTask(id, async (context) => {
      const blob = await context.wait(Promise.resolve(options.readAuth(options.authFile)));
      const freshness = blob ? rotationMarker(blob) : null;
      const rotated = freshness !== null &&
        (options.freshnessAtStart === null || freshness > options.freshnessAtStart);
      if (!rotated && options.now() < deadline) return;
      const owner = watchers.get(timer);
      if (!owner || owner.controller !== controller) return;
      const current = await context.wait(fsp.lstat(options.lockPath).catch(() => null));
      if (watchers.get(timer)?.controller !== controller) return;
      clearInterval(timer);
      watchers.delete(timer);
      if (current && current.dev === identity.dev && current.ino === identity.ino &&
        current.size === identity.size && current.mtimeMs === identity.mtimeMs) {
        await context.wait(fsp.unlink(options.lockPath).catch(() => undefined));
      }
    }, { signal: controller.signal, cadenceMs: options.pollMs }).catch(() => undefined).finally(() => {
      if (!watchers.has(timer)) void stopPeriodicTask(id);
    });
  }, options.pollMs);
  watchers.set(timer, { id, controller });
  timer.unref?.();
}

export async function stopManagedAuthSpawnGateWatchers(): Promise<void> {
  watcherEpoch++;
  const owners = [...watchers];
  watchers.clear();
  for (const [timer, owner] of owners) { clearInterval(timer); owner.controller.abort(new Error('auth gate watchers stopped')); }
  await Promise.all(owners.map(([, owner]) => stopPeriodicTask(owner.id)));
}

type GateOptions = {
  authFile: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  readAuth?: (file: string) => string | null | Promise<string | null>;
  timeoutMs?: number;
  pollMs?: number;
  skewMs?: number;
  /**
   * F-1485: spawn de agente (não o pane do operador, onde o login é aprovado)
   * recusa na hora uma sessão Grok sem renovação possível.
   */
  refuseExpiredGrokSession?: boolean;
};

export function waitForRotatingAuthSpawnGate(options: GateOptions): Promise<AuthSpawnGateRole> {
  return withGrokAuthFamilyGate(options.authFile, (authFile) => waitForAuthFile({ ...options, authFile }));
}

async function waitForAuthFile(options: GateOptions): Promise<AuthSpawnGateRole> {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const readAuth = options.readAuth ?? (async (file: string) => {
    const result = await readRegularFileCappedAsync(file, 256 * 1024);
    return result.kind === 'text' && result.text.length ? result.text : null;
  });
  const timeoutMs = options.timeoutMs ?? AUTH_SPAWN_GATE_TIMEOUT_MS;
  const pollMs = options.pollMs ?? AUTH_SPAWN_GATE_POLL_MS;
  const skewMs = options.skewMs ?? AUTH_SPAWN_GATE_SKEW_MS;
  const authFile = options.authFile;
  const lockPath = rotatingAuthLockPath(authFile);

  const blob = await readAuth(authFile);
  if (!blob) return 'fresh';
  if (authBlobIsFreshForSpawn(blob, now(), skewMs)) return 'fresh';
  if (options.refuseExpiredGrokSession && grokSessionNeedsLogin(blob, now())) {
    throw new Error(GROK_LOGIN_REQUIRED_MESSAGE);
  }

  const freshnessAtStart = rotationMarker(blob);
  if (tryAcquireLock(lockPath, now(), timeoutMs)) {
    await watchUntilRefreshed({
      authFile,
      lockPath,
      freshnessAtStart,
      timeoutMs,
      pollMs,
      now,
      readAuth,
    });
    return 'leader';
  }

  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    await sleep(pollMs);
    const current = await readAuth(authFile);
    if (current && authBlobIsFreshForSpawn(current, now(), skewMs)) {
      return 'follower-fresh';
    }
    const currentFreshness = current ? rotationMarker(current) : null;
    if (
      currentFreshness !== null &&
      freshnessAtStart !== null &&
      currentFreshness > freshnessAtStart
    ) {
      return 'follower-fresh';
    }
    // A follower never promotes itself merely because the leader's lease
    // expired. Its CLI may still be refreshing; only changed auth proves it
    // is safe to reuse. A later explicit retry can recover an abandoned lock.
  }
  throw new Error(
    'A renovação de login ainda não terminou. Aguarde alguns segundos e tente abrir o pane novamente.',
  );
}
