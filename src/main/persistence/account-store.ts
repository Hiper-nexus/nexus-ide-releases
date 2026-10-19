import { runPeriodicTask, stopPeriodicTask } from '../observability/periodic-task';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Db } from './db';
import type { Account, AccountInfo, AccountMode } from '../../shared/account-types';
import {
  deleteSecret,
  getSecret,
  hasCachedSecret,
  hasSecret,
  setSecret,
} from './secrets-store';
import {
  activeClaudeEmail,
  CLAUDE_KEYCHAIN_SERVICE,
  claudeCredentialBlobIsUsable,
  invalidateClaudeCredentialCache,
  readActiveClaudeCredential,
  readActiveClaudeCredentialSlim,
  slimClaudeCredentialBlob,
} from '../adapters/claude-credential';
import { rememberNativeOAuthCredential } from '../adapters/native-oauth-keychain';
import {
  claudeBlobIsExpiredUnhealable,
  claudeBlobNeedsRefresh,
  forceRefreshClaudeOauthBlob,
  refreshClaudeOauthBlob,
} from '../quota/claude-oauth-refresh';
import {
  agyWindowsUnreadableSessionReason,
  authBlobIsUsable,
  captureNativeAuth,
  supportsNativeSessionSnapshot,
  compareAuthBlobIdentity,
  identityFromAuthBlob,
  isFileAuthAdapter,
  MANAGED_PROVIDER_SPECS,
  managedHomeEnv,
  materializeManagedHome,
  readBackFresherAuth,
  removeManagedHome,
  setManagedAuthPersister,
  type FileAuthAdapterId,
} from '../adapters/managed-credentials';
import { compareAuthFreshness } from '../adapters/auth-freshness';
import { readRegularFileCapped } from '../redline/redline-safe-read';
import { chooseAccount } from './account-select';
import { fullWindowsReopenAt, type HeadroomInput } from '../quota/account-headroom';
import { initFailoverWaits } from './failover-waits';
import {
  deleteAgyWindowsKeyringBlob,
  invalidateAgyWindowsKeyringCache,
  isAgyKeyringBlob,
  readAgyWindowsKeyringBlob,
  writeAgyWindowsKeyringBlob,
} from '../adapters/agy-windows-keyring';
import { resetAgyKeychainCache } from '../adapters/subscription-auth';
import { accountCredentialCandidates } from '../adapters/account-credential-candidates';
import {
  freshestClaudeCredential,
  hasManagedClaudeAuth,
  managedClaudeAuthDirectory,
  managedClaudeAuthHasCredential,
  materializeManagedClaudeAuth,
  readManagedClaudeAuthAsync,
  removeManagedClaudeAuth,
} from '../adapters/managed-claude-auth';
import { probeClaudeCredentialIdentity, resolveClaudeCredentialProfile } from '../quota/claude-native-account';
import { managedClaudeCliEnv, probeClaudeCliUsage } from '../quota/claude-oauth-usage';
import {
  failedPersistenceError,
  PersistenceUnavailableError,
  readOnlyPersistenceError,
} from './persistence-error';

/**
 * Account registry with per-adapter active selection and failover-aware
 * pick-next. Metadata lives in SQLite; secrets (api keys, Claude credential
 * blobs) live in the encrypted vault keyed by account id. The in-memory maps
 * are read caches and only change after the SQLite mutation succeeds.
 */

const KEY_PREFIX = 'acctkey:'; // api-key accounts
const CRED_PREFIX = 'acctcred:'; // subscription credential blobs

// Derived from can1357/oh-my-pi@03c48d073 auth-storage cooldown machine (MIT):
// blocos de cooldown por (conta, escopo). Escopo '' bloqueia a conta inteira
// (comportamento legado, espelhado em accounts.cooldown_until); escopo
// 'tier:<família>' bloqueia só spawns daquele tier. probeAfter permite UMA
// sondagem controlada por janela em blocos longos (quota 12h) quando não há
// alternativa livre — "um request na mão vale mais que key nenhuma".

/** Escopo vazio = bloco global da conta (compatível com cooldownUntil). */
const GLOBAL_SCOPE = '';
/** Janela máxima até a primeira sondagem permitida (min com blockedUntil). */
const PROBE_AFTER_MAX_MS = 30 * 60 * 1000;

export interface CooldownBlock {
  blockedUntil: number;
  reason: string;
  /** Instante a partir do qual uma sondagem last-resort é permitida. */
  probeAfter: number;
  /** Sondagem já consumida nesta janela (uma por janela de probe). */
  probedAt?: number;
}

const accounts = new Map<string, Account>();
const activeByAdapter = new Map<string, string>();
/** accountId → (blockScope → bloco). Cache de leitura do SQLite. */
const cooldownBlocks = new Map<string, Map<string, CooldownBlock>>();
let db: Db | null = null;
let readOnly = true;
let counter = 0;
const listeners = new Set<() => void>();

function replaceMap<K, V>(target: Map<K, V>, next: ReadonlyMap<K, V>): void {
  target.clear();
  for (const [key, value] of next) target.set(key, value);
}

function requireWritableDb(): Db {
  if (!db || readOnly) throw readOnlyPersistenceError('account');
  return db;
}

function failPersistence(operation: string, error: unknown): never {
  readOnly = true;
  db = null;
  throw failedPersistenceError('account', operation, error);
}

export function isAccountStoreReadOnly(): boolean {
  return readOnly;
}

function makeId(): string {
  return `acct-${Date.now().toString(36)}-${(++counter).toString(36)}`;
}

export function onAccountsChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function emit(): void {
  for (const cb of [...listeners]) {
    try {
      cb();
    } catch (err) {
      console.warn('[accounts] listener threw:', err);
    }
  }
}

interface Row {
  id: string;
  adapter_id: string;
  label: string;
  mode: string;
  upstream: string;
  email: string | null;
  cooldown_until: number | null;
  last_error: string | null;
  active: number;
  created_at: number;
}

interface CooldownBlockRow {
  account_id: string;
  block_scope: string;
  blocked_until: number;
  reason: string;
  probe_after: number;
  probed_at: number | null;
}

/**
 * DDL defensivo: o schema canônico vive em db.ts, mas o store também roda
 * sobre DBs de teste/legados sem a tabela — CREATE IF NOT EXISTS é o padrão
 * de migração aditiva do repo (roda em todo open, idempotente).
 */
const COOLDOWN_BLOCKS_DDL = `
CREATE TABLE IF NOT EXISTS account_cooldown_blocks (
  account_id    TEXT NOT NULL,
  block_scope   TEXT NOT NULL DEFAULT '',
  blocked_until INTEGER NOT NULL,
  reason        TEXT NOT NULL DEFAULT '',
  probe_after   INTEGER NOT NULL,
  probed_at     INTEGER,
  PRIMARY KEY (account_id, block_scope)
);`;

/**
 * Read-back do token renovado pelo CLI para o vault, chamado pelo scrub de
 * sessão gerenciada (M1) ANTES de apagar o auth.json. Se o CLI rotacionou o
 * refresh token durante a sessão, o arquivo no disco é mais fresco que o
 * snapshot do vault — sem este read-back o scrub destruiria a única cópia viva
 * e a conta seria forçada a relogar. Best-effort: nunca lança.
 */
function persistFresherManagedAuth(
  adapterId: FileAuthAdapterId,
  accountId: string,
): void {
  const blob = getSecret(CRED_PREFIX + accountId);
  if (!blob) return;
  const fresher = readBackFresherAuth(adapterId, accountId, blob);
  if (fresher) setSecret(CRED_PREFIX + accountId, fresher);
}

export function initAccountStore(database: Db | null): void {
  db = database;
  readOnly = true;
  // F-1483: as esperas do failover moram no mesmo DB dos blocos de cooldown.
  initFailoverWaits(database);
  // Registra o read-back de tokens renovados para o scrub de sessão gerenciada
  // (M1): antes de apagar o auth.json no exit, o vault recebe o token fresco.
  setManagedAuthPersister(persistFresherManagedAuth);
  if (!database) return;

  const hydratedAccounts = new Map<string, Account>();
  const hydratedActive = new Map<string, string>();
  const hydratedBlocks = new Map<string, Map<string, CooldownBlock>>();
  try {
    for (const row of database.prepare('SELECT * FROM accounts').all() as Row[]) {
      const account: Account = {
        id: row.id,
        adapterId: row.adapter_id,
        label: row.label,
        mode: row.mode as AccountMode,
        upstream: row.upstream,
        email: row.email ?? undefined,
        cooldownUntil: row.cooldown_until ?? undefined,
        lastError: row.last_error ?? undefined,
        createdAt: row.created_at,
      };
      hydratedAccounts.set(row.id, account);
      if (row.active === 1) hydratedActive.set(account.adapterId, account.id);
    }
    database.exec(COOLDOWN_BLOCKS_DDL);
    const blockRows = database
      .prepare('SELECT * FROM account_cooldown_blocks')
      .all() as CooldownBlockRow[];
    for (const row of blockRows) {
      const byScope =
        hydratedBlocks.get(row.account_id) ?? new Map<string, CooldownBlock>();
      byScope.set(row.block_scope, {
        blockedUntil: row.blocked_until,
        reason: row.reason,
        probeAfter: row.probe_after,
        probedAt: row.probed_at ?? undefined,
      });
      hydratedBlocks.set(row.account_id, byScope);
    }
  } catch (error) {
    console.warn('[accounts] failed to hydrate; using read-only cache:', error);
    db = null;
    return;
  }

  replaceMap(accounts, hydratedAccounts);
  replaceMap(activeByAdapter, hydratedActive);
  replaceMap(cooldownBlocks, hydratedBlocks);
  readOnly = false;
}

