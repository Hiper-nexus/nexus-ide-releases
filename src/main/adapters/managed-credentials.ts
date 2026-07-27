import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isFileAuthAdapter,
  type FileAuthAdapterId,
} from '../../shared/file-auth-adapters';

export { isFileAuthAdapter };
export type { FileAuthAdapterId };

/**
 * File-backed subscription credentials (Codex/Grok/Kimi/OpenCode/AGY).
 * Orca pattern, lean: each saved account gets a managed home under
 * ~/.nexus/managed-accounts/<adapter>/<accountId>/ with auth rewritten on
 * activate/spawn. Process-scoped home env (CODEX_HOME, GROK_HOME, …) keeps
 * concurrent panes on different accounts without re-login.
 *
 * Claude stays on keychain + CLAUDE_CODE_OAUTH_TOKEN (see account-store).
 */

export interface ManagedAuthCapture {
  blob: string;
  email?: string;
  /** Relative path of the auth file inside the managed home. */
  authRelativePath: string;
}

export interface ManagedProviderSpec {
  adapterId: FileAuthAdapterId;
  /** Env var that points the CLI at an alternate home/config dir. */
  homeEnvVar: string;
  /** Relative path of the primary auth file inside the native home. */
  authRelativePath: string;
  /** Additional relative auth candidates (first hit wins for capture). */
  authCandidates?: string[];
  /** Extra home-relative paths to skip when linking from the system home. */
  skipLinkNames: string[];
  /** Resolve the user's real CLI home directory. */
  systemHome(home?: string): string | null;
}

function exists(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

function firstExisting(paths: string[]): string | null {
  for (const p of paths) {
    if (exists(p)) return p;
  }
  return null;
}

function readText(file: string): string | null {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const json = Buffer.from(padded, 'base64').toString('utf8');
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function stringClaim(
  obj: Record<string, unknown> | null,
  keys: string[],
): string | null {
  if (!obj) return null;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/** Best-effort email/identity from a provider auth blob (never throws). */
export function identityFromAuthBlob(
  adapterId: string,
  blob: string,
): { email?: string } {
  try {
    const parsed = JSON.parse(blob) as Record<string, unknown>;
    if (adapterId === 'codex') {
      const tokens =
        parsed.tokens && typeof parsed.tokens === 'object'
          ? (parsed.tokens as Record<string, unknown>)
          : null;
      const idToken =
        typeof tokens?.id_token === 'string' ? tokens.id_token : null;
      const accessToken =
        typeof tokens?.access_token === 'string' ? tokens.access_token : null;
      const email =
        stringClaim(decodeJwtPayload(idToken ?? ''), [
          'email',
          'preferred_username',
          'upn',
        ]) ??
        stringClaim(decodeJwtPayload(accessToken ?? ''), [
          'email',
          'preferred_username',
          'upn',
        ]);
      return email ? { email } : {};
    }
    if (adapterId === 'grok') {
      const email =
        stringClaim(parsed, ['email', 'user_email']) ??
        stringClaim(
          parsed.user && typeof parsed.user === 'object'
            ? (parsed.user as Record<string, unknown>)
            : null,
          ['email'],
        );
      return email ? { email } : {};
    }
    if (adapterId === 'kimi' || adapterId === 'opencode' || adapterId === 'agy') {
      const email = stringClaim(parsed, [
        'email',
        'user_email',
        'accountEmail',
      ]);
      return email ? { email } : {};
    }
  } catch {
    // Not JSON or unexpected shape — identity is optional.
  }
  return {};
}

export const MANAGED_PROVIDER_SPECS: Record<FileAuthAdapterId, ManagedProviderSpec> = {
  codex: {
    adapterId: 'codex',
    homeEnvVar: 'CODEX_HOME',
    authRelativePath: 'auth.json',
    skipLinkNames: ['auth.json'],
    systemHome: (home = os.homedir()) => path.join(home, '.codex'),
  },
  grok: {
    adapterId: 'grok',
    homeEnvVar: 'GROK_HOME',
    authRelativePath: 'auth.json',
    skipLinkNames: ['auth.json'],
    systemHome: (home = os.homedir()) => path.join(home, '.grok'),
  },
  kimi: {
    adapterId: 'kimi',
    homeEnvVar: 'KIMI_CODE_HOME',
    authRelativePath: path.join('credentials', 'kimi-code.json'),
    authCandidates: [
      path.join('oauth', 'kimi-code'),
      path.join('credentials', 'kimi-code.json'),
    ],
    skipLinkNames: ['oauth', 'credentials'],
    systemHome: (home = os.homedir()) => {
      const candidates = [
        path.join(home, '.kimi-code'),
        path.join(home, '.kimi'),
      ];
      return firstExisting(candidates) ?? path.join(home, '.kimi-code');
    },
  },
  opencode: {
    adapterId: 'opencode',
    homeEnvVar: 'XDG_DATA_HOME',
    authRelativePath: path.join('opencode', 'auth.json'),
    skipLinkNames: ['opencode'],
    systemHome: (home = os.homedir()) => {
      // OPENCODE often uses XDG: ~/.local/share — we store managed under that tree.
      const xdg = path.join(home, '.local', 'share');
      const mac = path.join(home, 'Library', 'Application Support');
      if (exists(path.join(xdg, 'opencode', 'auth.json'))) return xdg;
      if (exists(path.join(mac, 'opencode', 'auth.json'))) return mac;
      return xdg;
    },
  },
  agy: {
    adapterId: 'agy',
    homeEnvVar: 'GEMINI_CLI_HOME',
    authRelativePath: 'antigravity',
    authCandidates: ['antigravity', 'antigravity-cli'],
    skipLinkNames: ['antigravity', 'antigravity-cli'],
    systemHome: (home = os.homedir()) => path.join(home, '.gemini'),
  },
};

export function managedAccountsRoot(
  adapterId: string,
  home = os.homedir(),
): string {
  return path.join(home, '.nexus', 'managed-accounts', adapterId);
}

export function managedHomePath(
  adapterId: string,
  accountId: string,
  home = os.homedir(),
): string {
  // Containment: accountId must be a single path segment.
  if (
    !accountId ||
    accountId.includes('..') ||
    accountId.includes('/') ||
    accountId.includes('\\') ||
    accountId.includes('\0')
  ) {
    throw new Error('invalid managed account id');
  }
  return path.join(managedAccountsRoot(adapterId, home), accountId, 'home');
}

function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Best-effort on platforms that ignore mode.
  }
}

function writePrivateFile(file: string, contents: string): void {
  ensurePrivateDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, contents, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // ignore
  }
}

