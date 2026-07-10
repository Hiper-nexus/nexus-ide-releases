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
import { chooseAccount } from './account-select';

/**
 * Account registry with per-adapter active selection and failover-aware
 * pick-next. Metadata lives in SQLite; secrets (api keys, Claude credential
 * blobs) live in the encrypted vault keyed by account id. In-memory map is the
 * source of truth for the running process.
 */

const KEY_PREFIX = 'acctkey:'; // api-key accounts
const CRED_PREFIX = 'acctcred:'; // subscription credential blobs

const accounts = new Map<string, Account>();
const activeByAdapter = new Map<string, string>();
let db: Db | null = null;
let counter = 0;
const listeners = new Set<() => void>();

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
  accounts.clear();
  activeByAdapter.clear();
  activeHydrated = false;
  if (!db) return;
  try {
    for (const row of db.prepare('SELECT * FROM accounts').all() as Row[]) {
      accounts.set(row.id, {
        id: row.id,
        adapterId: row.adapter_id,
        label: row.label,
        mode: row.mode as AccountMode,
        upstream: row.upstream,
        email: row.email ?? undefined,
        cooldownUntil: row.cooldown_until ?? undefined,
        lastError: row.last_error ?? undefined,
        createdAt: row.created_at,
      });
      (accounts.get(row.id) as Account & { _active?: boolean })._active =
        row.active === 1;
    }
  } catch (err) {
    console.warn('[accounts] failed to hydrate:', err);
  }
}

function persist(account: Account, active: boolean): void {
  if (!db) return;
  try {
    db.prepare(
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
  } catch (err) {
    console.warn('[accounts] failed to persist:', err);
  }
}

function persistAll(): void {
  for (const account of accounts.values()) {
    persist(account, activeByAdapter.get(account.adapterId) === account.id);
  }
}

// Rebuild activeByAdapter from the hydrated _active flags on first use.
let activeHydrated = false;
function ensureActiveHydrated(): void {
  if (activeHydrated) return;
  activeHydrated = true;
  for (const account of accounts.values()) {
    if ((account as Account & { _active?: boolean })._active) {
      activeByAdapter.set(account.adapterId, account.id);
    }
  }
}

export function listAccounts(adapterId?: string): Account[] {
  ensureActiveHydrated();
  const all = [...accounts.values()].sort((a, b) => a.createdAt - b.createdAt);
  return adapterId ? all.filter((a) => a.adapterId === adapterId) : all;
}

export function getActiveAccount(adapterId: string): Account | null {
  ensureActiveHydrated();
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

/** Ensure a subscription account's credential is the active Claude session. */
export function ensureSubscriptionActive(account: Account): boolean {
  if (account.mode !== 'subscription') return true;
  const blob = getSecret(CRED_PREFIX + account.id);
  if (!blob) return false;
  return writeActiveClaudeCredential(blob);
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
): Account | null {
  ensureActiveHydrated();
  return chooseAccount(
    listAccounts(adapterId),
    activeByAdapter.get(adapterId) ?? null,
    excludeId,
    now,
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
  const account: Account = {
    id: makeId(),
    adapterId: input.adapterId,
    label: input.label,
    mode: input.mode,
    upstream: input.upstream ?? 'anthropic',
    createdAt: Date.now(),
  };
  accounts.set(account.id, account);
  if (input.mode === 'api-key' && input.key) {
    setSecret(KEY_PREFIX + account.id, input.key);
  }
  // A newly saved account is the user's immediate intent; make it the active
  // spawn source and persist every other account as inactive for this adapter.
  activeByAdapter.set(account.adapterId, account.id);
  persistAll();
  emit();
  return account;
}

/**
 * Snapshot the CURRENTLY signed-in Claude session into a subscription account
 * (ai-launcher `conta_save`). The user logs into Claude, then clicks "salvar
 * conta ativa" — we capture the keychain blob into the vault.
 */
export function addActiveClaudeAccount(label: string): Account | null {
  const blob = readActiveClaudeCredential();
  if (!blob) return null;
  const account: Account = {
    id: makeId(),
    adapterId: 'claude',
    label,
    mode: 'subscription',
    upstream: 'anthropic',
    email: activeClaudeEmail() ?? undefined,
    createdAt: Date.now(),
  };
  accounts.set(account.id, account);
  setSecret(CRED_PREFIX + account.id, blob);
  activeByAdapter.set('claude', account.id);
  persistAll();
  emit();
  return account;
}

export function renameAccount(id: string, label: string): void {
  const account = accounts.get(id);
  if (!account) return;
  accounts.set(id, { ...account, label });
  persistAll();
  emit();
}

export function removeAccount(id: string): void {
  const account = accounts.get(id);
  if (!account) return;
  accounts.delete(id);
  deleteSecret(KEY_PREFIX + id);
  deleteSecret(CRED_PREFIX + id);
  if (activeByAdapter.get(account.adapterId) === id) {
    activeByAdapter.delete(account.adapterId);
  }
  try {
    db?.prepare('DELETE FROM accounts WHERE id = ?').run(id);
  } catch (err) {
    console.warn('[accounts] failed to delete row:', err);
  }
  emit();
}

export function activateAccount(id: string): boolean {
  const account = accounts.get(id);
  if (!account) return false;
  // Subscription accounts must swap the Claude keychain credential now.
  if (account.mode === 'subscription' && !ensureSubscriptionActive(account)) {
    return false;
  }
  activeByAdapter.set(account.adapterId, id);
  persistAll();
  emit();
  return true;
}

export function setCooldown(id: string, until: number, reason: string): void {
  const account = accounts.get(id);
  if (!account) return;
  accounts.set(id, { ...account, cooldownUntil: until, lastError: reason });
  persistAll();
  emit();
}

export function listAccountInfos(): AccountInfo[] {
  ensureActiveHydrated();
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