function writeAccount(database: Db, account: Account, active: boolean): void {
  database.prepare(
    `INSERT OR REPLACE INTO accounts
       (id, adapter_id, label, mode, upstream, email, cooldown_until,
        last_error, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    account.id,
    account.adapterId,
    account.label,
    account.mode,
    account.upstream,
    account.email ?? null,
    account.cooldownUntil ?? null,
    account.lastError ?? null,
    active ? 1 : 0,
    account.createdAt,
  );
}

function persistSnapshot(
  nextAccounts: ReadonlyMap<string, Account>,
  nextActive: ReadonlyMap<string, string>,
  operation: string,
): void {
  const database = requireWritableDb();
  try {
    database.exec('BEGIN IMMEDIATE');
    for (const account of nextAccounts.values()) {
      writeAccount(
        database,
        account,
        nextActive.get(account.adapterId) === account.id,
      );
    }
    database.exec('COMMIT');
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // The original persistence failure remains authoritative.
    }
    failPersistence(operation, error);
  }
}

export function listAccounts(adapterId?: string): Account[] {
  const all = [...accounts.values()].sort((a, b) => a.createdAt - b.createdAt);
  return adapterId ? all.filter((a) => a.adapterId === adapterId) : all;
}

export function getActiveAccount(adapterId: string): Account | null {
  const id = activeByAdapter.get(adapterId);
  if (id) return accounts.get(id) ?? null;
  // No explicit active → the first non-cooldown account, if any.
  return pickAvailable(adapterId, null);
}

export function getAccount(id: string): Account | null {
  return accounts.get(id) ?? null;
}

/** Secret material for a spawn: api-key accounts → the key; subscription →
 *  restore its credential blob into the Claude keychain (side effect). */
export function accountKey(account: Account): string | null {
  if (account.mode === 'api-key') return getSecret(KEY_PREFIX + account.id);
  return null;
}

/** A saved token identifies its owner more reliably than ~/.claude.json metadata. */
function claudeCredentialOwner(blob: string | null): Account | null {
  if (!blob) return null;
  let native: ClaudeOauthCredential | undefined;
  try {
    native = JSON.parse(blob)?.claudeAiOauth;
  } catch {
    return null;
  }
  if (!native) return null;
  for (const account of listAccounts('claude')) {
    if (account.mode !== 'subscription') continue;
    const saved = getSecret(CRED_PREFIX + account.id);
    if (!saved) continue;
    try {
      const stored = JSON.parse(saved)?.claudeAiOauth;
      if ((['accessToken', 'refreshToken'] as const).some((key) => {
        const token = native?.[key];
        return typeof token === 'string' && token.length > 0 && stored?.[key] === token;
      })) return account;
    } catch {
      // An unreadable snapshot cannot establish ownership of another login.
    }
  }
  return null;
}

function nativeClaudeAccount(blob: string | null, email: string | null): Account | null {
  const owner = claudeCredentialOwner(blob);
  if (owner) return owner;
  // A full native rotation can change both opaque tokens. Preserve the existing
  // email-based read-back only when no saved session contradicts that identity.
  return email ? listAccounts('claude').find((account) =>
    account.mode === 'subscription' && account.email && emailsEqual(account.email, email),
  ) ?? null : null;
}

interface NativeClaudeSnapshot {
  blob: string | null;
  account: Account | null;
}

/** Share one native snapshot across an operation instead of probing per account. */
function readNativeClaudeSnapshot(): NativeClaudeSnapshot {
  const blob = readActiveClaudeCredentialSlim() ?? (() => {
    const raw = readActiveClaudeCredential();
    return raw ? slimClaudeCredentialBlob(raw) : null;
  })();
  // Identidade ilegível (`undefined`): só o dono do token decide, sem e-mail.
  return { blob, account: nativeClaudeAccount(blob, activeClaudeEmail() ?? null) };
}

function persistManagedClaudeReadback(account: Account, renewed: string | null): string | null {
  const saved = getSecret(CRED_PREFIX + account.id);
  if (isClaudeIdentityMismatch(account)) return saved;
  if (saved === null && hasSecret(CRED_PREFIX + account.id)) return null;
  const latest = freshestClaudeCredential(renewed, saved);
  if (latest && latest !== saved) {
    const result = setSecret(CRED_PREFIX + account.id, latest);
    if (result.ok) settleRenewedClaudeCredential(account.id);
  }
  return latest;
}

function claudeRefreshToken(blob: string | null): string | null {
  try {
    const token = blob ? JSON.parse(blob)?.claudeAiOauth?.refreshToken : null;
    return typeof token === 'string' && token ? token : null;
  } catch {
    return null;
  }
}

/**
 * Outra cópia conhecida da mesma linhagem: o login nativo ou outra linha do
 * cofre. Rotacionar um token sem prova prévia de identidade consumiria a
 * sessão da irmã que o carrega (F-615) — só a linhagem exclusiva renova.
 */
function claudeLineageSharedElsewhere(accountId: string, blob: string): boolean {
  const refreshToken = claudeRefreshToken(blob);
  if (!refreshToken) return true;
  if (claudeRefreshToken(readNativeClaudeSnapshot().blob) === refreshToken) return true;
  // ponytail: escopos gerenciados das irmãs espelham o cofre delas (read-back
  // provado); comparar o cofre evita ler N Keychains a cada renovação.
  return listAccounts('claude').some((other) => other.id !== accountId &&
    claudeRefreshToken(getSecret(CRED_PREFIX + other.id)) === refreshToken);
}

/**
 * O escopo gerenciado não carrega a linhagem do cofre: está vazio, ou guarda
 * OUTRA, mais velha (re-login/preservação que não chegou a ele). A CLI desse
 * escopo nunca renovará o cofre. Mesma linhagem continua sendo só da CLI.
 * Limite: com o Keychain do escopo negado e um arquivo antigo, a comparação vê
 * o arquivo; a materialização seguinte falha fechada até o Keychain abrir e
 * então semeia o escopo com o cofre renovado (mais fresco).
 */
function managedScopeLacksVaultLineage(
  accountId: string,
  scoped: string | null,
  vault: string | null,
): boolean {
  const vaultRefresh = claudeRefreshToken(vault);
  if (!vault || !vaultRefresh) return false;
  if (!scoped) return !managedClaudeAuthHasCredential(accountId);
  return claudeRefreshToken(scoped) !== vaultRefresh &&
    freshestClaudeCredential(scoped, vault) === slimClaudeCredentialBlob(vault);
}

/**
 * Materialize a subscription credential for the active/global path.
 * Claude → Keychain; file-backed providers → managed home under ~/.nexus.
 */
export function ensureSubscriptionActive(account: Account): boolean {
  if (account.mode !== 'subscription') return true;
  // Claude activation requires an async provider-profile proof. The pane
  // paths use prepareProviderSpawnAuthoritative; do not copy an unverified
  // vault snapshot into the operator's native Keychain here.
  if (account.adapterId === 'claude') return false;
  const blob = getSecret(CRED_PREFIX + account.id);
  if (!blob) return false;
  if (isFileAuthAdapter(account.adapterId)) {
    try {
      materializeManagedHome(
        account.adapterId as FileAuthAdapterId,
        account.id,
        blob,
      );
      if (
        account.adapterId === 'agy' &&
        process.platform === 'win32' &&
        !process.env.VITEST &&
        isAgyKeyringBlob(blob)
      ) {
        const currentSlot = readAgyWindowsKeyringBlob({ fresh: true });
        if (currentSlot && currentSlot !== blob) {
          preserveAgyKeyringSession(currentSlot);
        }
        if (currentSlot !== blob) {
          writeAgyWindowsKeyringBlob(blob);
        }
      }
      return true;
    } catch (err) {
      console.warn('[accounts] materialize managed home failed:', err);
      return false;
    }
  }
  return false;
}

/** Process-scoped env for a file-backed subscription account (CODEX_HOME…). */
export function fileSubscriptionAuthEnv(
  account: Account,
): Record<string, string> | null {
  if (account.mode !== 'subscription' || !isFileAuthAdapter(account.adapterId)) {
    return null;
  }
  let blob = getSecret(CRED_PREFIX + account.id);
  if (!blob) return null;
  try {
    const adapterId = account.adapterId as FileAuthAdapterId;
    // Read-back also follows a native re-login, but only for this identity.
    const fresher = accountCredentialCandidates(adapterId, account.id, blob)[0];
    if (fresher && fresher !== blob) {
      const saved = setSecret(CRED_PREFIX + account.id, fresher);
      if (!saved.ok) return null;
      blob = fresher;
    }
    const home = materializeManagedHome(adapterId, account.id, blob);
    return managedHomeEnv(adapterId, home);
  } catch (err) {
    console.warn('[accounts] file subscription env failed:', err);
    return null;
  }
}

export type AccountSpawnPreparation =
  | {
      ok: true;
      account: Account;
      apiKey: string | null;
      authEnv: Record<string, string>;
    }
  | { ok: false; error: string };

/** One CLI run in the account's managed scope; the CLI refreshes under its own lock. */
async function renewManagedClaudeAuthThroughCli(accountId: string): Promise<string | null> {
  try {
    await probeClaudeCliUsage({ env: managedClaudeCliEnv(managedClaudeAuthDirectory(accountId)) });
    return await readManagedClaudeAuthAsync(accountId, { fresh: true });
  } catch {
    return null;
  }
}

/** Same, for the native store — only while that store still belongs to the account. */
async function renewNativeClaudeAuthThroughCli(accountId: string): Promise<string | null> {
  try {
    await probeClaudeCliUsage();
    invalidateClaudeCredentialCache();
    const native = readNativeClaudeSnapshot();
    return native.account?.id === accountId ? native.blob : null;
  } catch {
    return null;
  }
}

/**
 * F-645: a conta é o login nativo agora? Então a linhagem dela tem um dono
 * só — o store nativo da CLI — e o pane usa esse store. Semear um escopo
 * gerenciado com o mesmo refresh token cria duas cópias: quem renova primeiro
 * invalida a outra (o escopo morto, ou o login nativo no meio da sessão).
 */
export function claudeAccountIsNativeLogin(
  account: Account,
  snapshot: NativeClaudeSnapshot = readNativeClaudeSnapshot(),
): boolean {
  if (account.adapterId !== 'claude' || account.mode !== 'subscription') return false;
  // Mesma regra do read-back: o dono do token vence um e-mail antigo no
  // ~/.claude.json; sem token legível, vale o e-mail (e nada é semeado).
  return snapshot.account?.id === account.id;
}

/** Validate the same scoped credential the CLI will read before a managed Claude spawn. */
export async function verifyManagedClaudeAccountForSpawn(
  accountId: string,
  onVerified?: (blob: string) => void,
): Promise<'match' | 'mismatch' | 'auth-expired' | 'unavailable'> {
  const account = getAccount(accountId);
  if (!account || account.adapterId !== 'claude' || account.mode !== 'subscription') {
    return 'unavailable';
  }
  // F-645: a conta que É o login nativo abre pelo store nativo, então é ele
  // que se prova — um escopo gerenciado antigo dela é cópia morta da linhagem.
  const native = readNativeClaudeSnapshot();
  const nativeLogin = claudeAccountIsNativeLogin(account, native);
  const managed = !nativeLogin && hasManagedClaudeAuth(accountId);
  const scoped = managed ? await readManagedClaudeAuthAsync(accountId) : null;
  // With no managed store, prepareAccountForSpawn imports a newer native
  // Keychain lineage for this account. Verify that exact candidate as well.
  const nativeBlob = !managed && native.account?.id === accountId ? native.blob : null;
  // Store nativo ilegível (Keychain travado) não é sessão expirada.
  if (nativeLogin && !nativeBlob) return 'unavailable';
  const originalSaved = getSecret(CRED_PREFIX + accountId);
  let credential = nativeLogin
    ? nativeBlob
    : freshestClaudeCredential(scoped, nativeBlob, originalSaved);
  let result = await probeClaudeCredentialIdentity(credential, account.email);
  if (result === 'auth-expired' && (managed || nativeLogin) && credential &&
      claudeBlobNeedsRefresh(credential, Date.now())) {
    // F-639: access token vencido com refresh token não é sessão perdida. A
    // CLI é dona da renovação (.oauth_refresh.lock): um run dela no store que
    // o pane vai usar renova, e a identidade é provada de novo sobre o token
    // novo. "Entre novamente" só quando nem a própria CLI conseguiu.
    const renewed = nativeLogin
      ? await renewNativeClaudeAuthThroughCli(accountId)
      : await renewManagedClaudeAuthThroughCli(accountId);
    if (renewed && renewed !== credential) {
      credential = nativeLogin ? renewed : freshestClaudeCredential(renewed, originalSaved);
      result = await probeClaudeCredentialIdentity(credential, account.email);
    }
  }
  if (result === 'match' && (!sameClaudeAccountIdentity(account) ||
      getSecret(CRED_PREFIX + accountId) !== originalSaved)) return 'unavailable';
  if (result === 'mismatch') {
    markClaudeIdentityMismatch(accountId, 'pane Claude');
  }
  if (result === 'match' && credential && !managed && nativeBlob === credential &&
      credential !== originalSaved) {
    // Only a live server profile may bind a rotated native credential to a
    // vault row. A decrypt-denied existing secret is not safe to overwrite.
    if (originalSaved === null && hasSecret(CRED_PREFIX + accountId)) return 'unavailable';
    if (!setSecret(CRED_PREFIX + accountId, credential).ok) return 'unavailable';
  }
  if (result === 'match' && credential) {
    onVerified?.(credential);
  } else if (result === 'match') {
    return 'unavailable';
  }
  return result;
}

interface ClaudeOauthCredential {
  accessToken?: unknown;
  refreshToken?: unknown;
  scopes?: unknown;
}

/**
 * Convert a saved Claude subscription snapshot into process-scoped auth.
 * `CLAUDE_CODE_OAUTH_TOKEN` has higher precedence than the global login
 * Keychain item, so concurrent panes can use different accounts safely.
 */
function subscriptionAuthEnv(
  account: Account,
): Record<string, string> | null {
  const blob = getSecret(CRED_PREFIX + account.id);
  if (!blob) return null;
  if (account.adapterId === 'claude' && hasManagedClaudeAuth(account.id)) {
    void readManagedClaudeAuthAsync(account.id).then((renewed) => {
      return probeClaudeCredentialIdentity(renewed, account.email).then((identity) => {
        // A re-login/removal while the read was in flight owns the newer state.
        if (identity === 'match' && getAccount(account.id) === account &&
            getSecret(CRED_PREFIX + account.id) === blob) {
          persistManagedClaudeReadback(account, renewed);
        }
      });
    }).catch(() => {});
  }
  return claudeAuthEnvFromBlob(blob as string);
}

function claudeAuthEnvFromBlob(blob: string): Record<string, string> | null {
  try {
    const parsed = JSON.parse(blob) as { claudeAiOauth?: ClaudeOauthCredential };
    const oauth = parsed.claudeAiOauth;
    if (typeof oauth?.accessToken !== 'string' || oauth.accessToken.length === 0) {
      return null;
    }
    const env: Record<string, string> = {
      CLAUDE_CODE_OAUTH_TOKEN: oauth.accessToken,
    };
    // NO CLAUDE_CODE_OAUTH_REFRESH_TOKEN on purpose: a pinned pane must never
    // rotate the lineage itself. With the native CLI, the freshness sweeper
    // AND the pane all able to refresh, the rotation-race loser ends with a
    // consumed refresh token ("401 Invalid authentication credentials") — the
    // third actor in the mid-session logout production bug. Recovery contract
    // when this access token expires: the pane 401s → limit-detector applies
    // the auth-kind cooldown ('auth', 15min — src/main/orch/limit-detector.ts
    // patterns at :167-176) → failover respawn re-runs prepareAccountForSpawn
    // (src/main/orch/failover.ts:341), which re-materializes a FRESH env from
    // the vault — kept renewed by the sweeper for secondary accounts and by
    // the keychain read-back for the native one. Verified against those
    // files; no new machinery needed.
    if (Array.isArray(oauth.scopes)) {
      const scopes = oauth.scopes.filter(
        (scope): scope is string => typeof scope === 'string' && scope.length > 0,
      );
      if (scopes.length > 0) env.CLAUDE_CODE_OAUTH_SCOPES = scopes.join(' ');
    } else if (typeof oauth.scopes === 'string' && oauth.scopes.trim()) {
      env.CLAUDE_CODE_OAUTH_SCOPES = oauth.scopes.trim();
    }
    return env;
  } catch {
    return null;
  }
}

/**
 * Process-scoped auth for the Claude session that is already active locally.
 * Required when Nexus gives a gated worker an isolated HOME: current Claude
 * builds do not consider the login active there even though macOS Keychain is
 * user-scoped. The token stays in the child process environment only.
 */
export function activeClaudeAuthEnv(): Record<string, string> | null {
  // Prefer slim keychain read so vault/env never depend on mcpOAuth bulk.
  let blob =
    readActiveClaudeCredentialSlim() ?? readActiveClaudeCredential();
  if (!blob || !claudeCredentialBlobIsUsable(blob)) {
    try {
      blob = fs.readFileSync(
        path.join(os.homedir(), '.claude', '.credentials.json'),
        'utf8',
      );
    } catch {
      return null;
    }
  }
  if (!claudeCredentialBlobIsUsable(blob)) return null;
  return claudeAuthEnvFromBlob(blob);
}

/**
 * Claude Code OAuth access token for quota probes.
 * - with accountId: vault subscription blob for that account
 * - without: currently signed-in Claude (keychain / ~/.claude credentials)
 * Never logs the token. Returns null when unavailable.
 */
export function claudeOAuthAccessToken(accountId?: string): string | null {
  if (accountId) {
    const account = getAccount(accountId);
    if (!account || account.adapterId !== 'claude') return null;
    const env = subscriptionAuthEnv(account);
    const token = env?.CLAUDE_CODE_OAUTH_TOKEN;
    return typeof token === 'string' && token.length > 0 ? token : null;
  }
  const env = activeClaudeAuthEnv();
  const token = env?.CLAUDE_CODE_OAUTH_TOKEN;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

/**
 * Auth cooldown excludes the dead credential from AUTOMATIC failover pick.
 * An operator who pins the account on a new pane (or re-logs in) must still
 * be able to spawn — 15 min of "cooling down" blocked the only recovery
 * they had after the 401 storm.
 */
export function isAuthCooldownReason(reason: string | undefined): boolean {
  if (!reason) return false;
  return /401|identity mismatch|oauth token (?:expired|revoked)|oauth access token has expired|not logged in|session expired|refresh token (?:expired|invalid|revoked)|authentication[_\s]?error|re-authenticate|please run \/login|invalid[_\s]?(?:api[_\s]?key|x-api-key)|stored token for|token inv[aá]lido|n[aã]o autenticado/i.test(
    reason,
  );
}

function isClaudeIdentityMismatch(account: Account): boolean {
  return account.adapterId === 'claude' && account.mode === 'subscription' &&
    /oauth identity mismatch/i.test(account.lastError ?? '');
}

function markClaudeIdentityMismatch(accountId: string, source: string): void {
  try {
    setCooldown(accountId, Date.now() + 12 * 60 * 60 * 1000, `oauth identity mismatch — ${source}`);
  } catch {
    // A failed metadata write must not turn a rejected credential into one
    // accepted by the current operation.
  }
}

function emailsEqual(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function sameClaudeAccountIdentity(account: Account): boolean {
  const current = getAccount(account.id);
  return Boolean(current && current.adapterId === 'claude' &&
    current.mode === 'subscription' &&
    emailsEqual(current.email ?? '', account.email ?? ''));
}

/**
 * Automatic failover may only pin an account that can actually spawn.
 * A Settings row without vault/Keychain material used to win chooseAccount
 * (it is often the "active" husk) and then prepare failed → toast
 * "nenhuma credencial alternativa" while a ready sibling sat unused.
 */
export function accountHasFailoverCredential(account: Account): boolean {
  if (isClaudeIdentityMismatch(account)) return false;
  if (account.mode === 'api-key') {
    return hasSecret(KEY_PREFIX + account.id);
  }
  if (hasSecret(CRED_PREFIX + account.id)) {
    // Blob Claude vencido sem refresh token: o pick pula a conta em vez de
    // queimar a tentativa de failover num 401 garantido (F-511). Sem
    // expiresAt confiável não há juízo — presença continua valendo.
    if (account.adapterId === 'claude' && account.mode === 'subscription') {
      const blob = getSecret(CRED_PREFIX + account.id);
      const now = Date.now();
      if (
        typeof blob === 'string' &&
        claudeBlobIsExpiredUnhealable(blob, now)
      ) {
        return false;
      }
      const nativeEmail = activeClaudeEmail();
      const isNative = Boolean(
        nativeEmail && account.email && emailsEqual(account.email, nativeEmail),
      );
      if (!isNative && hasRecentClaudeRefreshFailure(account.id, now)) {
        return false;
      }
    }
    return true;
  }
  if (account.adapterId === 'claude' && account.email) {
    const nativeEmail = activeClaudeEmail();
    return Boolean(nativeEmail && emailsEqual(account.email, nativeEmail));
  }
  return false;
}

/**
 * Resolve and activate the exact account pinned to a pane before its PTY is
 * created. This deliberately does not fall back to the provider's active
 * account: a pinned account is an isolation boundary, not a preference hint.
 *
 * `allowCoolingProbe`: sondagem last-resort do failover — a conta ainda está
 * em cooldown, mas o pool inteiro está bloqueado e a janela de probe venceu.
 */
export function prepareAccountForSpawn(
  adapterId: string,
  accountId: string,
  now = Date.now(),
  options?: { allowCoolingProbe?: boolean; isolatedHome?: boolean; expectedClaudeBlob?: string },
): AccountSpawnPreparation {
  const account = getAccount(accountId);
  if (!account || account.adapterId !== adapterId) {
    return {
      ok: false,
      error: 'selected account does not belong to this provider',
    };
  }
  if (isClaudeIdentityMismatch(account)) {
    return {
      ok: false,
      error: `A credencial de “${account.label}” pertence a outra conta Claude — entre novamente antes de abrir um pane.`,
    };
  }

  if (
    !options?.allowCoolingProbe &&
    account.cooldownUntil &&
    account.cooldownUntil > now &&
    !isAuthCooldownReason(account.lastError)
  ) {
    return {
      ok: false,
      error: `selected account "${account.label}" is cooling down`,
    };
  }

  if (account.mode === 'api-key') {
    const apiKey = accountKey(account);
    if (!apiKey) {
      return {
        ok: false,
        error: `selected account "${account.label}" has no stored API credential`,
      };
    }
    return { ok: true, account, apiKey, authEnv: {} };
  }

  // File-backed providers (Codex/Grok/…): isolate via managed home env.
  if (isFileAuthAdapter(account.adapterId)) {
    const authEnv = fileSubscriptionAuthEnv(account);
    if (!authEnv) {
      return {
        ok: false,
        error: `selected subscription "${account.label}" has no usable managed credential`,
      };
    }
    return { ok: true, account, apiKey: null, authEnv };
  }

  // F-645: a conta que é o login nativo usa o store nativo, como um pane sem
  // conta — HOME real: `{}` (a CLI lê e renova a própria linhagem); HOME
  // isolado: só o access token por env, que não rotaciona nada. Nunca semeia
  // um escopo gerenciado com o refresh token do login nativo.
  if (claudeAccountIsNativeLogin(account)) {
    if (!options?.isolatedHome) return { ok: true, account, apiKey: null, authEnv: {} };
    const nativeEnv = activeClaudeAuthEnv();
    return nativeEnv
      ? { ok: true, account, apiKey: null, authEnv: nativeEnv }
      : {
          ok: false,
          error: 'não foi possível ler a credencial nativa do Claude para um pane com HOME isolado',
        };
  }

  // Managed Claude accounts use the CLI's renewable store, independent from
  // both the native login and the pane's disposable conversation HOME.
  // Renovação morta: trocar para esta conta é 401 garantido queimando uma
  // sessão nova — recusa aqui para o failover tentar a irmã ou esperar com
  // motivo acionável, em vez de descobrir no 401 do pane.
  if (hasRecentClaudeRefreshFailure(account.id, now)) {
    const vaultBlob = getSecret(CRED_PREFIX + account.id);
    if (
      typeof vaultBlob !== 'string' ||
      claudeBlobNeedsRefresh(vaultBlob, now) !== null ||
      claudeBlobIsExpiredUnhealable(vaultBlob, now)
    ) {
      return {
        ok: false,
        error:
          `conta "${account.label}" com renovação de token falhando — entre ` +
          'novamente em Configurações › Contas de IA',
      };
    }
  }
  // Token vencido sem refresh: o sweeper nunca tenta este blob
  // (`claudeBlobNeedsRefresh` exige refresh token) e nunca o sinaliza — sem
  // esta recusa, todo failover queimava uma sessão nova num 401 garantido
  // (F-511). Marca a falha para o veto valer aqui também.
  const vaultBlob = getSecret(CRED_PREFIX + account.id);
  if (
    typeof vaultBlob === 'string' &&
    claudeBlobIsExpiredUnhealable(vaultBlob, now)
  ) {
    markClaudeRefreshFailed(account);
    return {
      ok: false,
      error:
        `conta "${account.label}" com token expirado e sem renovação possível — entre ` +
        'novamente em Configurações › Contas de IA',
    };
  }
  const credential = getSecret(CRED_PREFIX + account.id);
  if (!credential) {
    return {
      ok: false,
      error: `selected subscription "${account.label}" has no usable OAuth credential`,
    };
  }
  try {
    const prepared = materializeManagedClaudeAuth(account.id, credential,
      options?.expectedClaudeBlob ? { expectedBlob: options.expectedClaudeBlob } : undefined);
    return { ok: true, account, apiKey: null, authEnv: prepared.env };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'failed to prepare isolated Claude account' };
  }
}

const claudeRefreshInFlight = new Set<string>();

/**
 * Última falha de renovação por conta (só tentativas reais, nunca skips).
 * Sem isto, uma secundária com refresh morto é escolhida de novo e de novo:
 * cada failover queima uma sessão nova num 401 garantido, e o operador só
 * descobre na hora do erro. Com o flag, o prepare recusa com motivo
 * acionável ("entre novamente") e o failover tenta a irmã ou espera.
 * Limpa no sucesso do refresh e no re-login (blob fresco do CLI vivo).
 */
const claudeRefreshFailedAt = new Map<string, number>();
/** Janela em que a falha de renovação veta a conta no failover/spawn (2 min para absorver glitches sem travar o operador por 1h). */
export const CLAUDE_REFRESH_FAILURE_SKIP_MS = 2 * 60 * 1000;

export function hasRecentClaudeRefreshFailure(
  accountId: string,
  now = Date.now(),
): boolean {
  const failedAt = claudeRefreshFailedAt.get(accountId);
  return (
    failedAt !== undefined && now - failedAt < CLAUDE_REFRESH_FAILURE_SKIP_MS
  );
}

/** Test seam + limpeza explícita. */
export function clearClaudeRefreshFailure(accountId: string): void {
  claudeRefreshFailedAt.delete(accountId);
}

/**
 * Marca a falha e avisa a UI — antes este caminho era `console.warn` puro e
 * o operador só descobria no próximo 401/spawn. O `emit` empurra o novo
 * `needsRelogin` pelo `onChanged` para Configurações aberto; só na transição
 * (sweeper de 15min + retries reinsistiriam no mesmo flag e spammariam).
 */
function markClaudeRefreshFailed(account: { id: string; label: string }): void {
  const already = hasRecentClaudeRefreshFailure(account.id);
  claudeRefreshFailedAt.set(account.id, Date.now());
  console.warn(
    '[accounts] claude oauth NÃO renovado para conta',
    account.label,
    '— entre novamente em Configurações › Contas de IA',
  );
  if (!already) emit();
}

/**
 * Credencial provada e gravada no cofre: a conta sai de «sessão expirada» já.
 * Cura silenciosa deixava o badge pendurado com Configurações aberto — emite
 * na transição da marca de renovação mesmo quando não havia cooldown vivo
 * (F-512). A expiração por TTL é preguiçosa: aparece no próximo emit.
 */
function settleRenewedClaudeCredential(accountId: string): void {
  const clearedRefreshFailure = claudeRefreshFailedAt.delete(accountId);
  let clearedCooldown = false;
  try {
    clearedCooldown = clearRefutedAuthCooldown(accountId, 'claude', 'credencial Claude renovada');
  } catch {
    // Metadado que não gravou não desfaz a credencial já salva.
  }
  if (!clearedCooldown && clearedRefreshFailure) emit();
}

/**
 * Renova o blob OAuth de uma conta Claude SECUNDÁRIA perto de expirar e grava
 * o resultado (refresh token rotacionado) de volta no vault. A conta que é o
 * login nativo do Keychain NUNCA é renovada por aqui — rotacionar a linhagem
 * compartilhada derrubaria a sessão do CLI real. Best-effort: nunca lança.
 */
export async function ensureFreshClaudeSubscription(
  accountId: string,
  now = Date.now(),
  refreshImpl?: (
    blob: string,
    now: number,
  ) => Promise<string | null>,
  options: { force?: boolean } = {},
): Promise<boolean> {
  const account = accounts.get(accountId);
  if (!account || account.adapterId !== 'claude') return false;
  if (hasManagedClaudeAuth(accountId)) {
    // The CLI owns its shared .oauth_refresh.lock. A second HTTP refresher here
    // would rotate the same token family independently and log panes out.
    const previous = getSecret(CRED_PREFIX + accountId);
    const latest = await readManagedClaudeAuthAsync(accountId);
    if (!sameClaudeAccountIdentity(account) || getSecret(CRED_PREFIX + accountId) !== previous) return false;
    const identity = await probeClaudeCredentialIdentity(latest, account.email, { now });
    if (identity === 'mismatch') {
      markClaudeIdentityMismatch(accountId, 'readback Claude');
      return false;
    }
    if (!sameClaudeAccountIdentity(account) || getSecret(CRED_PREFIX + accountId) !== previous) return false;
    if (identity === 'match') return persistManagedClaudeReadback(account, latest) !== previous;
    // Escopo vencido com OUTRA linhagem (ou nenhuma): a CLI dele não é dona da
    // linhagem do cofre, que segue para a renovação abaixo.
    if (identity !== 'auth-expired' || !managedScopeLacksVaultLineage(accountId, latest, previous)) return false;
  }
  const nativeEmail = activeClaudeEmail();
  // M1: o login nativo nunca é renovado por aqui. Sem conseguir ler quem é o
  // login nativo agora (~/.claude.json acima do teto, instável, ilegível), a
  // guarda fecha em vez de arriscar rotacionar a linhagem do operador.
  if (nativeEmail === undefined) return false;
  if (
    nativeEmail &&
    account.email &&
    nativeEmail.trim().toLowerCase() === account.email.trim().toLowerCase()
  ) {
    return false;
  }
  const blob = getSecret(CRED_PREFIX + accountId);
  if (typeof blob !== 'string' || !blob) return false;
  if (!options.force && !claudeBlobNeedsRefresh(blob, now)) return false;
  if (claudeRefreshInFlight.has(accountId)) return false;
  claudeRefreshInFlight.add(accountId);
  try {
    // Refresh rotates an opaque grant. Prove the current access token belongs
    // to this account before touching that grant. An expired access token
    // (Reserva after sleep or a closed app) can never be proven: it rotates
    // only when no other known store shares its lineage, and the new token
    // must still prove this account before it reaches the vault.
    const beforeIdentity = await probeClaudeCredentialIdentity(blob, account.email, { now });
    if (beforeIdentity === 'mismatch') {
      markClaudeIdentityMismatch(accountId, 'refresh Claude');
      return false;
    }
    const unproven = beforeIdentity === 'auth-expired';
    if ((beforeIdentity !== 'match' && !unproven) || !sameClaudeAccountIdentity(account) ||
        getSecret(CRED_PREFIX + accountId) !== blob) return false;
    if (unproven && claudeLineageSharedElsewhere(accountId, blob)) return false;
    const updateBlob =
      refreshImpl ??
      (options.force ? forceRefreshClaudeOauthBlob : refreshClaudeOauthBlob);
    const updated = await updateBlob(blob, now);
    if (!updated) {
      // Tentativa real falhou (rede ou refresh rotacionado/consumido): marca
      // para o failover não queimar sessões nesta conta, e avisa a UI.
      markClaudeRefreshFailed(account);
      return false;
    }
    const identity = await probeClaudeCredentialIdentity(updated, account.email, { now });
    if (identity === 'mismatch') {
      markClaudeIdentityMismatch(accountId, 'refresh Claude');
      return false;
    }
    if (identity !== 'match' || !sameClaudeAccountIdentity(account) ||
        getSecret(CRED_PREFIX + accountId) !== blob) return false;
    const saved = setSecret(CRED_PREFIX + accountId, updated);
    if (!saved.ok) {
      markClaudeRefreshFailed(account);
      console.warn(
        '[accounts] token Claude renovado, mas não persistido no vault',
      );
      return false;
    }
    settleRenewedClaudeCredential(accountId);
    console.info('[accounts] claude oauth renovado para conta', account.label);
    return true;
  } catch {
    markClaudeRefreshFailed(account);
    return false;
  } finally {
    claudeRefreshInFlight.delete(accountId);
  }
}

/**
 * Sweeper de frescor: mantém os tokens das contas Claude secundárias válidos
 * para que qualquer spawn/failover encontre credencial viva no vault.
 */
let freshnessSequence = 0;
const freshnessStops = new Set<() => Promise<void>>();

export function startClaudeSubscriptionFreshness(
  intervalMs = 15 * 60 * 1000,
): () => Promise<void> {
  const controller = new AbortController();
  const id = `claude-auth-freshness:${++freshnessSequence}`;
  const tick = () => {
    void runPeriodicTask(id, async (context) => {
      for (const hint of listAccounts('claude')) {
        await context.checkpoint();
        const account = accounts.get(hint.id);
        if (!account || account.adapterId !== 'claude') continue;
        // Cold boot remains cache-only: never unlock the native Keychain.
        if (!hasCachedSecret(CRED_PREFIX + account.id)) continue;
        // External rotation must settle under its existing lineage checks;
        // cancellation stops subsequent accounts, never loses a rotated grant.
        await context.wait(ensureFreshClaudeSubscription(account.id));
      }
    }, { signal: controller.signal, cadenceMs: intervalMs }).catch((error) => {
      if (!controller.signal.aborted) console.warn('[accounts] freshness sweep failed:', error);
    });
  };
  const initial = setTimeout(tick, 0);
  initial.unref?.();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  const stop = async () => {
    clearTimeout(initial);
    clearInterval(timer);
    controller.abort(new Error('account freshness stopped'));
    await stopPeriodicTask(id);
    freshnessStops.delete(stop);
  };
  freshnessStops.add(stop);
  return stop;
}

export async function stopClaudeSubscriptionFreshness(): Promise<void> {
  await Promise.all([...freshnessStops].map((stop) => stop()));
}

/**
 * Pick an available account for `adapterId`, excluding `excludeId` and any on
 * cooldown. Preserves the explicitly-active one when quota is unknown; when
 * measured scores are supplied, a demonstrably freer sibling may win.
 * Pure-ish (reads cooldown vs a supplied now) — the core failover decision.
 */
export function pickAvailable(
  adapterId: string,
  excludeId: string | null,
  now = Date.now(),
  quotaScoreByAccountId?: ReadonlyMap<string, number>,
): Account | null {
  return chooseAccount(
    listAccounts(adapterId),
    activeByAdapter.get(adapterId) ?? null,
    excludeId,
    now,
    quotaScoreByAccountId,
  );
}

/**
 * Whether `adapterId` has at least one account able to serve a spawn now.
 * Adapters with no Nexus-managed accounts report available — third-party
 * auth state is not ours to judge.
 */
export function hasAvailableAccount(
  adapterId: string,
  now = Date.now(),
): boolean {
  if (listAccounts(adapterId).length === 0) return true;
  return pickAvailable(adapterId, null, now) !== null;
}

/** DELETE oportunista de bloco expirado; nunca falha o caminho de leitura. */
function deleteCooldownBlockRow(accountId: string, scope: string): void {
  if (!db || readOnly) return;
  try {
    db.prepare(
      'DELETE FROM account_cooldown_blocks WHERE account_id = ? AND block_scope = ?',
    ).run(accountId, scope);
  } catch {
    // Limpeza preguiçosa é oportunista; o bloco expirado já não bloqueia.
  }
}

/** Bloco vigente de um escopo exato, com limpeza preguiçosa ao expirar. */
function activeBlock(
  accountId: string,
  scope: string,
  now: number,
): CooldownBlock | null {
  const byScope = cooldownBlocks.get(accountId);
  const block = byScope?.get(scope);
  if (!byScope || !block) return null;
  if (block.blockedUntil <= now) {
    // Restauração automática: cooldown expirado devolve a conta ao pool.
    byScope.delete(scope);
    if (byScope.size === 0) cooldownBlocks.delete(accountId);
    deleteCooldownBlockRow(accountId, scope);
    return null;
  }
  return block;
}

interface EffectiveBlock {
  block: CooldownBlock;
  /** Escopo do bloco vencedor ('' = global) — alvo de markProbeConsumed. */
  blockScope: string;
}

/**
 * Bloco que impede a conta de atender um spawn no escopo dado: o global
 * (linha legada da conta ou bloco escopo '') sempre conta; o escopado só
 * conta quando `scope` casa. Vence o de maior blockedUntil (regra do omp).
 */
function effectiveBlock(
  account: Account,
  now: number,
  scope?: string,
): EffectiveBlock | null {
  let result: EffectiveBlock | null = null;
  const global = activeBlock(account.id, GLOBAL_SCOPE, now);
  if (global) result = { block: global, blockScope: GLOBAL_SCOPE };
  if (account.cooldownUntil && account.cooldownUntil > now) {
    // Linha legada sem bloco espelhado (DB antigo): sintetiza sem janela de
    // probe antecipada (probeAfter = fim do cooldown → sem sondagem).
    if (!result || account.cooldownUntil > result.block.blockedUntil) {
      result = {
        block: {
          blockedUntil: account.cooldownUntil,
          reason: account.lastError ?? '',
          probeAfter: account.cooldownUntil,
        },
        blockScope: GLOBAL_SCOPE,
      };
    }
  }
  if (scope && scope !== GLOBAL_SCOPE) {
    const scoped = activeBlock(account.id, scope, now);
    if (scoped && (!result || scoped.blockedUntil > result.block.blockedUntil)) {
      result = { block: scoped, blockScope: scope };
    }
  }
  return result;
}

/**
 * True quando a conta está bloqueada para spawns no escopo dado. Sem escopo,
 * só blocos globais contam — uma conta com bloco `tier:x` segue disponível
 * para os demais modelos (contrato central do cooldown escopado).
 */
export function isAccountBlockedForScope(
  accountId: string,
  now = Date.now(),
  scope?: string,
): boolean {
  const account = accounts.get(accountId);
  if (!account) return false;
  return effectiveBlock(account, now, scope) !== null;
}

/** Persiste o consumo da sondagem (uma por janela) no bloco vencedor. */
function markProbeConsumed(
  account: Account,
  entry: EffectiveBlock,
  now: number,
): void {
  const consumed: CooldownBlock = { ...entry.block, probedAt: now };
  upsertCooldownBlock(account.id, entry.blockScope, consumed);
}

/**
 * F-235: capacidade de panes simultâneos do adapter = contas gerenciadas com
 * credencial utilizável fora de bloco efetivo (mesma régua do failover).
 * Sem conta gerenciada a capacidade é 1: o login nativo.
 */
export function countAccountsWithLiveCredential(
  adapterId: string,
  now = Date.now(),
): number {
  const all = listAccounts(adapterId);
  if (all.length === 0) return 1;
  return all.filter(
    (a) => accountHasFailoverCredential(a) && !effectiveBlock(a, now),
  ).length;
}

export interface FailoverPickOptions {
  /** Escopo do spawn alvo (ex.: 'tier:opus'); ausente = só blocos globais. */
  scope?: string;
  /**
   * Habilita a sondagem last-resort: quando nada está livre, uma conta cujo
   * bloco tem probeAfter vencido e ainda não foi sondado nesta janela é
   * devolvida com `probe: true` (e a sondagem é consumida na hora).
   */
  allowProbe?: boolean;
  /**
   * Contas já tentadas neste mesmo failover cujo prepare falhou (F-676): o
   * pick seguinte passa para a próxima da frota em vez de repetir a mesma.
   */
  excludeIds?: ReadonlySet<string>;
  /**
   * F-995: janelas medidas por conta. Com elas a folga só se compara entre
   * janelas comparáveis (`compareAccountHeadroom`), nunca pelo escore escalar.
   */
  quotaByAccountId?: ReadonlyMap<string, HeadroomInput>;
  /**
   * F-1483: troca por limite — conta com alguma janela MEDIDA em 100% que
   * ainda não reabriu não é destino (respawnar nela só bate de novo). Ela
   * entra na espera (`nextUnblockAtMs`) pelo reset da janela, ou por
   * EXHAUSTED_UNKNOWN_RESET_MS quando o reset é desconhecido. O spawn comum
   * não liga: abre na ativa e avisa.
   */
  rejectExhausted?: boolean;
}

/** F-1483: janela cheia sem reset conhecido — fora até a próxima releitura. */
const EXHAUSTED_UNKNOWN_RESET_MS = 15 * 60_000;

export interface FailoverPick {
  account: Account | null;
  /** True = sondagem controlada: a conta ainda está em cooldown. */
  probe: boolean;
  /**
   * Menor blockedUntil entre as irmãs elegíveis quando nada está livre —
   * o chamador agenda retry nesse instante + 1s em vez de desistir ou
   * esperar a janela multi-hora do provedor (retryAtMs do omp).
   */
  nextUnblockAtMs?: number;
}

// Derived from can1357/oh-my-pi@03c48d073 auth-storage cooldown machine (MIT):
// seleção escopo-ciente + retryAtMs da irmã + probe-after last-resort.
export function pickAvailableForFailover(
  adapterId: string,
  excludeId: string | null,
  now = Date.now(),
  quotaScoreByAccountId?: ReadonlyMap<string, number>,
  options?: FailoverPickOptions,
): FailoverPick {
  const siblings = listAccounts(adapterId).filter(
    (a) => a.id !== excludeId && !options?.excludeIds?.has(a.id),
  );
  // F-1483: conta medida cheia sai da escolha e conta na espera pelo reset.
  const measuredFullUntil = new Map<string, number>();
  if (options?.rejectExhausted) {
    for (const sibling of siblings) {
      const until = fullWindowsReopenAt(
        options.quotaByAccountId?.get(sibling.id),
        now,
        EXHAUSTED_UNKNOWN_RESET_MS,
      );
      if (until !== undefined) measuredFullUntil.set(sibling.id, until);
    }
  }
  const free = siblings.filter(
    (a) =>
      !effectiveBlock(a, now, options?.scope) &&
      accountHasFailoverCredential(a) &&
      !measuredFullUntil.has(a.id),
  );
  const chosen = chooseAccount(
    free,
    activeByAdapter.get(adapterId) ?? null,
    excludeId,
    now,
    quotaScoreByAccountId,
    options?.quotaByAccountId,
  );
  if (chosen) return { account: chosen, probe: false };

  let nextUnblockAtMs: number | undefined;
  const noteUnblock = (at: number): void => {
    if (nextUnblockAtMs === undefined || at < nextUnblockAtMs) nextUnblockAtMs = at;
  };
  const blocked: Array<{ account: Account; entry: EffectiveBlock }> = [];
  for (const sibling of siblings) {
    const entry = effectiveBlock(sibling, now, options?.scope);
    // F-1483: medida cheia libera no reset da janela (no mais tarde, se também em cooldown).
    const fullUntil = measuredFullUntil.get(sibling.id);
    if (!entry) {
      if (fullUntil !== undefined && accountHasFailoverCredential(sibling)) noteUnblock(fullUntil);
      continue;
    }
    blocked.push({ account: sibling, entry });
    noteUnblock(Math.max(entry.block.blockedUntil, fullUntil ?? 0));
  }

  if (options?.allowProbe) {
    const probeCandidate = blocked
      .filter(
        ({ account, entry }) =>
          accountHasFailoverCredential(account) &&
          !measuredFullUntil.has(account.id) &&
          entry.block.probeAfter <= now &&
          entry.block.probedAt === undefined,
      )
      .sort((a, b) => a.account.createdAt - b.account.createdAt)[0];
    if (probeCandidate) {
      markProbeConsumed(probeCandidate.account, probeCandidate.entry, now);
      return {
        account: probeCandidate.account,
        probe: true,
        ...(nextUnblockAtMs !== undefined ? { nextUnblockAtMs } : {}),
      };
    }
  }

  return {
    account: null,
    probe: false,
    ...(nextUnblockAtMs !== undefined ? { nextUnblockAtMs } : {}),
  };
}

export interface AddAccountInput {
  adapterId: string;
  label: string;
  mode: AccountMode;
  upstream?: string;
  key?: string;
}

/** Add an api-key account (GLM/z.ai, Fugu, native-key, …). */
export function addAccount(input: AddAccountInput): Account {
  requireWritableDb();
  const account: Account = {
    id: makeId(),
    adapterId: input.adapterId,
    label: input.label,
    mode: input.mode,
    upstream: input.upstream ?? 'anthropic',
    createdAt: Date.now(),
  };
  const nextAccounts = new Map(accounts);
  const nextActive = new Map(activeByAdapter);
  nextAccounts.set(account.id, account);
  nextActive.set(account.adapterId, account.id);

  let secretKey: string | null = null;
  if (input.mode === 'api-key' && input.key) {
    secretKey = KEY_PREFIX + account.id;
    const result = setSecret(secretKey, input.key);
    if (!result.ok) {
      throw new PersistenceUnavailableError(
        result.error ?? 'failed to persist account credential',
      );
    }
  }
  try {
    persistSnapshot(nextAccounts, nextActive, 'add');
  } catch (error) {
    if (secretKey) {
      const rollback = deleteSecret(secretKey);
      if (!rollback.ok) {
        throw new PersistenceUnavailableError(
          'account metadata failed and credential rollback was not durable',
        );
      }
    }
    throw error;
  }

  replaceMap(accounts, nextAccounts);
  replaceMap(activeByAdapter, nextActive);
  emit();
  return account;
}

/**
 * Conta subscription do adapter que JÁ representa esta sessão:
 * mesmo e-mail (identidade estável atravessa rotações de token) ou, sem
 * e-mail de nenhum lado, blob idêntico.
 */
function findSessionDuplicate(
  adapterId: string,
  email: string | undefined,
  blob: string,
): Account | null {
  const normalized = email?.trim().toLowerCase();
  for (const account of listAccounts(adapterId)) {
    if (account.mode !== 'subscription') continue;
    const storedBlob = getSecret(CRED_PREFIX + account.id);
    if (storedBlob && isFileAuthAdapter(adapterId)) {
      // ponytail: O(N) vault comparison avoids a schema migration; if account
      // pools ever become large, persist an indexed provider identity digest.
      const identity = compareAuthBlobIdentity(adapterId, blob, storedBlob);
      if (identity === 'same') return account;
      // A provider subject is stronger than email. One email can own multiple
      // Codex workspaces, which must remain independent accounts.
      if (identity === 'different') continue;
    }
    if (
      normalized &&
      account.email &&
      account.email.trim().toLowerCase() === normalized
    ) {
      return account;
    }
    if ((!normalized || !account.email) && storedBlob === blob) return account;
  }
  return null;
}

/**
 * Dono comprovado pela própria credencial, sem fallback de e-mail.
 * Usado na reautenticação direcionada: se o operador clicou na conta B, uma
 * credencial que comprovadamente pertence à A deve ser recusada, não movida.
 */
function credentialIdentityOwner(
  adapterId: string,
  blob: string,
): Account | null {
  if (adapterId === 'claude') return claudeCredentialOwner(blob);
  if (!isFileAuthAdapter(adapterId)) return null;
  for (const account of listAccounts(adapterId)) {
    if (account.mode !== 'subscription') continue;
    const storedBlob = getSecret(CRED_PREFIX + account.id);
    if (
      storedBlob &&
      compareAuthBlobIdentity(adapterId, blob, storedBlob) === 'same'
    ) {
      return account;
    }
  }
  return null;
}

/** Provider-backed Claude capture for explicit add and targeted re-login. */
export async function addActiveSessionAccountAuthoritative(
  adapterId: string,
  label: string,
  targetAccountId?: string,
): Promise<Account | null> {
  if (adapterId !== 'claude') {
    return addActiveSessionAccount(adapterId, label, targetAccountId);
  }
  const targeted = targetAccountId ? getAccount(targetAccountId) : null;
  if (targetAccountId && (!targeted || targeted.adapterId !== 'claude' ||
      targeted.mode !== 'subscription' || !targeted.email)) {
    throw new Error('A conta Claude escolhida não tem identidade verificável; entre novamente.');
  }
  invalidateClaudeCredentialCache();
  const blob = readActiveClaudeCredentialSlim() ?? (() => {
    const raw = readActiveClaudeCredential();
    return raw ? slimClaudeCredentialBlob(raw) : null;
  })();
  if (!blob) return null;
  const profile = await resolveClaudeCredentialProfile(blob);
  if (!profile) {
    throw new Error('Não foi possível confirmar a identidade da sessão Claude; entre novamente.');
  }
  if (targeted?.email && !emailsEqual(profile.email, targeted.email)) {
    throw new Error(`O login concluído pertence a outra conta Claude, não a “${targeted.label}”.`);
  }
  return addActiveSessionAccount(adapterId, label, targetAccountId, {
    blob, email: profile.email,
  });
}

/**
 * Snapshot the CURRENTLY signed-in CLI session into a subscription account.
 * Claude → Keychain blob; Codex/Grok/Kimi/… → native auth.json (Orca-style).
 *
 * Re-login da MESMA conta atualiza a entrada existente (blob fresco + email
 * se antes faltava) e a reativa — nunca empilha duplicata do assinante. Sem
 * isto, cada ciclo login→salvar criava "mais uma conta" da mesma pessoa.
 */
export function addActiveSessionAccount(
  adapterId: string,
  label: string,
  targetAccountId?: string,
  verifiedClaude?: { blob: string; email: string },
): Account | null {
  requireWritableDb();

  const targeted = targetAccountId ? getAccount(targetAccountId) : null;
  if (
    targetAccountId &&
    (!targeted ||
      targeted.adapterId !== adapterId ||
      targeted.mode !== 'subscription')
  ) {
    throw new Error('A conta escolhida para reautenticação não existe mais.');
  }
  if (adapterId === 'claude' && targeted && !verifiedClaude) {
    throw new Error('A reautenticação Claude precisa de prova de identidade do provedor.');
  }

  let blob: string | null = null;
  let email: string | undefined;

  if (adapterId === 'claude') {
    // A CLI acabou de escrever o Keychain fora do processo do Nexus. Esta é
    // uma ação explícita pós-login: descarte qualquer leitura memoizada antes
    // de capturar, senão "Signed in" salvaria o blob revogado anterior (ou o
    // null de uma negação antiga) por até o backoff inteiro.
    if (verifiedClaude) {
      blob = verifiedClaude.blob;
      email = verifiedClaude.email;
    } else {
      invalidateClaudeCredentialCache();
      blob =
        readActiveClaudeCredentialSlim() ??
        (() => {
          const raw = readActiveClaudeCredential();
          return raw ? slimClaudeCredentialBlob(raw) : null;
        })();
      email = activeClaudeEmail() ?? undefined;
    }
  } else if (isFileAuthAdapter(adapterId)) {
    // Mesma regra da captura Claude acima: a vaga do AGY no Windows acabou de
    // mudar fora do Nexus; uma leitura memoizada salvaria a conta anterior.
    if (adapterId === 'agy') invalidateAgyWindowsKeyringCache();
    const capture = captureNativeAuth(adapterId);
    if (capture) {
      blob = capture.blob;
      email = capture.email;
    } else if (adapterId === 'agy') {
      // F-1580: no Windows a sobra de outro formato em ~/.gemini não vira
      // conta (ela nunca abriria); diga o que fazer em vez de "rode agy".
      const unreadable = agyWindowsUnreadableSessionReason();
      if (unreadable) throw new Error(unreadable);
    }
  } else {
    return null;
  }
  if (!blob) return null;
  if (adapterId === 'claude') {
    // Captura explícita do item real: alimente a sonda assíncrona com o mesmo
    // blob em vez de fazê-la ler `-w` outra vez e potencialmente pedir ACL.
    rememberNativeOAuthCredential(CLAUDE_KEYCHAIN_SERVICE, blob);
  }

  const tokenOwner = credentialIdentityOwner(adapterId, blob);
  const credentialOwner = verifiedClaude
    ? targeted ?? (tokenOwner?.email && emailsEqual(tokenOwner.email, verifiedClaude.email)
      ? tokenOwner
      : listAccounts('claude').find((account) => account.mode === 'subscription' &&
          account.email && emailsEqual(account.email, verifiedClaude.email)) ?? null)
    : tokenOwner;
  if (credentialOwner?.email) email = credentialOwner.email;
  if (
    targeted &&
    credentialOwner &&
    credentialOwner.id !== targeted.id
  ) {
    throw new Error(
      `O login concluído pertence a “${credentialOwner.label}”, não a “${targeted.label}”.`,
    );
  }
  if (
    targeted &&
    !credentialOwner &&
    email &&
    targeted.email &&
    !emailsEqual(email, targeted.email)
  ) {
    throw new Error(
      `O login concluído é de ${email}, mas a conta escolhida é ${targeted.email}.`,
    );
  }
  const targetedBlob = targeted ? getSecret(CRED_PREFIX + targeted.id) : null;
  if (targetedBlob && isFileAuthAdapter(adapterId) &&
    compareAuthBlobIdentity(adapterId, blob, targetedBlob) === 'different') {
    throw new Error('O login concluído pertence a outra identidade, não à conta escolhida.');
  }
  const existing =
    targeted ??
    credentialOwner ??
    (verifiedClaude ? null : findSessionDuplicate(adapterId, email, blob));
  if (existing) {
    const secretKey = CRED_PREFIX + existing.id;
    const previousSecret = getSecret(secretKey);
    const saved = setSecret(secretKey, blob);
    if (!saved.ok) {
      throw new PersistenceUnavailableError(
        saved.error ?? 'failed to persist account credential',
      );
    }
    // Blob fresco vindo do CLI vivo: a renovação voltou a ser possível.
    try {
      if (isFileAuthAdapter(adapterId)) {
        materializeManagedHome(adapterId as FileAuthAdapterId, existing.id, blob, { replace: Boolean(targeted) });
      } else if (adapterId === 'claude' && hasManagedClaudeAuth(existing.id)) {
        materializeManagedClaudeAuth(existing.id, blob, { replace: true });
      }
      const nextAccounts = new Map(accounts);
      // Identidade pode ter chegado agora (capture antigo sem e-mail).
      const refreshed: Account = {
        ...existing,
        email: email ?? existing.email,
        cooldownUntil: undefined,
        lastError: undefined,
      };
      nextAccounts.set(existing.id, refreshed);
      const nextActive = new Map(activeByAdapter);
      nextActive.set(adapterId, existing.id);
      persistSnapshot(nextAccounts, nextActive, 'refresh subscription');
      replaceMap(accounts, nextAccounts);
      replaceMap(activeByAdapter, nextActive);
      claudeRefreshFailedAt.delete(existing.id);
      clearCooldown(existing.id, 'sessão reautenticada no CLI');
      emit();
      return refreshed;
    } catch (error) {
      if (previousSecret !== null) {
        const restore = setSecret(secretKey, previousSecret);
        if (!restore.ok) {
          throw new PersistenceUnavailableError(
            'session refresh failed and credential rollback was not durable',
          );
        }
      }
      throw error;
    }
  }

  const account: Account = {
    id: makeId(),
    adapterId,
    label,
    mode: 'subscription',
    upstream: adapterId === 'claude' ? 'anthropic' : adapterId,
    email,
    createdAt: Date.now(),
  };
  const nextAccounts = new Map(accounts);
  const nextActive = new Map(activeByAdapter);
  nextAccounts.set(account.id, account);
  nextActive.set(adapterId, account.id);

  const secretKey = CRED_PREFIX + account.id;
  const result = setSecret(secretKey, blob);
  if (!result.ok) {
    throw new PersistenceUnavailableError(
      result.error ?? 'failed to persist account credential',
    );
  }
  try {
    // Eager materialize so the new active account is ready for the next spawn.
    if (isFileAuthAdapter(adapterId)) {
      materializeManagedHome(adapterId as FileAuthAdapterId, account.id, blob);
    }
    persistSnapshot(nextAccounts, nextActive, 'add subscription');
  } catch (error) {
    const rollback = deleteSecret(secretKey);
    if (!rollback.ok) {
      throw new PersistenceUnavailableError(
        'account metadata failed and credential rollback was not durable',
      );
    }
    if (isFileAuthAdapter(adapterId)) {
      removeManagedHome(adapterId, account.id);
    }
    throw error;
  }

  replaceMap(accounts, nextAccounts);
  replaceMap(activeByAdapter, nextActive);
  emit();
  return account;
}

/**
 * F-677: conta dona da sessão que está agora na vaga do AGY no Windows (a
 * sessão entra no cofre se ainda não estiver). Null fora do Windows ou com a
 * vaga vazia.
 */
export function agyKeyringSlotAccount(): Account | null {
  if (process.platform !== 'win32') return null;
  const blob = readAgyWindowsKeyringBlob();
  if (!blob) return null;
  try {
    return preserveAgyKeyringSession(blob);
  } catch {
    return authBlobIsUsable('agy', blob) ? credentialIdentityOwner('agy', blob) : null;
  }
}

/** Blob salvo de uma conta AGY de assinatura (F-677), ou null. */
export function agyAccountCredentialBlob(accountId: string): string | null {
  const account = getAccount(accountId);
  if (!account || account.adapterId !== 'agy' || account.mode !== 'subscription') {
    return null;
  }
  return getSecret(CRED_PREFIX + accountId);
}

/**
 * F-677: antes de o Nexus trocar a vaga única do AGY no Windows, o que está
 * nela vai para o cofre — a conta dona (mesma identidade) recebe o blob mais
 * fresco; sem dona, a sessão vira conta nova. Nunca mexe em cooldown nem na
 * conta ativa: a troca acontece justamente porque a conta da vaga esgotou.
 */
export function preserveAgyKeyringSession(blob: string): Account | null {
  if (!authBlobIsUsable('agy', blob)) return null;
  const owner = credentialIdentityOwner('agy', blob);
  if (owner) {
    if (getSecret(CRED_PREFIX + owner.id) !== blob) {
      const saved = setSecret(CRED_PREFIX + owner.id, blob);
      if (!saved.ok) {
        throw new PersistenceUnavailableError(
          saved.error ?? 'failed to persist AGY session',
        );
      }
    }
    return owner;
  }
  requireWritableDb();
  const email = identityFromAuthBlob('agy', blob).email;
  const account: Account = {
    id: makeId(),
    adapterId: 'agy',
    label: email ?? 'AGY',
    mode: 'subscription',
    upstream: 'agy',
    ...(email ? { email } : {}),
    createdAt: Date.now(),
  };
  const secretKey = CRED_PREFIX + account.id;
  const saved = setSecret(secretKey, blob);
  if (!saved.ok) {
    throw new PersistenceUnavailableError(
      saved.error ?? 'failed to persist AGY session',
    );
  }
  const nextAccounts = new Map(accounts);
  nextAccounts.set(account.id, account);
  const nextActive = new Map(activeByAdapter);
  if (!nextActive.has('agy')) nextActive.set('agy', account.id);
  try {
    persistSnapshot(nextAccounts, nextActive, 'preserve agy keyring session');
  } catch (error) {
    const rollback = deleteSecret(secretKey);
    if (!rollback.ok) {
      throw new PersistenceUnavailableError(
        'account metadata failed and credential rollback was not durable',
      );
    }
    throw error;
  }
  replaceMap(accounts, nextAccounts);
  replaceMap(activeByAdapter, nextActive);
  emit();
  return account;
}

let vacatedAgyNative: {
  blob: string;
  authRelativePath: string;
  home: string;
} | null = null;

/**
 * F-1580: no Windows a captura lê a vaga e só aceita arquivo no formato dela;
 * a sobra de outro formato (o `oauth_creds.json` do Gemini CLI, o arquivo do
 * AGY 1.1) não vai para o cofre, mas o preparo do login ainda a apaga. Se o
 * login for cancelado ela volta, como voltava quando era capturada.
 */
let vacatedAgyLeftover: {
  home: string;
  platform: NodeJS.Platform;
  files: { file: string; contents: string }[];
} | null = null;

/**
 * Prepara a vaga nativa do Antigravity (`agy`) para um novo login sem chamar
 * `/logout` no servidor do Google (que revogaria o refresh_token da Conta 1).
 *
 * 1. Lê a sessão nativa atual (`gemini:antigravity` / `~/.gemini`) e a guarda
 *    no cofre do Nexus (`preserveAgyKeyringSession` — fail-closed se falhar).
 * 2. Esvazia apenas a vaga local (Credential Manager / Keychain / arquivos de
 *    token em `~/.gemini`), para que o binário `agy` abra o fluxo OAuth do
 *    navegador imediatamente em vez de entrar no chat da Conta 1.
 */
export function prepareAgyNativeLogin(
  home = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): { ok: boolean; error?: string } {
  invalidateAgyWindowsKeyringCache();
  resetAgyKeychainCache();
  vacatedAgyLeftover = null;
  const current = captureNativeAuth('agy', home, { platform });
  if (current) {
    try {
      const preserved = preserveAgyKeyringSession(current.blob);
      if (!preserved) {
        return {
          ok: false,
          error:
            'Não foi possível guardar a sessão AGY atual no cofre antes de abrir o novo login.',
        };
      }
      vacatedAgyNative = {
        blob: current.blob,
        authRelativePath: current.authRelativePath,
        home,
      };
    } catch (err) {
      return {
        ok: false,
        error:
          err instanceof Error
            ? err.message
            : 'Não foi possível guardar a sessão AGY atual no cofre.',
      };
    }
  }

  if (process.platform === 'win32' && !process.env.VITEST) {
    if (!deleteAgyWindowsKeyringBlob()) {
      return {
        ok: false,
        error:
          'Não foi possível liberar a vaga local do Antigravity no Gerenciador de Credenciais.',
      };
    }
  } else if (process.platform === 'darwin' && !process.env.VITEST) {
    try {
      execFileSync(
        '/usr/bin/security',
        ['delete-generic-password', '-s', 'gemini', '-a', 'antigravity'],
        { stdio: 'ignore', timeout: 4_000, killSignal: 'SIGKILL' },
      );
    } catch {
      // Item pode já estar ausente.
    }
    resetAgyKeychainCache();
  }

  const geminiDir = path.join(home, '.gemini');
  const nativeTokenFiles = [
    path.join(geminiDir, 'oauth_creds.json'),
    path.join(geminiDir, 'antigravity-cli', 'antigravity-oauth-token'),
    path.join(geminiDir, 'jetski-standalone-oauth-token'),
    path.join(geminiDir, 'google_accounts.json'),
  ];
  const leftover: { file: string; contents: string }[] = [];
  for (const file of nativeTokenFiles) {
    if (platform === 'win32') {
      try {
        leftover.push({ file, contents: fs.readFileSync(file, 'utf8') });
      } catch {
        // Ausente: nada a devolver.
      }
    }
    try {
      fs.unlinkSync(file);
    } catch {
      // Ignora arquivo ausente.
    }
  }
  if (leftover.length > 0) vacatedAgyLeftover = { home, platform, files: leftover };
  invalidateAgyWindowsKeyringCache();
  return { ok: true };
}

/** F-1580: devolve a sobra apagada pelo preparo, sem sobrescrever arquivo novo. */
function restoreAgyLeftoverFiles(
  files: readonly { readonly file: string; readonly contents: string }[],
): void {
  for (const { file, contents } of files) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, contents, { mode: 0o600, flag: 'wx' });
    } catch {
      // Já existe (o login escreveu) ou o disco recusou: segue.
    }
  }
}

/**
 * Se o terminal de login do AGY foi fechado/cancelado sem concluir um novo
 * OAuth, devolve a sessão anterior para a vaga nativa.
 */
export function restoreAgyNativeLogin(): boolean {
  const vacated = vacatedAgyNative;
  const leftover = vacatedAgyLeftover;
  if (!vacated && !leftover) return false;
  invalidateAgyWindowsKeyringCache();
  resetAgyKeychainCache();
  const home = vacated?.home ?? leftover!.home;
  if (captureNativeAuth('agy', home, leftover ? { platform: leftover.platform } : {}) !== null) {
    // Login concluído: a sessão nova fica e a sobra continua apagada.
    vacatedAgyNative = null;
    vacatedAgyLeftover = null;
    return true;
  }
  vacatedAgyLeftover = null;
  if (leftover) restoreAgyLeftoverFiles(leftover.files);
  if (!vacated) {
    invalidateAgyWindowsKeyringCache();
    return true;
  }
  try {
    if (
      process.platform === 'win32' &&
      !process.env.VITEST &&
      isAgyKeyringBlob(vacated.blob)
    ) {
      writeAgyWindowsKeyringBlob(vacated.blob);
    } else {
      const target = path.join(vacated.home, '.gemini', vacated.authRelativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, vacated.blob, { mode: 0o600 });
    }
    vacatedAgyNative = null;
    invalidateAgyWindowsKeyringCache();
    return true;
  } catch {
    return false;
  }
}

/**
 * O device code do Codex vence em 15 min. Um login pendente além disso é um
 * terminal abandonado (renderer recarregado, janela fechada): o próximo
 * preparo devolve a sessão dele e libera a vaga.
 */
export const CODEX_LOGIN_PENDING_TTL_MS = 16 * 60_000;
/** Um auth.json real tem poucos KB; FIFO, /dev/zero ou arquivo gigante travariam o Main. */
const CODEX_AUTH_MAX_BYTES = 1024 * 1024;
const CODEX_LOGIN_STASH_PREFIX = '.auth.json.nexus-login-';

interface VacatedCodexNative {
  authFile: string;
  blob: string;
  /** `auth.json` era um link (gerenciador de dotfiles): volta o link, não uma cópia. */
  linkTarget?: string;
  at: number;
}

/** Sessão que saiu da vaga nativa para um login em andamento (só no Main, nunca no renderer). */
let vacatedCodexNative: VacatedCodexNative | null = null;

export type CodexLoginRestore = 'none' | 'restored' | 'slot-taken' | 'failed';

function codexNativeAuthFile(): string | null {
  const home = MANAGED_PROVIDER_SPECS.codex.systemHome();
  return home ? path.join(home, 'auth.json') : null;
}

type CodexSlot =
  | { kind: 'absent' }
  | { kind: 'file'; blob: string; linkTarget?: string }
  | { kind: 'refused' };

/**
 * Lê a vaga só como arquivo comum e pequeno, num descritor aberto uma vez com
 * O_NONBLOCK (link para arquivo comum é seguido: dotfiles). Link pendurado não
 * tem sessão a proteger.
 */
function readCodexSlot(file: string): CodexSlot {
  const entry = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!entry) return { kind: 'absent' };
  const linkTarget = entry.isSymbolicLink() ? fs.readlinkSync(file) : undefined;
  const read = readRegularFileCapped(file, CODEX_AUTH_MAX_BYTES);
  if (read.kind === 'text') {
    return { kind: 'file', blob: read.text, ...(linkTarget ? { linkTarget } : {}) };
  }
  if (linkTarget && !fs.existsSync(file)) return { kind: 'absent' };
  return { kind: 'refused' };
}

/** A conta dona recebe no cofre a cópia mais fresca da linhagem: a da vaga, a do home gerenciado ou a do cofre. */
function keepFreshestCodexLineage(owner: Account, blob: string): boolean {
  const key = CRED_PREFIX + owner.id;
  const saved = getSecret(key);
  if (saved === null && hasSecret(key)) return false;
  const freshest = [blob, ...accountCredentialCandidates('codex', owner.id, saved)]
    .filter((candidate) => compareAuthBlobIdentity('codex', candidate, blob) !== 'different')
    .sort((left, right) => -(compareAuthFreshness(left, right) ?? 0))[0] ?? blob;
  return freshest === saved || setSecret(key, freshest).ok;
}

/**
 * O `codex login` (0.16x) revoga em auth.openai.com/oauth/revoke o login que
 * encontra no auth.json e apaga o arquivo ANTES do device flow, mesmo que o
 * login seja cancelado depois. O terminal de login roda no ~/.codex nativo, e
 * o Nexus guarda essa mesma sessão (mesmo refresh token) no cofre e no home
 * gerenciado: entrar na conta B revogava a conta A já salva. Com a vaga vazia
 * a CLI não tem o que revogar.
 *
 * Contrato: um login do Codex por vez (pendente com menos de
 * `CODEX_LOGIN_PENDING_TTL_MS` recusa o segundo); sessão usável sem conta dona
 * vira conta antes de sair da vaga; a vaga sai por rename atômico e a conta
 * dona recebe a cópia movida, que fica em memória até `restoreCodexNativeLogin`.
 * Qualquer falha devolve a vaga como estava e o login não abre.
 */
export function prepareCodexNativeLogin(): { ok: boolean; error?: string } {
  if (vacatedCodexNative) {
    if (Date.now() - vacatedCodexNative.at < CODEX_LOGIN_PENDING_TTL_MS) {
      return {
        ok: false,
        error: 'Já há um login do Codex em andamento. Conclua ou feche o terminal dele antes de abrir outro.',
      };
    }
    // Terminal abandonado: devolve a sessão dele (melhor esforço) e libera.
    restoreCodexNativeLogin();
    vacatedCodexNative = null;
  }
  const authFile = codexNativeAuthFile();
  if (!authFile) return { ok: true };
  const keepError = {
    ok: false,
    error: 'Não consegui guardar a sessão atual do Codex antes do novo login. O login não foi iniciado.',
  };
  let owner: Account | null = null;
  try {
    const current = readCodexSlot(authFile);
    if (current.kind === 'absent') return { ok: true };
    if (current.kind === 'refused') return keepError;
    if (authBlobIsUsable('codex', current.blob)) {
      const locked = listAccounts('codex').find((account) => account.mode === 'subscription' &&
        hasSecret(CRED_PREFIX + account.id) && getSecret(CRED_PREFIX + account.id) === null);
      if (locked) {
        return {
          ok: false,
          error: `O cofre do Nexus não liberou a credencial salva de “${locked.label}”. ` +
            'O login do Codex não foi aberto para não perder a sessão atual: destrave o cofre ou remova essa conta.',
        };
      }
      // Sem conta dona (a Atenção não guarda antes): a sessão vira conta, ou não sai da vaga.
      owner = credentialIdentityOwner('codex', current.blob) ??
        addActiveSessionAccount('codex', identityFromAuthBlob('codex', current.blob).email ?? 'Codex');
      if (!owner) return keepError;
    }
  } catch {
    return keepError;
  }
  // A vaga sai num passo atômico: o que estiver nela nesse instante (inclusive
  // uma renovação que acabou de cair) é o que a conta dona recebe.
  const stash = path.join(path.dirname(authFile), `${CODEX_LOGIN_STASH_PREFIX}${randomUUID()}`);
  try {
    fs.renameSync(authFile, stash);
  } catch {
    return keepError;
  }
  try {
    // O temporário guarda um segredo: 0600 (link não, senão mudaria o alvo do operador).
    if (!fs.lstatSync(stash).isSymbolicLink()) fs.chmodSync(stash, 0o600);
    const moved = readCodexSlot(stash);
    if (moved.kind !== 'file') throw new Error('codex login stash unreadable');
    if (authBlobIsUsable('codex', moved.blob)) {
      owner = credentialIdentityOwner('codex', moved.blob);
      if (!owner || !keepFreshestCodexLineage(owner, moved.blob)) throw new Error('codex session not kept');
    }
    fs.unlinkSync(stash);
    vacatedCodexNative = {
      authFile,
      blob: moved.blob,
      ...(moved.linkTarget ? { linkTarget: moved.linkTarget } : {}),
      at: Date.now(),
    };
  } catch {
    // Devolve a vaga como estava, nunca por cima de algo que surgiu nela.
    try {
      if (!fs.lstatSync(authFile, { throwIfNoEntry: false })) fs.renameSync(stash, authFile);
    } catch {
      // O temporário fica no ~/.codex (0600): perder a sessão seria pior.
    }
    return keepError;
  }
  // Fora da janela do temporário: o home gerenciado da dona recebe a cópia guardada.
  if (owner) fileSubscriptionAuthEnv(owner);
  return { ok: true };
}

/**
 * Fim de um login do Codex, com ou sem sessão nova. Vaga ocupada (login
 * concluído) nunca é sobrescrita: só encerra o pendente. Vaga vazia recebe a
 * sessão anterior; se a conta dona renovou a linhagem nesse meio-tempo (pane ou
 * sonda no home gerenciado), volta a cópia renovada, porque a guardada já
 * estaria consumida. Falha mantém a cópia em memória para uma nova tentativa.
 */
export function restoreCodexNativeLogin(): CodexLoginRestore {
  const vacated = vacatedCodexNative;
  if (!vacated) return 'none';
  try {
    if (fs.lstatSync(vacated.authFile, { throwIfNoEntry: false })) {
      vacatedCodexNative = null;
      return 'slot-taken';
    }
    if (vacated.linkTarget) {
      fs.symlinkSync(vacated.linkTarget, vacated.authFile);
    } else {
      let blob = vacated.blob;
      const owner = authBlobIsUsable('codex', blob) ? credentialIdentityOwner('codex', blob) : null;
      if (owner) {
        const renewed = accountCredentialCandidates('codex', owner.id, getSecret(CRED_PREFIX + owner.id))[0];
        if (renewed && compareAuthBlobIdentity('codex', renewed, blob) === 'same' &&
            (compareAuthFreshness(renewed, blob) ?? 0) > 0) blob = renewed;
      }
      // `wx`: um login que terminou agora vence; nada segue link plantado.
      fs.writeFileSync(vacated.authFile, blob, { mode: 0o600, flag: 'wx' });
    }
    vacatedCodexNative = null;
    return 'restored';
  } catch {
    return 'failed';
  }
}

/** @deprecated Prefer addActiveSessionAccount('claude', label). */
export function addActiveClaudeAccount(label: string): Account | null {
  return addActiveSessionAccount('claude', label);
}

function nativeSessionMatchesAccount(
  adapterId: string,
  account: Account,
): boolean {
  if (account.adapterId !== adapterId) return false;
  if (adapterId === 'claude') {
    const nativeEmail = activeClaudeEmail();
    if (nativeEmail && account.email && emailsEqual(account.email, nativeEmail)) {
      return true;
    }
    const nativeBlob =
      readActiveClaudeCredentialSlim() ?? readActiveClaudeCredential();
    return Boolean(
      nativeBlob && getSecret(CRED_PREFIX + account.id) === nativeBlob,
    );
  }
  if (!isFileAuthAdapter(adapterId)) return false;
  const capture = captureNativeAuth(adapterId);
  if (!capture) return false;
  if (
    capture.email &&
    account.email &&
    emailsEqual(account.email, capture.email)
  ) {
    return true;
  }
  return getSecret(CRED_PREFIX + account.id) === capture.blob;
}

/**
 * When the vault has no spawnable sibling, the live CLI login (Keychain or
 * native auth.json) may still be a different, ready identity. Snapshot it
 * into the registry and return it so failover can pin conta 2.
 * Returns null when the native session is missing or is the exhausted account.
 */
export function adoptNativeAccountForFailover(
  adapterId: string,
  excludeId: string | null,
): Account | null {
  const excluded = excludeId ? getAccount(excludeId) : null;
  if (excluded && nativeSessionMatchesAccount(adapterId, excluded)) {
    return null;
  }
  try {
    if (adapterId === 'claude') {
      const nativeEmail = activeClaudeEmail();
      if (!nativeEmail) return null;
      const existing = listAccounts(adapterId).find(
        (account) =>
          account.id !== excludeId &&
          account.email &&
          emailsEqual(account.email, nativeEmail),
      );
      if (existing) {
        return isAccountBlockedForScope(existing.id) ? null : existing;
      }
      return addActiveSessionAccount(adapterId, nativeEmail);
    }
    if (!isFileAuthAdapter(adapterId)) return null;
    const capture = captureNativeAuth(adapterId);
    if (!capture) return null;
    const existing = listAccounts(adapterId).find(
      (account) =>
        account.id !== excludeId &&
        ((capture.email &&
          account.email &&
          emailsEqual(account.email, capture.email)) ||
          getSecret(CRED_PREFIX + account.id) === capture.blob),
    );
    if (existing) {
      return isAccountBlockedForScope(existing.id) ? null : existing;
    }
    return addActiveSessionAccount(adapterId, capture.email ?? adapterId);
  } catch (error) {
    console.warn('[accounts] native failover adopt failed:', error);
    return null;
  }
}

export function renameAccount(id: string, label: string): void {
  const account = accounts.get(id);
  if (!account) return;
  const nextAccounts = new Map(accounts);
  nextAccounts.set(id, { ...account, label });
  persistSnapshot(nextAccounts, activeByAdapter, 'rename');
  replaceMap(accounts, nextAccounts);
  emit();
}

export function removeAccount(id: string): void {
  const account = accounts.get(id);
  if (!account) return;
  const database = requireWritableDb();
  const secretKey =
    account.mode === 'subscription' ? CRED_PREFIX + id : KEY_PREFIX + id;
  const previousSecret = getSecret(secretKey);
  const secretDeletion = deleteSecret(secretKey);
  if (!secretDeletion.ok) {
    throw new PersistenceUnavailableError(
      secretDeletion.error ?? 'failed to delete account credential durably',
    );
  }
  try {
    database.prepare('DELETE FROM accounts WHERE id = ?').run(id);
    database
      .prepare('DELETE FROM account_cooldown_blocks WHERE account_id = ?')
      .run(id);
  } catch (error) {
    if (previousSecret !== null) {
      const restore = setSecret(secretKey, previousSecret);
      if (!restore.ok) {
        readOnly = true;
        db = null;
        throw new PersistenceUnavailableError(
          'account deletion failed and credential rollback was not durable',
        );
      }
    }
    failPersistence('delete', error);
  }

  accounts.delete(id);
  cooldownBlocks.delete(id);
  if (activeByAdapter.get(account.adapterId) === id) {
    activeByAdapter.delete(account.adapterId);
  }
  if (isFileAuthAdapter(account.adapterId)) {
    removeManagedHome(account.adapterId, id);
  } else if (account.adapterId === 'claude' && hasManagedClaudeAuth(id)) {
    removeManagedClaudeAuth(id);
  }
  emit();
}

export function activateAccount(id: string): boolean {
  const account = accounts.get(id);
  if (!account) return false;
  if (isClaudeIdentityMismatch(account)) return false;
  requireWritableDb();
  // Preserve refreshed native credentials, but selecting a Nexus account must
  // not replace the shared login underneath the operator's existing CLIs.
  if (account.mode === 'subscription') {
    const ready = account.adapterId === 'claude'
      ? subscriptionAuthEnv(account) !== null
      : ensureSubscriptionActive(account);
    if (!ready) return false;
  }
  // Se a conta tinha cooldown de auth ou erro de sessão, a ativação/sincronização
  // explícita pelo operador refuta o erro antigo:
  claudeRefreshFailedAt.delete(id);
  if (isAuthCooldownReason(account.lastError)) {
    clearCooldown(id, 'conta sincronizada pelo operador');
  }
  const nextActive = new Map(activeByAdapter);
  nextActive.set(account.adapterId, id);
  persistSnapshot(accounts, nextActive, 'activate');
  replaceMap(activeByAdapter, nextActive);
  emit();
  return true;
}

/** Adapters that support "save active session" subscription snapshots. */
export function supportsSessionSnapshot(adapterId: string): boolean {
  return supportsNativeSessionSnapshot(adapterId);
}

/** Grava/atualiza um bloco (SQLite primeiro, cache depois; fail-closed). */
function upsertCooldownBlock(
  id: string,
  scope: string,
  block: CooldownBlock,
): void {
  const database = requireWritableDb();
  try {
    database
      .prepare(
        `INSERT INTO account_cooldown_blocks
           (account_id, block_scope, blocked_until, reason, probe_after, probed_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, block_scope) DO UPDATE SET
           blocked_until = excluded.blocked_until,
           reason        = excluded.reason,
           probe_after   = excluded.probe_after,
           probed_at     = excluded.probed_at`,
      )
      .run(
        id,
        scope,
        block.blockedUntil,
        block.reason,
        block.probeAfter,
        block.probedAt ?? null,
      );
  } catch (error) {
    failPersistence('cooldown block', error);
  }
  const byScope = cooldownBlocks.get(id) ?? new Map<string, CooldownBlock>();
  byScope.set(scope, block);
  cooldownBlocks.set(id, byScope);
}

/**
 * Limpa o cooldown GLOBAL de uma conta refutado por evidência (leitura
 * provider-api fresca e saudável) — resíduo da cascata de limite fantasma.
 * Blocos escopados (tier:*) ficam: refutação account-wide não desprova um
 * limite por tier.
 */
export function clearRefutedAuthCooldown(
  id: string,
  adapterId: string,
  note = 'sessão confirmada por leitura provider-api',
): boolean {
  const account = accounts.get(id);
  if (!account || account.adapterId !== adapterId || !isAuthCooldownReason(account.lastError)) return false;
  const globalBlock = cooldownBlocks.get(id)?.get(GLOBAL_SCOPE);
  if (globalBlock && globalBlock.blockedUntil > Date.now() && !isAuthCooldownReason(globalBlock.reason)) return false;
  return clearCooldown(id, note);
}

export function clearCooldown(id: string, note: string): boolean {
  const account = accounts.get(id);
  if (!account) return false;
  const now = Date.now();
  const globalBlock = cooldownBlocks.get(id)?.get(GLOBAL_SCOPE);
  const hasLegacyCooldown =
    account.cooldownUntil !== undefined && account.cooldownUntil > now;
  const hasActiveBlock =
    globalBlock !== undefined && globalBlock.blockedUntil > now;
  if (!hasLegacyCooldown && !hasActiveBlock) return false;
  const nextAccounts = new Map(accounts);
  nextAccounts.set(id, {
    ...account,
    cooldownUntil: undefined,
    lastError: note,
  });
  persistSnapshot(nextAccounts, activeByAdapter, 'cooldown-cleared');
  if (globalBlock) {
    // Expira o bloco espelhado em vez de deletar: histórico de reason fica.
    upsertCooldownBlock(id, GLOBAL_SCOPE, {
      ...globalBlock,
      blockedUntil: now,
      reason: note,
    });
  }
  replaceMap(accounts, nextAccounts);
  emit();
  return true;
}

/**
 * Coloca a conta em cooldown. Sem `scope`: bloco GLOBAL — comportamento
 * legado intacto (cooldownUntil/lastError na linha da conta, last-write-wins)
 * + bloco espelhado com probeAfter. Com `scope` (ex.: 'tier:opus'): a conta
 * segue no pool para outros modelos; só o bloco escopado é registrado, com
 * max() de expiração (um retry-after curto não encurta um bloco longo).
 */
export function setCooldown(
  id: string,
  until: number,
  reason: string,
  scope?: string,
): void {
  const account = accounts.get(id);
  if (!account) return;
  const now = Date.now();
  const blockScope = scope ?? GLOBAL_SCOPE;
  const existing = cooldownBlocks.get(id)?.get(blockScope);
  const blockedUntil =
    blockScope === GLOBAL_SCOPE
      ? until
      : Math.max(existing?.blockedUntil ?? 0, until);
  const block: CooldownBlock = {
    blockedUntil,
    reason,
    // Nova marcação abre nova janela de sondagem (probedAt limpo).
    probeAfter: Math.min(blockedUntil, now + PROBE_AFTER_MAX_MS),
  };
  const nextAccounts = new Map(accounts);
  nextAccounts.set(
    id,
    blockScope === GLOBAL_SCOPE
      ? { ...account, cooldownUntil: until, lastError: reason }
      : { ...account, lastError: reason },
  );
  persistSnapshot(nextAccounts, activeByAdapter, 'cooldown');
  upsertCooldownBlock(id, blockScope, block);
  replaceMap(accounts, nextAccounts);
  emit();
}

export function listAccountInfos(): AccountInfo[] {
  const now = Date.now();
  return listAccounts().map((a) => {
    const hasAuthError = isAuthCooldownReason(a.lastError);
    const hasActiveCooldown = Boolean(a.cooldownUntil && a.cooldownUntil > now);
    const hasActiveAuthCooldown = hasActiveCooldown && hasAuthError;
    const authFailure =
      hasActiveAuthCooldown || hasRecentClaudeRefreshFailure(a.id, now);

    return {
      ...a,
      active: activeByAdapter.get(a.adapterId) === a.id,
      hasCredential:
        a.mode === 'api-key'
          ? hasSecret(KEY_PREFIX + a.id)
          : hasSecret(CRED_PREFIX + a.id),
      // onCooldown é apenas para limite real de cota / rate-limit — nunca para erro de auth/login:
      onCooldown: hasActiveCooldown && !hasAuthError,
      // needsRelogin indica sessão expirada / 401 / refresh morto:
      needsRelogin: authFailure,
    };
  });
}
