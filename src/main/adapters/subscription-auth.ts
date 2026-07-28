import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { ompModelAuthRoute } from './model-auth-readiness';
import {
  claudeCredentialBlobIsUsable,
  readActiveClaudeCredential,
} from './claude-credential';

/**
 * Subscription-auth priority (user directive): CLIs signed in via their own
 * subscription/OAuth (Claude Max, Codex/ChatGPT, AGY, Kimi, Grok…) must ALWAYS
 * use that auth; a stored API key is only a FALLBACK for when no subscription
 * auth exists. Injecting e.g. ANTHROPIC_API_KEY into an OAuth-authenticated
 * Claude pane would silently hijack billing from the subscription to the API —
 * so when the subscription is active we also SUPPRESS inherited key env vars.
 */

export type AuthStrategy = 'subscription' | 'api-key' | 'login-needed';

export interface AuthDecision {
  strategy: AuthStrategy;
  /** Inject the stored API key env var into the pane. */
  injectKey: boolean;
  /** Strip key/token env vars so nothing overrides the subscription. */
  suppressKeyEnv: boolean;
}

/** Pure decision core — unit tested. */
export function resolveAuthStrategy(input: {
  authMethod: string;
  hasStoredKey: boolean;
  subscriptionAuthed: boolean;
}): AuthDecision {
  // A live CLI-managed login session ALWAYS wins, regardless of the adapter's
  // declared auth.method. Every CLI here (claude/codex/grok/agy/kimi…)
  // logs in on its own — codex via ChatGPT, grok via ~/.grok/auth.json, etc. —
  // so if we detect that session we must honor it and never inject a key over
  // it (that would divert billing from the plan to the API). Gating on
  // authMethod==='api_key' first (the old bug) made codex/grok show a false
  // "login pendente" even while fully signed in.
  if (input.subscriptionAuthed) {
    return { strategy: 'subscription', injectKey: false, suppressKeyEnv: true };
  }
  // No detected session but we hold a stored key → use it as the fallback.
  if (input.hasStoredKey) {
    return { strategy: 'api-key', injectKey: true, suppressKeyEnv: false };
  }
  // Nothing detected: the CLI itself will prompt /login on first run.
  return { strategy: 'login-needed', injectKey: false, suppressKeyEnv: false };
}

// ---------------------------------------------------------------------------
// Subscription-session detectors (ported from the ai-launcher account model).
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { value: boolean; at: number }>();
let claudeRefreshInFlight: Promise<ClaudeAuthRefreshResult> | null = null;

export interface SubscriptionAuthDetectionOptions {
  /**
   * The macOS Keychain fallback is intentionally opt-out. Spawn/readiness
   * callers retain the authoritative probe, while renderer snapshots can
   * explicitly stay on the non-blocking metadata path.
   */
  probeClaudeKeychain?: boolean;
  /** Test seam for proving that a non-blocking caller never enters Keychain. */
  claudeKeychainProbe?: () => boolean;
}

export interface ClaudeAuthRefreshResult {
  value: boolean;
  cacheUpdated: boolean;
}

function subscriptionCacheKey(adapterId: string, model?: string): string {
  return adapterId === 'omp' || adapterId === 'omp-rpc'
    ? `${adapterId}\u0000${model?.trim() ?? ''}`
    : adapterId;
}

function cachedSubscriptionAuth(
  adapterId: string,
  model?: string,
): boolean | null {
  const hit = cache.get(subscriptionCacheKey(adapterId, model));
  return hit && Date.now() - hit.at < CACHE_TTL_MS ? hit.value : null;
}

function cacheSubscriptionAuth(
  adapterId: string,
  value: boolean,
  model?: string,
): void {
  cache.set(subscriptionCacheKey(adapterId, model), {
    value,
    at: Date.now(),
  });
}

function existsAt(home: string, ...segments: string[]): boolean {
  try {
    fs.statSync(path.join(home, ...segments));
    return true;
  } catch {
    return false;
  }
}

/** Claude Code stores its OAuth session in the login keychain on macOS. */
export function claudeKeychainHas(
  execImpl: typeof execFileSync = execFileSync,
): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    execImpl(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials'],
      {
        stdio: 'pipe',
        timeout: 5_000,
        killSignal: 'SIGKILL',
      },
    );
    return true;
  } catch {
    // Keychain can fail inside packaged Electron (TCC) even when the CLI works.
    return false;
  }
}

/**
 * Non-blocking equivalent for UI/readiness refreshes. `security` may still
 * wait on a locked login keychain, but its process and deadline never block
 * Electron's main event loop.
 */
