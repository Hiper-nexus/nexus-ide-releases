/**
 * Serialize Codex (ChatGPT) pane spawns that share one auth.json.
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
import {
  isFileAuthAdapter,
  managedHomePath,
  MANAGED_PROVIDER_SPECS,
  type FileAuthAdapterId,
} from './managed-credentials';

export const ROTATING_REFRESH_SPAWN_ADAPTERS: ReadonlySet<string> = new Set([
  'codex',
]);

/** Treat the access token as stale this long before JWT exp. */
export const AUTH_SPAWN_GATE_SKEW_MS = 5 * 60_000;
/** Followers give up waiting and spawn anyway. */
export const AUTH_SPAWN_GATE_TIMEOUT_MS = 12_000;
export const AUTH_SPAWN_GATE_POLL_MS = 50;

export type AuthSpawnGateRole = 'fresh' | 'leader' | 'follower-fresh' | 'timeout';

const watchers = new Set<ReturnType<typeof setInterval>>();

export function resetManagedAuthSpawnGateForTests(): void {
  for (const timer of watchers) clearInterval(timer);
  watchers.clear();
}

export function rotatingAuthLockPath(authFile: string): string {
  return `${authFile}.nexus-spawn.lock`;
}

export function resolveRotatingAuthFile(
  adapterId: string,
  accountId?: string,
  home = os.homedir(),
): string | null {
  if (!ROTATING_REFRESH_SPAWN_ADAPTERS.has(adapterId)) return null;
  if (!isFileAuthAdapter(adapterId)) return null;
  const spec = MANAGED_PROVIDER_SPECS[adapterId as FileAuthAdapterId];
  if (accountId?.trim()) {
    return path.join(
      managedHomePath(adapterId as FileAuthAdapterId, accountId, home),
      spec.authRelativePath,
    );
  }
  const native = spec.systemHome(home);
  if (!native) return null;
  return path.join(native, spec.authRelativePath);
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

function readText(file: string): string | null {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.length > 0 ? text : null;
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
    const access =
      typeof tokens.access_token === 'string' ? tokens.access_token : null;
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

function releaseLock(lockPath: string): void {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // Already gone.
  }
}

function watchUntilRefreshed(options: {
  authFile: string;
  lockPath: string;
  freshnessAtStart: number | null;
  timeoutMs: number;
  pollMs: number;
  now: () => number;
  readAuth: (file: string) => string | null;
}): void {
  const deadline = options.now() + options.timeoutMs;
  const timer = setInterval(() => {
    const now = options.now();
    const blob = options.readAuth(options.authFile);
    const freshness = blob ? rotationMarker(blob) : null;
    const rotated =
      freshness !== null &&
      (options.freshnessAtStart === null ||
        freshness > options.freshnessAtStart);
    if (rotated || now >= deadline) {
      clearInterval(timer);
      watchers.delete(timer);
      releaseLock(options.lockPath);
    }
  }, options.pollMs);
  watchers.add(timer);
  timer.unref?.();
}

export async function waitForRotatingAuthSpawnGate(options: {
  authFile: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  readAuth?: (file: string) => string | null;
  timeoutMs?: number;
  pollMs?: number;
  skewMs?: number;
}): Promise<AuthSpawnGateRole> {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const readAuth = options.readAuth ?? readText;
  const timeoutMs = options.timeoutMs ?? AUTH_SPAWN_GATE_TIMEOUT_MS;
  const pollMs = options.pollMs ?? AUTH_SPAWN_GATE_POLL_MS;
  const skewMs = options.skewMs ?? AUTH_SPAWN_GATE_SKEW_MS;
  const authFile = options.authFile;
  const lockPath = rotatingAuthLockPath(authFile);

  const blob = readAuth(authFile);
  if (!blob) return 'fresh';
  if (authBlobIsFreshForSpawn(blob, now(), skewMs)) return 'fresh';

  const freshnessAtStart = rotationMarker(blob);
  if (tryAcquireLock(lockPath, now(), timeoutMs)) {
    watchUntilRefreshed({
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
    const current = readAuth(authFile);
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
    if (tryAcquireLock(lockPath, now(), timeoutMs)) {
      watchUntilRefreshed({
        authFile,
        lockPath,
        freshnessAtStart: currentFreshness,
        timeoutMs,
        pollMs,
        now,
        readAuth,
      });
      return 'leader';
    }
  }
  return 'timeout';
}