function linkOrCopy(source: string, target: string, isDir: boolean): void {
  try {
    if (process.platform === 'win32' && isDir) {
      fs.symlinkSync(source, target, 'junction');
      return;
    }
    fs.symlinkSync(source, target);
  } catch {
    if (isDir) {
      fs.cpSync(source, target, { recursive: true });
    } else {
      fs.copyFileSync(source, target);
    }
  }
}

interface DirSnapshot {
  __nexusDirSnapshot: true;
  root: string;
  files: Record<string, string>;
}

function parseDirSnapshot(blob: string): DirSnapshot | null {
  try {
    const parsed = JSON.parse(blob) as unknown;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      (parsed as DirSnapshot).__nexusDirSnapshot !== true
    ) {
      return null;
    }
    const snap = parsed as DirSnapshot;
    if (typeof snap.root !== 'string' || !snap.files || typeof snap.files !== 'object') {
      return null;
    }
    return snap;
  } catch {
    return null;
  }
}

/** Safe relative path under managed home (no absolute / parent escape). */
function safeRelPath(rel: string): string | null {
  if (!rel || rel.includes('\0')) return null;
  const parts = rel.split(/[/\\]/).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.some((p) => p === '.' || p === '..')) return null;
  return parts.join(path.sep);
}

function restoreDirSnapshot(managedHome: string, snap: DirSnapshot): void {
  const root = safeRelPath(snap.root);
  if (!root) throw new Error('invalid directory snapshot root');
  const base = path.join(managedHome, root);
  ensurePrivateDir(base);
  for (const [rel, contents] of Object.entries(snap.files)) {
    if (typeof contents !== 'string') continue;
    const safe = safeRelPath(rel);
    if (!safe) continue;
    const dest = path.join(base, safe);
    if (!dest.startsWith(base + path.sep) && dest !== base) continue;
    writePrivateFile(dest, contents);
  }
}

function authTargetPath(
  adapterId: FileAuthAdapterId,
  managedHome: string,
  authRelativePath?: string,
): string {
  const spec = MANAGED_PROVIDER_SPECS[adapterId];
  if (adapterId === 'opencode') {
    return path.join(managedHome, 'opencode', 'auth.json');
  }
  if (authRelativePath) {
    const safe = safeRelPath(authRelativePath);
    if (safe) return path.join(managedHome, safe);
  }
  return path.join(managedHome, spec.authRelativePath);
}