export function claudeKeychainHasAsync(
  execImpl: typeof execFile = execFile,
): Promise<boolean> {
  if (process.platform !== 'darwin') return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      execImpl(
        'security',
        ['find-generic-password', '-s', 'Claude Code-credentials'],
        {
          timeout: 5_000,
          killSignal: 'SIGKILL',
          windowsHide: true,
        },
        (error) => resolve(error === null),
      );
    } catch {
      resolve(false);
    }
  });
}

/** Email of the active Claude OAuth account from ~/.claude.json, if any.
 *  Identity only — not proof of a live session (see detectSubscriptionAuth). */
export function claudeOauthEmail(home = os.homedir()): string | null {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(home, '.claude.json'), 'utf8'),
    ) as { oauthAccount?: { emailAddress?: unknown } };
    const email = raw?.oauthAccount?.emailAddress;
    return typeof email === 'string' && email.includes('@') ? email : null;
  } catch {
    return null;
  }
}

/**
 * Linux/headless Claude credentials file with a non-empty OAuth access token.
 * File presence alone is not enough (empty shells after logout).
 */
export function claudeCredentialsFileIsUsable(home = os.homedir()): boolean {
  try {
    const raw = fs.readFileSync(
      path.join(home, '.claude', '.credentials.json'),
      'utf8',
    );
    const parsed = JSON.parse(raw) as {
      claudeAiOauth?: { accessToken?: unknown };
    };
    const token = parsed.claudeAiOauth?.accessToken;
    return typeof token === 'string' && token.length > 0;
  } catch {
    return false;
  }
}

/** True when ~/.gemini/oauth_creds.json has a non-empty access or refresh token. */
export function agyOauthCredsFileIsUsable(home = os.homedir()): boolean {
  const candidates = [
    path.join(home, '.gemini', 'oauth_creds.json'),
  ];
  const custom = process.env.GEMINI_CLI_HOME?.trim();
  if (custom) {
    candidates.unshift(path.join(custom, 'oauth_creds.json'));
  }
  for (const filePath of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
        access_token?: unknown;
        refresh_token?: unknown;
      };
      const access =
        typeof parsed.access_token === 'string'
          ? parsed.access_token.trim()
          : '';
      const refresh =
        typeof parsed.refresh_token === 'string'
          ? parsed.refresh_token.trim()
          : '';
      if (access.length > 0 || refresh.length > 0) return true;
    } catch {
      // try next
    }
  }
  return false;
}

/** True when google_accounts.json names a live active account email. */
export function agyGoogleAccountIsActive(home = os.homedir()): boolean {
  const candidates = [path.join(home, '.gemini', 'google_accounts.json')];
  const custom = process.env.GEMINI_CLI_HOME?.trim();
  if (custom) {
    candidates.unshift(path.join(custom, 'google_accounts.json'));
  }
  for (const filePath of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
        active?: unknown;
      };
      if (typeof parsed.active === 'string' && parsed.active.includes('@')) {
        return true;
      }
    } catch {
      // try next
    }
  }
  return false;
}


function existsInEnv(envVar: string, ...segments: string[]): boolean {
  const customHome = process.env[envVar]?.trim();
  if (customHome) {
    try {
      fs.statSync(path.join(customHome, ...segments));
      return true;
    } catch {
      // Missing/inaccessible custom home → not authenticated there.
    }
  }
  return false;
}

/**
 * Kimi's credentials file can exist with non-empty but expired tokens. A
 * refresh token alone is not proof of a live login: the CLI may reject it and
 * erase the copied isolated credentials. Require an access token with a
 * declared expiry more than five minutes away so UI readiness and release
 * staging never advertise a dead session.
 */
export function kimiCredentialsBlobIsUsable(
  blob: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  try {
    const parsed = JSON.parse(blob) as {
      access_token?: unknown;
      expires_at?: unknown;
    };
    const access =
      typeof parsed.access_token === 'string' ? parsed.access_token.trim() : '';
    const rawExpiry = Number(parsed.expires_at);
    if (!access || !Number.isFinite(rawExpiry) || rawExpiry <= 0) return false;
    const expirySeconds =
      rawExpiry >= 1_000_000_000_000
        ? Math.floor(rawExpiry / 1000)
        : Math.floor(rawExpiry);
    return expirySeconds - nowSeconds > 5 * 60;
  } catch {
    return false;
  }
}

