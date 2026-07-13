import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Db } from './db';
import type { Account, AccountInfo, AccountMode } from '../../shared/account-types';
import {
  deleteSecret,
  getSecret,
  hasSecret,
  setSecret,
} from './secrets-store';
import {
  activeClaudeEmail,
  readActiveClaudeCredential,
  writeActiveClaudeCredential,
} from '../adapters/claude-credential';
import {
  captureNativeAuth,
  isFileAuthAdapter,
  managedHomeEnv,
  materializeManagedHome,
  readBackFresherAuth,
  removeManagedHome,
  type FileAuthAdapterId,
} from '../adapters/managed-credentials';
import { chooseAccount } from './account-select';
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

const accounts = new Map<string, Account>();
const activeByAdapter = new Map<string, string>();
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

export function initAccountStore(database: Db | null): void {
  db = database;
  readOnly = true;
  if (!database) return;

  const hydratedAccounts = new Map<string, Account>();
  const hydratedActive = new Map<string, string>();
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
  } catch (error) {
    console.warn('[accounts] failed to hydrate; using read-only cache:', error);
    db = null;
    return;
  }

  replaceMap(accounts, hydratedAccounts);
  replaceMap(activeByAdapter, hydratedActive);
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

/**
 * Materialize a subscription credential for the active/global path.
 * Claude → Keychain; file-backed providers → managed home under ~/.nexus.
 */
export function ensureSubscriptionActive(account: Account): boolean {
  if (account.mode !== 'subscription') return true;
  const blob = getSecret(CRED_PREFIX + account.id);
  if (!blob) return false;
  if (account.adapterId === 'claude') {
    return writeActiveClaudeCredential(blob);
  }
  if (isFileAuthAdapter(account.adapterId)) {
    try {
      materializeManagedHome(
        account.adapterId as FileAuthAdapterId,
        account.id,
        blob,
      );
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
    // Persist CLI-refreshed tokens before materialize decides what to write.
    const fresher = readBackFresherAuth(adapterId, account.id, blob);
    if (fresher) {
      const saved = setSecret(CRED_PREFIX + account.id, fresher);
      if (saved.ok) blob = fresher;
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
function subscriptionAuthEnv(account: Account): Record<string, string> | null {
  const blob = getSecret(CRED_PREFIX + account.id);
  if (!blob) return null;
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
    if (typeof oauth.refreshToken === 'string' && oauth.refreshToken.length > 0) {
      env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN = oauth.refreshToken;
    }
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
  let blob = readActiveClaudeCredential();
  if (!blob) {
    try {
      blob = fs.readFileSync(
        path.join(os.homedir(), '.claude', '.credentials.json'),
        'utf8',
      );
    } catch {
      return null;
    }
  }
  return claudeAuthEnvFromBlob(blob);
}

/**
 * Resolve and activate the exact account pinned to a pane before its PTY is
 * created. This deliberately does not fall back to the provider's active
 * account: a pinned account is an isolation boundary, not a preference hint.
 */
export function prepareAccountForSpawn(
  adapterId: string,
  accountId: string,
  now = Date.now(),
): AccountSpawnPreparation {
  const account = getAccount(accountId);
  if (!account || account.adapterId !== adapterId) {
    return {
      ok: false,
      error: 'selected account does not belong to this provider',
    };
  }

  if (account.cooldownUntil && account.cooldownUntil > now) {
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

  // Claude (and any future token-env providers).
  const authEnv = subscriptionAuthEnv(account);
  if (!authEnv) {
    return {
      ok: false,
      error: `selected subscription "${account.label}" has no usable OAuth credential`,
    };
  }
  return { ok: true, account, apiKey: null, authEnv };
}

/**
 * Pick an available account for `adapterId`, excluding `excludeId` and any on
 * cooldown. Prefers the explicitly-active one; else the earliest created.
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
 * Snapshot the CURRENTLY signed-in CLI session into a subscription account.
 * Claude → Keychain blob; Codex/Grok/Kimi/… → native auth.json (Orca-style).
 */
export function addActiveSessionAccount(
  adapterId: string,
  label: string,
): Account | null {
  requireWritableDb();

  let blob: string | null = null;
  let email: string | undefined;

  if (adapterId === 'claude') {
    blob = readActiveClaudeCredential();
    email = activeClaudeEmail() ?? undefined;
  } else if (isFileAuthAdapter(adapterId)) {
    const capture = captureNativeAuth(adapterId);
    if (capture) {
      blob = capture.blob;
      email = capture.email;
    }
  } else {
    return null;
  }
  if (!blob) return null;

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

/** @deprecated Prefer addActiveSessionAccount('claude', label). */
export function addActiveClaudeAccount(label: string): Account | null {
  return addActiveSessionAccount('claude', label);
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
  if (activeByAdapter.get(account.adapterId) === id) {
    activeByAdapter.delete(account.adapterId);
  }
  if (isFileAuthAdapter(account.adapterId)) {
    removeManagedHome(account.adapterId, id);
  }
  emit();
}

export function activateAccount(id: string): boolean {
  const account = accounts.get(id);
  if (!account) return false;
  requireWritableDb();
  // Materialize subscription credential (keychain or managed home).
  if (account.mode === 'subscription' && !ensureSubscriptionActive(account)) {
    return false;
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
  return adapterId === 'claude' || isFileAuthAdapter(adapterId);
}

export function setCooldown(id: string, until: number, reason: string): void {
  const account = accounts.get(id);
  if (!account) return;
  const nextAccounts = new Map(accounts);
  nextAccounts.set(id, { ...account, cooldownUntil: until, lastError: reason });
  persistSnapshot(nextAccounts, activeByAdapter, 'cooldown');
  replaceMap(accounts, nextAccounts);
  emit();
}

export function listAccountInfos(): AccountInfo[] {
  const now = Date.now();
  return listAccounts().map((a) => ({
    ...a,
    active: activeByAdapter.get(a.adapterId) === a.id,
    hasCredential:
      a.mode === 'api-key'
        ? hasSecret(KEY_PREFIX + a.id)
        : hasSecret(CRED_PREFIX + a.id),
    onCooldown: Boolean(a.cooldownUntil && a.cooldownUntil > now),
  }));
}
