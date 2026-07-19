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
  claudeBlobNeedsRefresh,
  refreshClaudeOauthBlob,
} from '../quota/claude-oauth-refresh';
import {
  captureNativeAuth,
  isFileAuthAdapter,
  managedHomeEnv,
  materializeManagedHome,
  readBackFresherAuth,
  removeManagedHome,
  setManagedAuthPersister,
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

/**
 * Claude read-back, mirroring readBackFresherAuth for file-backed providers:
 * the real Claude CLI rotates the refresh token on its own inside the native
 * "Claude Code-credentials" keychain item, so the vault snapshot goes stale.
 * When this account IS the current native login, re-capture the keychain blob
 * into the vault BEFORE any use of the vault snapshot — otherwise the next
 * materialize clobbers the live native session with a dead credential (the
 * mid-session logout production bug). Best-effort/fail-safe: an unreadable
 * keychain or a failed vault write keeps the existing snapshot and never
 * breaks activate/spawn.
 */
function syncClaudeBlobFromKeychainIfNative(account: Account): void {
  if (account.adapterId !== 'claude' || account.mode !== 'subscription') return;
  const nativeEmail = activeClaudeEmail();
  if (
    !nativeEmail ||
    !account.email ||
    nativeEmail.trim().toLowerCase() !== account.email.trim().toLowerCase()
  ) {
    return;
  }
  const nativeBlob = readActiveClaudeCredential();
  if (!nativeBlob) return; // Keychain unreadable → keep the vault snapshot.
  if (getSecret(CRED_PREFIX + account.id) === nativeBlob) return; // In sync.
  const saved = setSecret(CRED_PREFIX + account.id, nativeBlob);
  if (!saved.ok) {
    console.warn(
      '[accounts] claude keychain read-back persist failed:',
      saved.error,
    );
  }
}

/**
 * Materialize a subscription credential for the active/global path.
 * Claude → Keychain; file-backed providers → managed home under ~/.nexus.
 */
export function ensureSubscriptionActive(account: Account): boolean {
  if (account.mode !== 'subscription') return true;
  // Claude: read the native keychain back into the vault first — writing a
  // stale snapshot over the CLI-rotated session kills the live login.
  syncClaudeBlobFromKeychainIfNative(account);
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
  // Same read-back contract as ensureSubscriptionActive: never build an env
  // from a stale vault snapshot when the native lineage has moved on.
  syncClaudeBlobFromKeychainIfNative(account);
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
  options?: { allowCoolingProbe?: boolean },
): AccountSpawnPreparation {
  const account = getAccount(accountId);
  if (!account || account.adapterId !== adapterId) {
    return {
      ok: false,
      error: 'selected account does not belong to this provider',
    };
  }

  if (
    !options?.allowCoolingProbe &&
    account.cooldownUntil &&
    account.cooldownUntil > now
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

  // Claude (and any future token-env providers).
  // Conta pinada que É o login nativo do Keychain: NENHUM token env — o pane
  // usa a linhagem compartilhada, que o CLI refresca sozinho. O env era um
  // snapshot estático do vault: expirava em horas e o CLI não refresca token
  // de env → "401 OAuth access token has expired" no respawn de failover
  // (caso de campo). Env token fica só para contas SECUNDÁRIAS, cuja
  // linhagem vive apenas no vault (e é renovada pelo freshness sweeper).
  const nativeEmail = activeClaudeEmail();
  if (
    nativeEmail &&
    account.email &&
    nativeEmail.trim().toLowerCase() === account.email.trim().toLowerCase()
  ) {
    return { ok: true, account, apiKey: null, authEnv: {} };
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

const claudeRefreshInFlight = new Set<string>();

/**
 * Renova o blob OAuth de uma conta Claude SECUNDÁRIA perto de expirar e grava
 * o resultado (refresh token rotacionado) de volta no vault. A conta que é o
 * login nativo do Keychain NUNCA é renovada por aqui — rotacionar a linhagem
 * compartilhada derrubaria a sessão do CLI real. Best-effort: nunca lança.
 */
export async function ensureFreshClaudeSubscription(
  accountId: string,
  now = Date.now(),
  refreshImpl: (
    blob: string,
    now: number,
  ) => Promise<string | null> = refreshClaudeOauthBlob,
): Promise<boolean> {
  const account = accounts.get(accountId);
  if (!account || account.adapterId !== 'claude') return false;
  const nativeEmail = activeClaudeEmail();
  if (
    nativeEmail &&
    account.email &&
    nativeEmail.trim().toLowerCase() === account.email.trim().toLowerCase()
  ) {
    return false;
  }
  const blob = getSecret(CRED_PREFIX + accountId);
  if (typeof blob !== 'string' || !blob) return false;
  if (!claudeBlobNeedsRefresh(blob, now)) return false;
  if (claudeRefreshInFlight.has(accountId)) return false;
  claudeRefreshInFlight.add(accountId);
  try {
    const updated = await refreshImpl(blob, now);
    if (!updated) return false;
    setSecret(CRED_PREFIX + accountId, updated);
    console.info('[accounts] claude oauth renovado para conta', account.label);
    return true;
  } catch {
    return false;
  } finally {
    claudeRefreshInFlight.delete(accountId);
  }
}

/**
 * Sweeper de frescor: mantém os tokens das contas Claude secundárias válidos
 * para que qualquer spawn/failover encontre credencial viva no vault.
 */
export function startClaudeSubscriptionFreshness(
  intervalMs = 15 * 60 * 1000,
): () => void {
  const tick = (): void => {
    for (const account of listAccounts('claude')) {
      // Read-back for the native lineage (keychain → vault): the CLI rotates
      // it on its own. Distinct from the refresh skip in
      // ensureFreshClaudeSubscription — we never ROTATE the native account,
      // but we do track its rotation so the vault snapshot stays restorable.
      syncClaudeBlobFromKeychainIfNative(account);
      void ensureFreshClaudeSubscription(account.id);
    }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
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

/**
 * Whether `adapterId` has at least one account able to serve a spawn now.
 * Adapters with no Nexus-managed accounts (omp self-manages auth under
 * ~/.omp) report available — third-party auth state is not ours to judge.
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

export interface FailoverPickOptions {
  /** Escopo do spawn alvo (ex.: 'tier:opus'); ausente = só blocos globais. */
  scope?: string;
  /**
   * Habilita a sondagem last-resort: quando nada está livre, uma conta cujo
   * bloco tem probeAfter vencido e ainda não foi sondado nesta janela é
   * devolvida com `probe: true` (e a sondagem é consumida na hora).
   */
  allowProbe?: boolean;
}

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
  const siblings = listAccounts(adapterId).filter((a) => a.id !== excludeId);
  const free = siblings.filter((a) => !effectiveBlock(a, now, options?.scope));
  const chosen = chooseAccount(
    free,
    activeByAdapter.get(adapterId) ?? null,
    excludeId,
    now,
    quotaScoreByAccountId,
  );
  if (chosen) return { account: chosen, probe: false };

  let nextUnblockAtMs: number | undefined;
  const blocked: Array<{ account: Account; entry: EffectiveBlock }> = [];
  for (const sibling of siblings) {
    const entry = effectiveBlock(sibling, now, options?.scope);
    if (!entry) continue;
    blocked.push({ account: sibling, entry });
    if (
      nextUnblockAtMs === undefined ||
      entry.block.blockedUntil < nextUnblockAtMs
    ) {
      nextUnblockAtMs = entry.block.blockedUntil;
    }
  }

  if (options?.allowProbe) {
    const probeCandidate = blocked
      .filter(
        ({ entry }) =>
          entry.block.probeAfter <= now && entry.block.probedAt === undefined,
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
  }
  emit();
}

export function activateAccount(id: string): boolean {
  const account = accounts.get(id);
  if (!account) return false;
  requireWritableDb();
  // Sync the OUTGOING native Claude account (keychain → vault) BEFORE
  // overwriting the keychain with the target blob below: the CLI has rotated
  // the native lineage since our snapshot, and only a fresh vault snapshot
  // makes a later switch back restore a live credential. Order matters.
  for (const other of accounts.values()) {
    if (other.id !== id) syncClaudeBlobFromKeychainIfNative(other);
  }
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
export function clearCooldown(id: string, note: string): void {
  const account = accounts.get(id);
  if (!account) return;
  const now = Date.now();
  const globalBlock = cooldownBlocks.get(id)?.get(GLOBAL_SCOPE);
  const hasLegacyCooldown =
    account.cooldownUntil !== undefined && account.cooldownUntil > now;
  const hasActiveBlock =
    globalBlock !== undefined && globalBlock.blockedUntil > now;
  if (!hasLegacyCooldown && !hasActiveBlock) return;
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