/**
 * Prefer on-disk managed auth when it is newer than the vault snapshot
 * (OAuth CLIs refresh tokens in place; re-writing stale vault blobs kills the session).
 */
export function shouldWriteAuthFile(
  existingPath: string,
  vaultBlob: string,
): boolean {
  try {
    if (!exists(existingPath)) return true;
    const onDisk = fs.readFileSync(existingPath, 'utf8');
    if (onDisk === vaultBlob) return false;
    // If both are JSON with token freshness fields, keep the fresher one.
    const diskFresh = freshnessFromAuthContents(onDisk);
    const vaultFresh = freshnessFromAuthContents(vaultBlob);
    if (diskFresh !== null && vaultFresh !== null) {
      return vaultFresh > diskFresh;
    }
    // Unknown shapes: do not clobber an existing managed file (CLI may have refreshed).
    return false;
  } catch {
    return true;
  }
}

function freshnessFromAuthContents(contents: string): number | null {
  try {
    const parsed = JSON.parse(contents) as Record<string, unknown>;
    if (typeof parsed.last_refresh === 'string') {
      const t = Date.parse(parsed.last_refresh);
      if (!Number.isNaN(t)) return t;
    }
    const tokens =
      parsed.tokens && typeof parsed.tokens === 'object'
        ? (parsed.tokens as Record<string, unknown>)
        : null;
    const access =
      typeof tokens?.access_token === 'string' ? tokens.access_token : null;
    if (access) {
      const payload = decodeJwtPayload(access);
      const exp = payload && typeof payload.exp === 'number' ? payload.exp * 1000 : null;
      if (exp) return exp;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Mirror the system CLI home into a managed home, then write the account's
 * auth. Never clobber a fresher on-disk OAuth session with a stale vault blob.
 */
export function materializeManagedHome(
  adapterId: FileAuthAdapterId,
  accountId: string,
  authBlob: string,
  options: {
    home?: string;
    systemHome?: string | null;
    authRelativePath?: string;
  } = {},
): string {
  const spec = MANAGED_PROVIDER_SPECS[adapterId];
  const managedHome = managedHomePath(adapterId, accountId, options.home);
  const systemHome =
    options.systemHome === undefined
      ? spec.systemHome(options.home)
      : options.systemHome;

  ensurePrivateDir(managedHome);

  if (systemHome && exists(systemHome) && path.resolve(systemHome) !== path.resolve(managedHome)) {
    const skip = new Set(spec.skipLinkNames);
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(systemHome, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const target = path.join(managedHome, entry.name);
      if (exists(target)) continue;
      const source = path.join(systemHome, entry.name);
      try {
        linkOrCopy(source, target, entry.isDirectory());
      } catch (err) {
        console.warn(
          `[managed-credentials] link ${entry.name} failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  const dirSnap = parseDirSnapshot(authBlob);
  if (dirSnap) {
    restoreDirSnapshot(managedHome, dirSnap);
    return managedHome;
  }

  const authPath = authTargetPath(adapterId, managedHome, options.authRelativePath);
  if (shouldWriteAuthFile(authPath, authBlob)) {
    writePrivateFile(authPath, authBlob);
  }

  return managedHome;
}

/**
 * If the managed home auth is fresher than `vaultBlob`, return the on-disk
 * contents so the caller can update the vault (read-back after CLI refresh).
 */
export function readBackFresherAuth(
  adapterId: FileAuthAdapterId,
  accountId: string,
  vaultBlob: string,
  options: { home?: string; authRelativePath?: string } = {},
): string | null {
  try {
    const managedHome = managedHomePath(adapterId, accountId, options.home);
    const authPath = authTargetPath(adapterId, managedHome, options.authRelativePath);
    if (!exists(authPath)) return null;
    const onDisk = fs.readFileSync(authPath, 'utf8');
    if (onDisk === vaultBlob) return null;
    const diskFresh = freshnessFromAuthContents(onDisk);
    const vaultFresh = freshnessFromAuthContents(vaultBlob);
    if (diskFresh !== null && vaultFresh !== null && diskFresh > vaultFresh) {
      return onDisk;
    }
    // Non-JSON or unknown freshness: if files differ, prefer disk after any spawn.
    if (diskFresh === null && vaultFresh === null && onDisk !== vaultBlob) {
      return onDisk;
    }
    return null;
  } catch {
    return null;
  }
}

/** Env patch so the next CLI process uses this managed home. */
export function managedHomeEnv(
  adapterId: FileAuthAdapterId,
  managedHome: string,
): Record<string, string> {
  const spec = MANAGED_PROVIDER_SPECS[adapterId];
  if (adapterId === 'opencode') {
    // XDG_DATA_HOME must parent the `opencode/` directory.
    return { XDG_DATA_HOME: managedHome };
  }
  if (adapterId === 'agy') {
    return {
      GEMINI_CLI_HOME: managedHome,
      // Some AGY builds also honor HOME overlays for config; keep primary var.
    };
  }
  return { [spec.homeEnvVar]: managedHome };
}

/** Capture the currently active native session into a vault-ready blob. */
export function captureNativeAuth(
  adapterId: string,
  home = os.homedir(),
): ManagedAuthCapture | null {
  if (adapterId === 'claude') {
    // Claude is keychain-backed — caller uses claude-credential.ts.
    return null;
  }
  if (!isFileAuthAdapter(adapterId)) return null;
  const spec = MANAGED_PROVIDER_SPECS[adapterId];
  const systemHome = spec.systemHome(home);
  if (!systemHome) return null;

  if (adapterId === 'agy') {
    const candidates = (spec.authCandidates ?? [spec.authRelativePath]).map((rel) =>
      path.join(systemHome, rel),
    );
    const hit = firstExisting(candidates);
    if (!hit) return null;
    // Store a pointer snapshot (path + mtime) + optional nested auth files as JSON.
    const payload = snapshotDirectoryAuth(hit);
    if (!payload) return null;
    const identity = identityFromAuthBlob(adapterId, payload);
    return {
      blob: payload,
      email: identity.email,
      authRelativePath: path.relative(systemHome, hit),
    };
  }

  const candidates = [
    path.join(systemHome, spec.authRelativePath),
    ...(spec.authCandidates ?? []).map((rel) => path.join(systemHome, rel)),
  ];
  // Kimi oauth path may be a file without extension.
  for (const candidate of candidates) {
    if (!exists(candidate)) continue;
    const st = fs.statSync(candidate);
    if (st.isDirectory()) {
      const payload = snapshotDirectoryAuth(candidate);
      if (!payload) continue;
      const identity = identityFromAuthBlob(adapterId, payload);
      return {
        blob: payload,
        email: identity.email,
        authRelativePath: path.relative(systemHome, candidate),
      };
    }
    const blob = readText(candidate);
    if (!blob) continue;
    const identity = identityFromAuthBlob(adapterId, blob);
    return {
      blob,
      email: identity.email,
      authRelativePath: path.relative(systemHome, candidate),
    };
  }
  return null;
}

const MAX_SNAPSHOT_FILES = 64;
const MAX_SNAPSHOT_TOTAL_BYTES = 1_500_000;

function snapshotDirectoryAuth(dir: string): string | null {
  try {
    const files: Record<string, string> = {};
    let totalBytes = 0;
    let fileCount = 0;
    const walk = (current: string, prefix: string) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (fileCount >= MAX_SNAPSHOT_FILES) return;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          walk(full, rel);
          continue;
        }
        if (!entry.isFile()) continue;
        const st = fs.statSync(full);
        if (st.size > 512 * 1024) continue;
        if (totalBytes + st.size > MAX_SNAPSHOT_TOTAL_BYTES) return;
        // Prefer text; skip obvious binary via null bytes in sample.
        const buf = fs.readFileSync(full);
        if (buf.includes(0)) continue;
        const text = buf.toString('utf8');
        files[rel] = text;
        totalBytes += st.size;
        fileCount += 1;
      }
    };
    walk(dir, '');
    if (Object.keys(files).length === 0) return null;
    return JSON.stringify({
      __nexusDirSnapshot: true,
      root: path.basename(dir),
      files,
    });
  } catch {
    return null;
  }
}

export function removeManagedHome(
  adapterId: string,
  accountId: string,
  home = os.homedir(),
): void {
  try {
    const dir = managedHomePath(adapterId, accountId, home);
    fs.rmSync(dir, { recursive: true, force: true });
    // Remove empty account folder.
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  } catch {
    // Best-effort cleanup.
  }
}

/**
 * M1 mitigation: scrub the plaintext auth.json from a managed home after the
 * CLI pane that consumed it exits. The vault (safeStorage/Keychain) keeps the
 * encrypted copy; the plaintext materialization is ephemeral — it exists only
 * while the CLI process is alive. On next spawn, materializeManagedHome
 * re-creates it from the vault.
 *
 * This drastically reduces the window during which a same-user agent/skill can
 * `cat` the auth file and exfiltrate OAuth tokens.
 */
export function scrubManagedAuth(
  adapterId: FileAuthAdapterId,
  accountId: string,
  options: { home?: string; authRelativePath?: string } = {},
): void {
  try {
    const managedHome = managedHomePath(adapterId, accountId, options.home);
    const authPath = authTargetPath(adapterId, managedHome, options.authRelativePath);
    fs.unlinkSync(authPath);
  } catch {
    // Best-effort: file may already be gone or never written.
  }
}

// ---------------------------------------------------------------------------
// Session → managed-account tracker (M1 ephemeral lifecycle).
// The PTY layer registers which adapter/account a session uses; on session exit
// the auth file is scrubbed.
// ---------------------------------------------------------------------------

interface ManagedSessionEntry {
  adapterId: FileAuthAdapterId;
  accountId: string;
}

const managedSessionRegistry = new Map<string, ManagedSessionEntry>();

/**
 * Refcount de sessões vivas por conta gerenciada (adapter:accountId). Dois panes
 * na MESMA conta compartilham o auth.json materializado — o primeiro a sair NÃO
 * pode apagar o arquivo debaixo do CLI ainda vivo no segundo pane.
 */
const liveSessionsByAccount = new Map<string, number>();

function accountKey(entry: ManagedSessionEntry): string {
  return `${entry.adapterId}:${entry.accountId}`;
}

/**
 * Callback opcional (registrado pelo account-store, dono do vault) para
 * persistir tokens renovados pelo CLI ANTES de destruir a única cópia fresca do
 * auth.json. Mantém a camada de segredos fora deste módulo (sem import circular).
 */
type FresherAuthPersister = (adapterId: FileAuthAdapterId, accountId: string) => void;
let persistFresherCallback: FresherAuthPersister | null = null;

export function setManagedAuthPersister(fn: FresherAuthPersister | null): void {
  persistFresherCallback = fn;
}

/** Register a PTY session as consuming a managed account's auth. */
export function trackManagedSession(
  sessionId: string,
  adapterId: FileAuthAdapterId,
  accountId: string,
): void {
  // Guarda defensiva: re-track do mesmo sessionId não pode incrementar o
  // refcount de novo (senão o auth.json nunca mais seria removido — perda
  // silenciosa da garantia M1). Callers atuais trackeiam uma vez por spawn.
  if (managedSessionRegistry.has(sessionId)) return;
  managedSessionRegistry.set(sessionId, { adapterId, accountId });
  const key = accountKey({ adapterId, accountId });
  liveSessionsByAccount.set(key, (liveSessionsByAccount.get(key) ?? 0) + 1);
}

/**
 * Scrub the auth file for a session that just exited (idempotent). Só apaga o
 * auth.json quando NÃO resta nenhuma outra sessão viva da mesma conta; antes de
 * apagar, persiste no vault um token eventualmente renovado pelo CLI (read-back),
 * senão o refresh feito durante a sessão seria perdido junto com o arquivo.
 */
export function scrubManagedSessionAuth(sessionId: string): void {
  const entry = managedSessionRegistry.get(sessionId);
  if (!entry) return;
  managedSessionRegistry.delete(sessionId);
  const key = accountKey(entry);
  const remaining = (liveSessionsByAccount.get(key) ?? 1) - 1;
  if (remaining > 0) {
    // Outra sessão da MESMA conta ainda usa o auth.json — não apaga.
    liveSessionsByAccount.set(key, remaining);
    return;
  }
  liveSessionsByAccount.delete(key);
  // Persiste token renovado pelo CLI ANTES de destruir a única cópia fresca.
  if (persistFresherCallback) {
    try {
      persistFresherCallback(entry.adapterId, entry.accountId);
    } catch {
      // Best-effort: falha de vault não impede o scrub de segurança.
    }
  }
  scrubManagedAuth(entry.adapterId, entry.accountId);
}

/** Whether a native (unmanaged) subscription session is present for the adapter. */
export function hasNativeFileAuth(adapterId: string, home = os.homedir()): boolean {
  return captureNativeAuth(adapterId, home) !== null;
}