function kimiCredentialsFileIsUsable(filePath: string): boolean {
  try {
    return kimiCredentialsBlobIsUsable(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return false;
  }
}

function kimiHasUsableCredentials(home: string): boolean {
  const candidates = [
    path.join(home, '.kimi-code', 'credentials', 'kimi-code.json'),
    path.join(home, '.kimi', 'credentials', 'kimi-code.json'),
    path.join(home, '.config', 'kimi', 'credentials.json'),
  ];
  const customHome = process.env.KIMI_CODE_HOME?.trim();
  if (customHome) {
    candidates.unshift(
      path.join(customHome, 'credentials', 'kimi-code.json'),
    );
  }
  return candidates.some((file) => kimiCredentialsFileIsUsable(file));
}

/**
 * OMP owns its credential vault in a local SQLite database. Read only exact
 * provider presence metadata — never credential payloads — so Nexus can
 * distinguish a usable broker route from an interactive-login dead end.
 *
 * The provider aliases are release-pinned by model-auth-readiness.ts. Unknown
 * model providers and older/newer DB layouts report unauthenticated until
 * reviewed.
 */
function ompHasEnabledCredentialForProviders(
  home: string,
  providerIds: readonly string[],
): boolean {
  if (providerIds.length === 0) return false;
  const databasePath = path.join(home, '.omp', 'agent', 'agent.db');
  if (!existsAt(home, '.omp', 'agent', 'agent.db')) return false;
  type ReadonlyDatabase = {
    pragma(source: string, options?: { simple?: boolean }): unknown;
    prepare(source: string): { get(...params: string[]): unknown };
    close(): void;
  };
  let database: ReadonlyDatabase | null = null;
  try {
    const Database = require('better-sqlite3') as new (
      file: string,
      options: { readonly: boolean; fileMustExist: boolean },
    ) => ReadonlyDatabase;
    database = new Database(databasePath, {
      readonly: true,
      fileMustExist: true,
    });
    database.pragma('query_only = ON');
    if (database.pragma('query_only', { simple: true }) !== 1) {
      return false;
    }
    const placeholders = providerIds.map(() => '?').join(', ');
    const row = database
      .prepare(
        `SELECT 1 AS ready
           FROM auth_credentials
          WHERE provider IN (${placeholders})
            AND (disabled_cause IS NULL OR disabled_cause = '')
          LIMIT 1`,
      )
      .get(...providerIds) as { ready?: unknown } | undefined;
    return row?.ready === 1;
  } catch {
    return false;
  } finally {
    try {
      database?.close();
    } catch {
      // Read-only detection never owns recovery or mutation.
    }
  }
}

/**
 * Exact OMP broker readiness for one provider/model reference. A credential
 * for Anthropic is not evidence that OpenAI Codex, xAI or any other route can
 * start. Local release-pinned providers are credentialless by definition.
 */
export function isOmpVaultAuthReadyForModel(
  model: string | null | undefined,
  home = os.homedir(),
): boolean {
  const route = ompModelAuthRoute(model);
  if (!route) return false;
  if (route.credentialless) return true;
  return ompHasEnabledCredentialForProviders(
    home,
    route.brokerProviderIds,
  );
}

export function detectSubscriptionAuth(
  adapterId: string,
  home = os.homedir(),
  model?: string,
  options: SubscriptionAuthDetectionOptions = {},
): boolean {
  const exists = (...segments: string[]) => existsAt(home, ...segments);
  switch (adapterId) {
    case 'claude':
      // Live session = usable OAuth access token, not merely oauthAccount
      // email identity (email survives after OAuth expiry → false positive).
      // Prefer keychain secret (when allowed) or Linux credentials file.
      // Keychain *metadata* alone is insufficient: item can exist with a
      // dead blob. Cold UI paths may set probeClaudeKeychain:false and then
      // only the credentials-file path counts until async refresh runs.
      if (claudeCredentialsFileIsUsable(home)) return true;
      if (options.probeClaudeKeychain !== false) {
        if (options.claudeKeychainProbe) {
          // Test/injected probe: presence of the service (legacy seam).
          if (options.claudeKeychainProbe()) return true;
        } else if (home === os.homedir()) {
          // Authoritative path for the real operator home: require a usable
          // access token in the secret payload, not just the keychain item.
          const blob = readActiveClaudeCredential();
          if (claudeCredentialBlobIsUsable(blob)) return true;
        } else if (claudeKeychainHas()) {
          // Non-default home still cannot redirect macOS keychain; metadata
          // presence is the best we can do without spoofing another user.
          return true;
        }
      }
      return false;
    case 'codex':
      // ChatGPT session file (the launcher's xconta model swaps this file).
      return existsInEnv('CODEX_HOME', 'auth.json') || exists('.codex', 'auth.json');
    case 'grok':
      // The install itself creates ~/.grok. Only auth.json proves login.
      return existsInEnv('GROK_HOME', 'auth.json') || exists('.grok', 'auth.json');
    case 'glm':
      // GLM has no CLI-managed OAuth session — it authenticates purely with a
      // z.ai token injected as ANTHROPIC_AUTH_TOKEN. Force api-key strategy so
      // the token is actually injected (never suppressed as if a subscription
      // existed). Uses the Claude binary, but NOT the Claude subscription.
      return false;
    case 'longcat':
      // Same model as GLM: pure API-key route on the Claude binary, pointed
      // at the LongCat Anthropic-compatible endpoint. Never a subscription.
      return false;
    case 'agy':
      // Live OAuth only — never treat antigravity* install trees as login.
      // Installation dirs made google_accounts.active=null + leftover keychain
      // look "staged" in the release gate while the UI said "login new" and
      // disabled Usar este squad.
      return (
        agyOauthCredsFileIsUsable(home) ||
        agyGoogleAccountIsActive(home)
      );
    case 'kimi':
      // Require a non-empty access/refresh token. The zero-byte oauth marker
      // and the empty credentials shell both survive logout and must not
      // suppress API-key fallback or pass the release-gate staging probe.
      return kimiHasUsableCredentials(home);
    case 'opencode':
      // Official OpenCode docs use the XDG path. Keep the native macOS data
      // path as a compatibility probe for package-manager variants.
      return (
        existsInEnv('OPENCODE_HOME', 'auth.json') ||
        exists('.local', 'share', 'opencode', 'auth.json') ||
        exists('Library', 'Application Support', 'opencode', 'auth.json')
      );
    case 'omp':
    case 'omp-rpc':
      return isOmpVaultAuthReadyForModel(model, home);
    case 'aider':
      // Aider has no native OAuth/subscription session; it consumes provider
      // API keys. Treating its config directory as login would suppress every
      // injected key and leave the freshly installed CLI unusable.
      return false;
    default:
      // Unknown is not evidence of an authenticated session. Failing closed
      // prevents a false positive from suppressing a valid API key.
      return false;
  }
}

/** Whether the CLI has a live subscription/OAuth session (cached 60s). */
export function hasSubscriptionAuth(
  adapterId: string,
  model?: string,
): boolean {
  const hit = cachedSubscriptionAuth(adapterId, model);
  if (hit !== null) return hit;
  const value = detectSubscriptionAuth(adapterId, os.homedir(), model);
  cacheSubscriptionAuth(adapterId, value, model);
  return value;
}

/**
 * Presence view for renderer/provider snapshots.
 *
 * A cold Claude lookup uses only file metadata and the existing cache. It
 * deliberately does not cache a negative result: an immediate spawn still
 * performs the authoritative Keychain probe and cannot accidentally inject an
 * API key over a native subscription. The async refresher below later updates
 * the status snapshot without freezing the IPC request.
 */
export function hasSubscriptionAuthForStatus(
  adapterId: string,
  model?: string,
  home = os.homedir(),
): boolean {
  const hit = cachedSubscriptionAuth(adapterId, model);
  if (hit !== null) return hit;
  if (adapterId !== 'claude') return hasSubscriptionAuth(adapterId, model);

  const fileBacked = detectSubscriptionAuth(
    adapterId,
    home,
    model,
    { probeClaudeKeychain: false },
  );
  if (fileBacked) cacheSubscriptionAuth(adapterId, true, model);
  return fileBacked;
}

/**
 * Warm Claude's status cache outside the renderer's request-critical path.
 * Concurrent list calls share one `security` process. Failures remain
 * fail-closed and are cached for the normal short TTL.
 */
export function refreshClaudeSubscriptionAuthCache(
  home = os.homedir(),
  keychainProbe: () => Promise<boolean> = claudeKeychainHasAsync,
): Promise<ClaudeAuthRefreshResult> {
  const cached = cachedSubscriptionAuth('claude');
  if (cached !== null) {
    return Promise.resolve({ value: cached, cacheUpdated: false });
  }

  // credentials file with usable token — no keychain needed
  const fileBacked = detectSubscriptionAuth(
    'claude',
    home,
    undefined,
    { probeClaudeKeychain: false },
  );
  if (fileBacked) {
    cacheSubscriptionAuth('claude', true);
    return Promise.resolve({ value: true, cacheUpdated: true });
  }

  if (claudeRefreshInFlight) return claudeRefreshInFlight;
  // Prefer a usable secret payload on the real home; fall back to the
  // injected/async metadata probe for tests and TCC-limited environments.
  claudeRefreshInFlight = Promise.resolve()
    .then(async () => {
      if (home === os.homedir()) {
        const blob = readActiveClaudeCredential();
        if (claudeCredentialBlobIsUsable(blob)) return true;
      }
      return keychainProbe();
    })
    .catch(() => false)
    .then((value) => {
      cacheSubscriptionAuth('claude', value);
      return { value, cacheUpdated: true };
    })
    .finally(() => {
      claudeRefreshInFlight = null;
    });
  return claudeRefreshInFlight;
}

/** Test hook. */
export function resetSubscriptionAuthCacheForTests(): void {
  cache.clear();
  claudeRefreshInFlight = null;
}
