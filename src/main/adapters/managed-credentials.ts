import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ensurePrivateDirectory, linkFile, linkProviderSessionState } from '../orch/cli-mcp-session-artifacts';
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
  /** Non-secret account metadata that may live beside the auth artifact. */
  identityCandidates?: string[];
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

export interface ManagedAuthIdentity {
  email?: string;
  /** Provider-scoped stable subject; main-only and never sent to the renderer. */
  subject?: string;
}

export type AuthIdentityComparison = 'same' | 'different' | 'unknown';

const EMAIL_KEY_NAMES = new Set([
  'email',
  'useremail',
  'accountemail',
  'emailaddress',
]);

function normalizedClaimKey(key: string): string {
  return key.replace(/[-_]/g, '').toLowerCase();
}

function validEmail(value: string | null): string | null {
  return value && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value) ? value : null;
}

function findStringClaimDeep(
  value: unknown,
  keys: ReadonlySet<string>,
  depth = 0,
): string | null {
  if (depth > 10 || value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const jwt = decodeJwtPayload(value);
    return jwt ? findStringClaimDeep(jwt, keys, depth + 1) : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStringClaimDeep(item, keys, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  for (const [key, candidate] of Object.entries(record)) {
    if (!keys.has(normalizedClaimKey(key))) continue;
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  for (const candidate of Object.values(record)) {
    const found = findStringClaimDeep(candidate, keys, depth + 1);
    if (found) return found;
  }
  return null;
}

function parsedAuthBlob(blob: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(blob) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Devin guarda a sessão em TOML **plano** (sem seções) em
 * ~/.local/share/devin/credentials.toml. Todos os helpers acima parseiam JSON e
 * devolvem null para esse blob — sem um ramo próprio, uma conta Devin logada
 * seria lida como "sem auth" e o fingerprint da sessão nunca sairia.
 *
 * A varredura é linha a linha e só olha NOME de chave e valor: TOML plano não
 * tem aninhamento, então não há risco de casar uma chave aninhada por engano.
 */
const DEVIN_CREDENTIAL_KEYS = new Set([
  'windsurf_api_key',
  'api_key',
  'token',
]);

export function devinTomlCredentialValue(blob: string): string | null {
  for (const rawLine of blob.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('[')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!DEVIN_CREDENTIAL_KEYS.has(key)) continue;
    const value = line
      .slice(eq + 1)
      .trim()
      .replace(/^["']/u, '')
      .replace(/["']$/u, '')
      .trim();
    if (value) return value;
  }
  return null;
}

function directorySnapshotIdentity(
  adapterId: string,
  snapshot: DirSnapshot,
): ManagedAuthIdentity {
  let email: string | undefined;
  let subject: string | undefined;
  for (const contents of Object.values(snapshot.files)) {
    const identity = identityFromAuthBlob(adapterId, contents);
    email ??= identity.email;
    subject ??= identity.subject;
    if (email && subject) break;
  }
  return { ...(email ? { email } : {}), ...(subject ? { subject } : {}) };
}

/** Best-effort non-secret identity from a provider auth blob (never throws). */
export function identityFromAuthBlob(
  adapterId: string,
  blob: string,
): ManagedAuthIdentity {
  const parsed = parsedAuthBlob(blob);
  if (!parsed) return {};
  const snapshot = parseDirSnapshot(blob);
  if (snapshot) return directorySnapshotIdentity(adapterId, snapshot);

  const emailKeys = new Set(EMAIL_KEY_NAMES);
  if (adapterId === 'agy') emailKeys.add('active');
  const email = validEmail(findStringClaimDeep(parsed, emailKeys));
  const subjectKeys =
    adapterId === 'codex'
      ? new Set(['accountid', 'chatgptaccountid'])
      : adapterId === 'grok'
        ? new Set(['userid', 'principalid'])
        : adapterId === 'kimi'
          ? new Set(['userid', 'sub'])
          : adapterId === 'agy'
            ? new Set(['sub'])
            : null;
  const subject = subjectKeys
    ? findStringClaimDeep(parsed, subjectKeys)
    : null;
  return {
    ...(email ? { email } : {}),
    ...(subject ? { subject } : {}),
  };
}

function hasNonEmptyClaim(value: unknown, keys: string[]): boolean {
  return Boolean(
    findStringClaimDeep(value, new Set(keys.map(normalizedClaimKey))),
  );
}

/** A present file is not auth proof: reject empty/stale shells and invalid JSON. */
export function authBlobIsUsable(adapterId: string, blob: string): boolean {
  // Antes do guard de JSON: o blob do Devin é TOML plano e jamais parsearia.
  if (adapterId === 'devin' && !parseDirSnapshot(blob)) {
    return devinTomlCredentialValue(blob) !== null;
  }
  const parsed = parsedAuthBlob(blob);
  if (!parsed) return false;
  const snapshot = parseDirSnapshot(blob);
  if (snapshot) {
    return Object.values(snapshot.files).some((contents) =>
      authBlobIsUsable(adapterId, contents),
    );
  }
  if (adapterId === 'codex') {
    return hasNonEmptyClaim(parsed.tokens, ['access_token', 'refresh_token']);
  }
  if (adapterId === 'grok') {
    return hasNonEmptyClaim(parsed, ['key', 'access_token', 'refresh_token']);
  }
  if (adapterId === 'kimi') {
    const access = findStringClaimDeep(parsed, new Set(['accesstoken']));
    if (!access) return false;
    const refresh = findStringClaimDeep(parsed, new Set(['refreshtoken']));
    const rawExpiry = Number(parsed.expires_at);
    if (!Number.isFinite(rawExpiry) || rawExpiry <= 0) return Boolean(refresh);
    const expirySeconds =
      rawExpiry >= 1_000_000_000_000
        ? Math.floor(rawExpiry / 1000)
        : Math.floor(rawExpiry);
    return (
      expirySeconds - Math.floor(Date.now() / 1000) > 5 * 60 ||
      Boolean(refresh)
    );
  }
  if (adapterId === 'opencode') {
    return hasNonEmptyClaim(parsed, ['key', 'access', 'refresh']);
  }
  if (adapterId === 'agy') {
    return hasNonEmptyClaim(parsed, [
      'token',
      'access_token',
      'refresh_token',
      'id_token',
    ]);
  }
  return false;
}

/**
 * Compare provider identities without exposing their subject or credential.
 * A stable subject outranks email: one email can own two Codex workspaces.
 */
export function compareAuthBlobIdentity(
  adapterId: string,
  leftBlob: string,
  rightBlob: string,
): AuthIdentityComparison {
  const left = identityFromAuthBlob(adapterId, leftBlob);
  const right = identityFromAuthBlob(adapterId, rightBlob);
  if (left.subject && right.subject) {
    return left.subject === right.subject ? 'same' : 'different';
  }
  if (left.email && right.email) {
    return left.email.trim().toLowerCase() === right.email.trim().toLowerCase()
      ? 'same'
      : 'different';
  }
  return leftBlob === rightBlob ? 'same' : 'unknown';
}

function authFingerprint(
  adapterId: string,
  blob: string,
  identity: ManagedAuthIdentity,
): string | undefined {
  if (!authBlobIsUsable(adapterId, blob)) return undefined;
  const material = identity.subject
    ? `subject:${identity.subject}`
    : identity.email
      ? `email:${identity.email.trim().toLowerCase()}`
      : `credential:${blob}`;
  return createHash('sha256')
    .update(`${adapterId}\0${material}`)
    .digest('hex');
}

export const MANAGED_PROVIDER_SPECS: Record<FileAuthAdapterId, ManagedProviderSpec> = {
  codex: {
    adapterId: 'codex',
    homeEnvVar: 'CODEX_HOME',
    authRelativePath: 'auth.json',
    skipLinkNames: [
      'auth.json', 'sessions', 'archived_sessions', 'history.jsonl',
      'session_index.jsonl', 'state_5.sqlite', 'state_5.sqlite-wal', 'state_5.sqlite-shm',
      'logs_2.sqlite', 'logs_2.sqlite-wal', 'logs_2.sqlite-shm',
    ],
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
    authRelativePath: 'oauth_creds.json',
    authCandidates: [path.join('antigravity-cli', 'antigravity-oauth-token')],
    identityCandidates: ['google_accounts.json'],
    skipLinkNames: [
      'oauth_creds.json',
      'antigravity',
      'antigravity-cli',
    ],
    systemHome: (home = os.homedir()) => path.join(home, '.gemini'),
  },
  devin: {
    adapterId: 'devin',
    // O instalador oficial respeita XDG_DATA_HOME e instala em
    // $XDG_DATA_HOME/devin — o mesmo env var do opencode, mas aqui ele desloca
    // também credentials.toml, mcp/ e summaries/, não só a árvore de auth.
    homeEnvVar: 'XDG_DATA_HOME',
    authRelativePath: path.join('devin', 'credentials.toml'),
    skipLinkNames: ['devin'],
    systemHome: (home = os.homedir()) => {
      const ambient = process.env.XDG_DATA_HOME?.trim();
      const xdg = ambient ? ambient : path.join(home, '.local', 'share');
      // XDG é convenção de Linux; no macOS o Devin ainda usa ~/.local/share.
      return xdg;
    },
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
  adapterId?: FileAuthAdapterId,
): boolean {
  try {
    if (!exists(existingPath)) return true;
    const onDisk = fs.readFileSync(existingPath, 'utf8');
    if (onDisk === vaultBlob) return false;
    // TOML plano não carrega sinal de frescor e o blob não guarda identidade —
    // então "diferente" só pode significar troca de conta, e a escolha do
    // usuário (o vault) manda. Recusar aqui faria o spawn rodar como a conta
    // anterior sem nenhum sinal visível; reescrever, no pior caso, custa um
    // login de novo.
    if (adapterId === 'devin') return true;
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
  if (shouldWriteAuthFile(authPath, authBlob, adapterId)) {
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
    // Devin grava TOML plano: sem frescor e sem identidade legível. Ler de volta
    // sobrescreveria o vault com um blob opaco — a escolha do usuário (o vault)
    // é a autoridade, na mesma lógica de shouldWriteAuthFile.
    if (adapterId === 'devin') return null;
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

/** F-567: durable conversations belong to a checkout, credentials keep their source. */
export function prepareCheckoutProviderHome(
  kind: 'agy' | 'devin',
  options: { userDataPath: string; checkoutId: string; sourceHome: string },
): { stateHome: string; env: Record<string, string>; sharedFiles: string[]; sharedReadPaths: string[] } {
  if (!path.isAbsolute(options.userDataPath) || !path.isAbsolute(options.sourceHome)) {
    throw new Error('Provider checkout and auth homes must be absolute paths');
  }
  const sourceHome = path.resolve(options.sourceHome);
  // ponytail: reuse F-566's durable root directly; these CLIs need no MCP overlay.
  const checkoutHome = linkProviderSessionState(kind, options.userDataPath, options, [], {});
  // Account homes must not replace each other's auth while both panes run.
  const account = createHash('sha256').update(sourceHome).digest('hex').slice(0, 32);
  const stateHome = path.join(checkoutHome, account);
  if (fs.lstatSync(stateHome, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error('Provider session state must not be a symlink');
  }
  ensurePrivateDirectory(stateHome);
  const env: Record<string, string> = kind === 'agy'
    ? { HOME: stateHome, USERPROFILE: stateHome, GEMINI_CLI_HOME: path.join(stateHome, '.gemini') }
    : { XDG_DATA_HOME: stateHome };
  const providerHome = kind === 'agy' ? env.GEMINI_CLI_HOME : stateHome;
  const directories = kind === 'agy'
    ? ['.gemini', '.gemini/antigravity-cli', '.gemini/antigravity-cli/conversations', '.gemini/config', '.gemini/antigravity', '.gemini/antigravity-ide']
    : ['devin', 'devin/cli', 'devin/summaries', 'devin/transcripts'];
  for (const relative of directories) {
    const dir = path.join(stateHome, relative);
    if (fs.lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error('Provider session entry must not be a symlink');
    }
    ensurePrivateDirectory(dir);
  }
  const spec = MANAGED_PROVIDER_SPECS[kind];
  const sharedFiles: string[] = [];
  // Explicit file allowlist: never project a native conversation directory.
  const shared = [spec.authRelativePath, ...(spec.authCandidates ?? []), ...(spec.identityCandidates ?? [])];
  if (kind === 'agy') shared.push('settings.json', 'antigravity-cli/settings.json', 'antigravity-cli/mcp_config.json', 'config/mcp_config.json');
  for (const relative of shared) {
    const source = path.join(sourceHome, relative);
    if (!exists(source)) continue;
    if (!fs.statSync(source).isFile()) throw new Error('Provider credential/config must be a file');
    const target = path.join(providerHome, relative);
    const entry = fs.lstatSync(target, { throwIfNoEntry: false });
    if (entry?.isSymbolicLink() && path.toNamespacedPath(path.resolve(path.dirname(target), fs.readlinkSync(target))) !== path.toNamespacedPath(source)) {
      throw new Error('Provider credential link points outside its auth source');
    }
    // Windows file links/copies (and atomic replacements) must not retain the
    // credential of an earlier materialization when the account source changes.
    if (entry && !entry.isSymbolicLink()) {
      if (!entry.isFile()) throw new Error('Provider credential/config target must be a file');
      fs.unlinkSync(target);
    }
    if (!entry || !entry.isSymbolicLink()) linkFile(source, target);
    sharedFiles.push(fs.realpathSync(source));
  }
  const sharedReadPaths: string[] = [];
  if (kind === 'agy') {
    // Skill mirroring may populate these AFTER this helper, during MCP decoration.
    // Directory links may start dangling; conversations never use these links.
    for (const relative of ['config/skills', 'antigravity/skills', 'antigravity-cli/skills', 'antigravity-ide/skills']) {
      const source = path.join(sourceHome, relative);
      const target = path.join(providerHome, relative);
      const entry = fs.lstatSync(target, { throwIfNoEntry: false });
      if (!entry) fs.symlinkSync(source, target, 'junction');
      else if (!entry.isSymbolicLink() || path.toNamespacedPath(path.resolve(path.dirname(target), fs.readlinkSync(target))) !== path.toNamespacedPath(source)) {
        throw new Error('AGY skill link points outside its profile source');
      }
      sharedReadPaths.push(source);
    }
  }
  return { stateHome, env, sharedFiles, sharedReadPaths };
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
  const candidatePaths = [...new Set([
    spec.authRelativePath,
    ...(spec.authCandidates ?? []),
  ])].map((rel) => path.join(systemHome, rel));
  // Kimi oauth path may be a file without extension.
  for (const candidate of candidatePaths) {
    if (!exists(candidate)) continue;
    let blob: string | null = null;
    try {
      blob = fs.statSync(candidate).isDirectory()
        ? snapshotDirectoryAuth(candidate)
        : readText(candidate);
    } catch {
      continue;
    }
    let authRelativePath = path.relative(systemHome, candidate);
    if (
      blob &&
      adapterId === 'agy' &&
      authRelativePath !== spec.authRelativePath
    ) {
      const parsed = parsedAuthBlob(blob);
      const token = parsed?.token;
      if (token && typeof token === 'object' && !Array.isArray(token)) {
        // AGY 1.1's CLI-specific file wraps the same OAuth token object that
        // the portable GEMINI_CLI_HOME route reads from oauth_creds.json.
        blob = JSON.stringify(token);
        authRelativePath = spec.authRelativePath;
      }
    }
    if (!blob || !authBlobIsUsable(adapterId, blob)) continue;
    let identity = identityFromAuthBlob(adapterId, blob);
    if (!identity.email) {
      for (const relative of spec.identityCandidates ?? []) {
        const supplemental = readText(path.join(systemHome, relative));
        if (!supplemental) continue;
        const found = identityFromAuthBlob(adapterId, supplemental);
        if (found.email || found.subject) {
          identity = {
            email: found.email,
            subject: identity.subject ?? found.subject,
          };
          break;
        }
      }
    }
    return {
      blob,
      email: identity.email,
      authRelativePath,
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
    // OpenCode's Windows checkout homes share this inode so refreshes remain
    // live. Clear it before unlinking, or a durable hardlink retains the secret.
    if (adapterId === 'opencode' && process.platform === 'win32') {
      fs.truncateSync(authPath, 0);
    }
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

/**
 * Identity-only view of the NATIVE session. Capture is bounded and stays in
 * memory; the renderer receives only a real email claim (when present) and a
 * one-way fingerprint. Claude is Keychain-backed and uses its own path.
 */
export function nativeAuthIdentity(
  adapterId: string,
  home = os.homedir(),
): { email?: string; fingerprint?: string } {
  const capture = captureNativeAuth(adapterId, home);
  if (!capture) return {};
  const parsedIdentity = identityFromAuthBlob(adapterId, capture.blob);
  const identity: ManagedAuthIdentity = {
    ...parsedIdentity,
    ...(capture.email ? { email: capture.email } : {}),
  };
  const fingerprint = authFingerprint(adapterId, capture.blob, identity);
  return {
    ...(identity.email ? { email: identity.email } : {}),
    ...(fingerprint ? { fingerprint } : {}),
  };
}
