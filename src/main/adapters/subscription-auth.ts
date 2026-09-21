import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import {
  claudeCredentialBlobIsUsable,
  readActiveClaudeCredential,
} from './claude-credential';
import { realUserHome, resolveCliBinary } from '../path-resolver';
import { hasNativeFileAuth } from './managed-credentials';
import { openClaudeKeychainService, readNativeOAuthKeychain } from './native-oauth-keychain';
import {
  peekKimiSeatReadiness,
  type AuthReadiness,
} from './seat-auth-readiness';

/**
 * Subscription-auth priority (user directive): CLIs signed in via their own
 * subscription/OAuth (Claude Max, Codex/ChatGPT, AGY, Kimi, Grok…) must ALWAYS
 * use that auth; a stored API key is only a FALLBACK for when no subscription
 * auth exists. Injecting e.g. ANTHROPIC_API_KEY into an OAuth-authenticated
 * Claude pane would silently hijack billing from the subscription to the API —
 * so when the subscription is active we also SUPPRESS inherited key env vars.
 */

export type AuthStrategy =
  | 'credentialless'
  | 'subscription'
  | 'api-key'
  | 'login-needed';

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
  // A credentialless adapter is complete by definition. It must neither be
  // sent to a login screen nor inherit the subscription suppression list.
  if (input.authMethod === 'none') {
    return {
      strategy: 'credentialless',
      injectKey: false,
      suppressKeyEnv: false,
    };
  }
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
const AGY_AUTHORITATIVE_PROOF_TTL_MS = 5_000;
const cache = new Map<string, { value: boolean; at: number }>();
let claudeRefreshInFlight: Promise<ClaudeAuthRefreshResult> | null = null;
let openClaudeRefreshInFlight: Promise<ClaudeAuthRefreshResult> | null = null;
let agyRefreshInFlight: Promise<boolean> | null = null;

export interface SubscriptionAuthDetectionOptions {
  /**
   * The macOS Keychain fallback is intentionally opt-out. Spawn/readiness
   * callers retain the authoritative probe, while renderer snapshots can
   * explicitly stay on the non-blocking metadata path.
   */
  probeClaudeKeychain?: boolean;
  /** Test seam for proving that a non-blocking caller never enters Keychain. */
  claudeKeychainProbe?: () => boolean;
  /**
   * AGY's antigravity route keeps its session in the login keychain. Opt-out
   * for callers that must stay off the Keychain path entirely.
   */
  probeAgyKeychain?: boolean;
  /** Test seam mirroring `claudeKeychainProbe` for the AGY keychain route. */
  agyKeychainProbe?: () => boolean;
  probeOpenClaudeKeychain?: boolean;
  openClaudeKeychainProbe?: () => boolean;
}

export interface ClaudeAuthRefreshResult {
  value: boolean;
  cacheUpdated: boolean;
}

function subscriptionCacheKey(adapterId: string, model?: string): string {
  return model?.trim()
    ? `${adapterId}\u0000${model.trim()}`
    : adapterId;
}

function cachedSubscriptionAuth(
  adapterId: string,
  model?: string,
): boolean | null {
  const hit =
    cache.get(subscriptionCacheKey(adapterId, model)) ??
    (model?.trim() ? cache.get(adapterId) : undefined);
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
  timeoutMs = 5_000,
): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    execImpl(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials'],
      {
        stdio: 'pipe',
        timeout: timeoutMs,
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

function resolveClaudeBinary(): string | null {
  try {
    return resolveCliBinary('claude')?.binPath ?? null;
  } catch {
    return null;
  }
}

function parseClaudeAuthStatusLoggedIn(stdout: unknown): boolean {
  try {
    const parsed = JSON.parse(String(stdout)) as { loggedIn?: unknown };
    return parsed?.loggedIn === true;
  } catch {
    return false;
  }
}

/**
 * Ask the CLI itself (`claude auth status`) instead of reading its private
 * storage. Modern Claude Code on macOS is Keychain-only (no
 * ~/.claude/.credentials.json), and the packaged app can be denied the
 * Keychain secret read (TCC/ACL) while the CLI still owns a live session —
 * storage sniffing then reports a confident false "not logged in". The CLI
 * attesting `"loggedIn": true` is the authoritative positive signal; every
 * failure mode (missing binary, timeout, non-JSON, loggedIn:false) is a
 * silent false that falls through to the existing probes. Never throws.
 */
export function claudeCliAuthStatusLoggedInSync(
  execImpl: typeof execFileSync = execFileSync,
  bin: string | null = resolveClaudeBinary(),
  timeoutMs = 5_000,
): boolean {
  if (!bin) return false;
  try {
    const out = execImpl(bin, ['auth', 'status'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    });
    return parseClaudeAuthStatusLoggedIn(out);
  } catch {
    return false;
  }
}

/** Async variant for background warms (never blocks the main loop). */
export function claudeCliAuthStatusLoggedInAsync(
  execImpl: typeof execFile = execFile,
  bin: string | null = resolveClaudeBinary(),
  timeoutMs = 8_000,
): Promise<boolean> {
  if (!bin) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      execImpl(
        bin,
        ['auth', 'status'],
        {
          timeout: timeoutMs,
          killSignal: 'SIGKILL',
          windowsHide: true,
          encoding: 'utf8',
        },
        (error, stdout) => resolve(error === null && parseClaudeAuthStatusLoggedIn(stdout)),
      );
    } catch {
      resolve(false);
    }
  });
}

/**
 * Default native-session probe for the async Claude warm: Keychain secret
 * first, CLI attestation when the secret is missing OR unreadable (a TCC/ACL
 * denial rejects instead of resolving false — that must not read as logout).
 */
function probeClaudeNativeSessionAsync(): Promise<boolean> {
  if (process.platform !== 'darwin') return Promise.resolve(false);
  return readNativeOAuthKeychain('Claude Code-credentials').then(
    (ok) => (ok ? true : claudeCliAuthStatusLoggedInAsync()),
    () => claudeCliAuthStatusLoggedInAsync(),
  );
}

function openclaudeConfigDir(home: string): string {
  const override = process.env.OPENCLAUDE_CONFIG_DIR?.trim();
  if (override) return override;
  return path.join(home, '.openclaude');
}

/**
 * OpenClaude fork of Claude Code credentials. Same blob shape, different
 * home (`~/.openclaude` or `$OPENCLAUDE_CONFIG_DIR`). File presence alone
 * after logout is not a seat.
 */
export function openclaudeCredentialsFileIsUsable(
  home = os.homedir(),
): boolean {
  try {
    const raw = fs.readFileSync(
      path.join(openclaudeConfigDir(home), '.credentials.json'),
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

const GO_KEYRING_BASE64_PREFIX = 'go-keyring-base64:';

function hasNonEmptyString(source: unknown, ...keys: string[]): boolean {
  if (!source || typeof source !== 'object') return false;
  const record = source as Record<string, unknown>;
  return keys.some((key) => {
    const value = record[key];
    return typeof value === 'string' && value.trim().length > 0;
  });
}

/**
 * Pure payload check for the AGY login-keychain item. go-keyring stores the
 * value base64-wrapped; the antigravity CLI writes
 * `{auth_method, token: {access_token, refresh_token, token_type, expiry}}`.
 *
 * Presence of the keychain item alone was deliberately distrusted (install
 * trees leave stale items behind), so readiness requires a real token inside
 * the payload. A refresh token counts: like Kimi, the CLI refreshes on spawn,
 * so demanding an unexpired access token would report a daily-use session as
 * logged out. Both the nested and flat shapes are accepted so a CLI-side
 * layout change degrades to the file probe instead of silently locking AGY
 * out. The secret itself is never returned or logged.
 */
export function agyKeychainBlobIsUsable(blob: string): boolean {
  const trimmed = blob.trim();
  if (!trimmed) return false;
  let payload = trimmed;
  if (trimmed.startsWith(GO_KEYRING_BASE64_PREFIX)) {
    try {
      payload = Buffer.from(
        trimmed.slice(GO_KEYRING_BASE64_PREFIX.length),
        'base64',
      ).toString('utf8');
    } catch {
      return false;
    }
  }
  if (!payload.trim()) return false;
  try {
    const parsed = JSON.parse(payload) as {
      token?: unknown;
    };
    // Nested shape written by the antigravity CLI.
    if (hasNonEmptyString(parsed.token, 'access_token', 'refresh_token')) {
      return true;
    }
    // Flat shapes: `token` as a bare string, or top-level OAuth fields.
    return hasNonEmptyString(parsed, 'token', 'access_token', 'refresh_token');
  } catch {
    return false;
  }
}

/**
 * AGY (antigravity) has no oauth_creds.json on this route: the live session
 * token lives in the macOS login keychain under service `gemini`, account
 * `antigravity`. Detecting only the ~/.gemini files reported "login
 * necessário" for a fully signed-in CLI and removed AGY from squad selection.
 *
 * Reading the payload costs one `security` process, so the result is memoized
 * for the normal TTL — the provider snapshot filters readiness per model and
 * would otherwise spawn one probe per model.
 */
let agyKeychainMemo: {
  readonly home: string;
  readonly value: boolean;
  readonly at: number;
  readonly authoritative: boolean;
} | null = null;

export interface AgyKeychainProbeOptions {
  /** Test seam; production resolves the OS-account HOME, never process HOME. */
  readonly nativeHome?: string;
  /** Authority-critical spawn checks must observe the Keychain as it is now. */
  readonly bypassCache?: boolean;
}

export class AgyKeychainProbeUnavailableError extends Error {
  constructor() {
    super('AGY Keychain proof is unavailable');
    this.name = 'AgyKeychainProbeUnavailableError';
  }
}

function isAgyKeychainItemNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const detail = error as {
    code?: unknown;
    killed?: unknown;
    signal?: unknown;
  };
  return (
    (detail.code === 44 || detail.code === '44') &&
    detail.killed !== true &&
    (detail.signal === null || detail.signal === undefined)
  );
}

function agyKeychainProbeUnavailable(
  error: unknown,
): AgyKeychainProbeUnavailableError {
  return error instanceof AgyKeychainProbeUnavailableError
    ? error
    : new AgyKeychainProbeUnavailableError();
}

function resolveAgyNativeHome(requestedHome: string): string | null {
  if (!path.isAbsolute(requestedHome) || requestedHome.includes('\0')) {
    return null;
  }
  try {
    const nativeHome = fs.realpathSync.native(requestedHome);
    return fs.statSync(nativeHome).isDirectory() ? nativeHome : null;
  } catch {
    return null;
  }
}

function reusableAgyKeychainValue(
  nativeHome: string,
  options: AgyKeychainProbeOptions,
): boolean | null {
  if (agyKeychainMemo?.home !== nativeHome) return null;
  const age = Date.now() - agyKeychainMemo.at;
  if (options.bypassCache !== true && age < CACHE_TTL_MS) {
    return agyKeychainMemo.value;
  }
  if (
    options.bypassCache === true &&
    agyKeychainMemo.authoritative &&
    agyKeychainMemo.value &&
    age < AGY_AUTHORITATIVE_PROOF_TTL_MS
  ) {
    return true;
  }
  return null;
}

function rememberAgyKeychainValue(
  nativeHome: string,
  value: boolean,
  options: AgyKeychainProbeOptions,
): void {
  agyKeychainMemo = {
    home: nativeHome,
    value,
    at: Date.now(),
    authoritative: options.bypassCache === true,
  };
}

export function agyKeychainCredentialIsUsable(
  execImpl: typeof execFileSync = execFileSync,
  options: AgyKeychainProbeOptions = {},
): boolean {
  if (process.platform !== 'darwin') return false;
  const nativeHome = resolveAgyNativeHome(
    options.nativeHome ?? realUserHome(),
  );
  if (!nativeHome) return false;
  const cached = reusableAgyKeychainValue(nativeHome, options);
  if (cached !== null) return cached;
  let value = false;
  try {
    const raw = execImpl(
      '/usr/bin/security',
      ['find-generic-password', '-s', 'gemini', '-a', 'antigravity', '-w'],
      {
        stdio: 'pipe',
        timeout: 5_000,
        killSignal: 'SIGKILL',
        encoding: 'utf8',
        // Electron release gates deliberately isolate process.env.HOME. AGY
        // 1.1, however, authenticates against the native login keychain and
        // also spawns with that OS-account HOME. `security` follows HOME when
        // selecting the default keychain, so inheriting the isolation path
        // reports item-not-found for a session the AGY binary can use.
        env: {
          HOME: nativeHome,
          USERPROFILE: nativeHome,
          PATH: '/usr/bin:/bin',
          LANG: 'C',
          LC_ALL: 'C',
        },
      },
    );
    value = agyKeychainBlobIsUsable(typeof raw === 'string' ? raw : '');
  } catch {
    // Locked keychain / TCC denial inside packaged Electron → fail closed.
    value = false;
  }
  rememberAgyKeychainValue(nativeHome, value, options);
  return value;
}

/**
 * Windows presence probe for the AGY session (go-keyring → Credential
 * Manager, target `gemini:antigravity` — the same service:account pair as
 * the macOS login keychain item). `cmdkey /list` prints no secret and
 * exits 0 with or without a match, so the target line is parsed
 * (Destino:/Target: — PT-BR and EN Windows).
 */
export const AGY_CREDENTIAL_MANAGER_TARGET = 'gemini:antigravity';

export function agyCredentialManagerHas(
  execImpl: typeof execFileSync = execFileSync,
): boolean {
  if (process.platform !== 'win32') return false;
  try {
    const raw = execImpl('cmdkey', [`/list:${AGY_CREDENTIAL_MANAGER_TARGET}`], {
      stdio: 'pipe',
      timeout: 5_000,
      windowsHide: true,
      encoding: 'utf8',
    });
    const out = typeof raw === 'string' ? raw : '';
    return out
      .split(/\r?\n/)
      .some(
        (line) =>
          /(Destino|Target):/i.test(line) &&
          line.includes(AGY_CREDENTIAL_MANAGER_TARGET),
      );
  } catch {
    return false;
  }
}

/** Non-blocking AGY Keychain proof for provider snapshots and mission setup UI. */
export function agyKeychainCredentialIsUsableAsync(
  execImpl: typeof execFile = execFile,
  options: AgyKeychainProbeOptions = {},
): Promise<boolean> {
  if (process.platform !== 'darwin') return Promise.resolve(false);
  const nativeHome = resolveAgyNativeHome(
    options.nativeHome ?? realUserHome(),
  );
  if (!nativeHome) {
    return Promise.reject(new AgyKeychainProbeUnavailableError());
  }
  const cached = reusableAgyKeychainValue(nativeHome, options);
  if (cached !== null) return Promise.resolve(cached);
  const { promise, resolve, reject } = Promise.withResolvers<boolean>();
    try {
      execImpl(
        '/usr/bin/security',
        ['find-generic-password', '-s', 'gemini', '-a', 'antigravity', '-w'],
        {
          timeout: 5_000,
          killSignal: 'SIGKILL',
          windowsHide: true,
          encoding: 'utf8',
          env: {
            HOME: nativeHome,
            USERPROFILE: nativeHome,
            PATH: '/usr/bin:/bin',
            LANG: 'C',
            LC_ALL: 'C',
          },
        },
        (error, stdout) => {
          if (error) {
            if (isAgyKeychainItemNotFound(error)) {
              rememberAgyKeychainValue(nativeHome, false, options);
              resolve(false);
            } else {
              reject(agyKeychainProbeUnavailable(error));
            }
            return;
          }
          const value = agyKeychainBlobIsUsable(stdout);
          rememberAgyKeychainValue(nativeHome, value, options);
          resolve(value);
        },
      );
    } catch (error) {
      reject(agyKeychainProbeUnavailable(error));
    }
  return promise;
}

/** Test seam: drop the memoized AGY keychain probe result. */
export function resetAgyKeychainCache(): void {
  agyKeychainMemo = null;
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
 * Kimi's credentials file can exist with non-empty but expired tokens, and the
 * empty shell survives logout — neither may advertise a session.
 *
 * A live access token (expiry more than five minutes away) is the strong
 * signal. An *expired* access token paired with a refresh token is still a
 * live login: the CLI silently refreshes on spawn, which is why the operator
 * sees `kimi` working in the terminal. Requiring an unexpired access token
 * reported "login necessário" for a session in daily use — a false negative
 * that removed Kimi from squad selection. The refresh token must accompany a
 * real access token: a refresh token on an empty shell is not evidence, and
 * the spawn boundary stays authoritative if the refresh is ultimately refused.
 */
export function kimiCredentialsBlobIsUsable(
  blob: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  try {
    const parsed = JSON.parse(blob) as {
      access_token?: unknown;
      refresh_token?: unknown;
      expires_at?: unknown;
    };
    const access =
      typeof parsed.access_token === 'string' ? parsed.access_token.trim() : '';
    if (!access) return false;
    const refresh =
      typeof parsed.refresh_token === 'string'
        ? parsed.refresh_token.trim()
        : '';
    const rawExpiry = Number(parsed.expires_at);
    if (!Number.isFinite(rawExpiry) || rawExpiry <= 0) return false;
    const expirySeconds =
      rawExpiry >= 1_000_000_000_000
        ? Math.floor(rawExpiry / 1000)
        : Math.floor(rawExpiry);
    if (expirySeconds - nowSeconds > 5 * 60) return true;
    return refresh.length > 0;
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

/** Cursor Agent writes identity into ~/.cursor/cli-config.json at login. */
export function cursorCliConfigHasSession(home = os.homedir()): boolean {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(home, '.cursor', 'cli-config.json'), 'utf8'),
    ) as { authInfo?: { email?: unknown } };
    const email = parsed.authInfo?.email;
    return typeof email === 'string' && email.includes('@');
  } catch {
    return false;
  }
}

/** Muse Spark `~/.config/muse/auth.json` — any provider with a live token. */
export function museAuthBlobIsUsable(blob: string): boolean {
  try {
    const parsed = JSON.parse(blob) as { providers?: unknown };
    if (!parsed.providers || typeof parsed.providers !== 'object') return false;
    return Object.values(parsed.providers as Record<string, unknown>).some(
      (provider) =>
        hasNonEmptyString(provider, 'access_token', 'refresh_token', 'api_key'),
    );
  } catch {
    return false;
  }
}

function museAuthPath(home: string): string {
  return process.env.MUSE_AUTH_PATH?.trim() || path.join(
    process.env.XDG_CONFIG_HOME?.trim() || path.join(home, '.config'), 'muse', 'auth.json',
  );
}

/** Missing local proof is not logout when the CLI delegates tokens to Keychain. */
export function subscriptionAuthStatusIsUnknown(adapterId: string, home = os.homedir()): boolean {
  if (adapterId === 'muse') {
    try {
      const parsed = JSON.parse(fs.readFileSync(museAuthPath(home), 'utf8')) as {
        providers?: Record<string, { storage?: string; mechanism?: string }>;
      };
      return Object.values(parsed.providers ?? {}).some((provider) =>
        provider?.storage === 'keychain' &&
        (provider.mechanism === 'oauth' || provider.mechanism === 'api_key'));
    } catch {
      return false;
    }
  }
  return process.platform === 'darwin' && ['claude', 'openclaude', 'agy'].includes(adapterId) &&
    cachedSubscriptionAuth(adapterId) === null;
}

/** Prime Agent `~/.prime/agent/auth.json` — oauth access or stored key. */
export function primeAuthBlobIsUsable(blob: string): boolean {
  try {
    const parsed = JSON.parse(blob) as Record<string, unknown>;
    return Object.values(parsed).some(
      (provider) => hasNonEmptyString(provider, 'access', 'refresh', 'key'),
    );
  } catch {
    return false;
  }
}

function nonemptyFile(home: string, ...segments: string[]): boolean {
  try {
    return fs.statSync(path.join(home, ...segments)).size > 0;
  } catch {
    return false;
  }
}

/** oh-my-pi keeps provider keys in ~/.omp/agent/.env — presence of a value. */
function ompAgentEnvHasKey(home: string): boolean {
  try {
    const raw = fs.readFileSync(
      path.join(home, '.omp', 'agent', '.env'),
      'utf8',
    );
    return raw.split(/\r?\n/).some((line) => /^[A-Z][A-Z0-9_]+=\S+/.test(line));
  } catch {
    return false;
  }
}

export function detectSubscriptionAuth(
  adapterId: string,
  home = os.homedir(),
  _model?: string,
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
    case 'glm-flash':
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
      if (agyOauthCredsFileIsUsable(home) || agyGoogleAccountIsActive(home)) {
        return true;
      }
      // The antigravity CLI route writes no oauth_creds.json: its session
      // token lives in the native login keychain. File-only detection reported
      // "login necessário" for a signed-in CLI. AGY 1.1 is intentionally
      // launched with OS-account HOME even when Electron itself has an
      // isolated HOME, so readiness must query that same native authority.
      if (options.probeAgyKeychain === false) return false;
      if (options.agyKeychainProbe) return options.agyKeychainProbe();
      return agyKeychainCredentialIsUsable(execFileSync);
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
    case 'openclaude':
      // Fork of Claude Code with a separate config home. Presence of
      // ~/.openclaude.json is identity/theme, not a live session.
      if (openclaudeCredentialsFileIsUsable(home)) return true;
      if (options.probeOpenClaudeKeychain === false) return false;
      if (options.openClaudeKeychainProbe) return options.openClaudeKeychainProbe();
      if (home !== os.homedir() || process.platform !== 'darwin') return false;
      try {
        return claudeCredentialBlobIsUsable(execFileSync('security', [
          'find-generic-password', '-s',
          openClaudeKeychainService(home, process.env.OPENCLAUDE_CONFIG_DIR), '-w',
        ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000, killSignal: 'SIGKILL' }));
      } catch {
        return false;
      }
    case 'devin':
      // Sessão em TOML plano ($XDG_DATA_HOME/devin/credentials.toml). Sem este
      // case o switch caía no default `false`, a estratégia virava
      // `login-needed` e o gate pré-spawn recusava TODO spawn governado do
      // devin: a CLI aparecia logada em Configurações e nunca sentava um pane
      // (a cadeia de sucessão sentava outro CLI no lugar).
      return hasNativeFileAuth(adapterId, home);
    case 'aider':
      // Aider has no native OAuth/subscription session; it consumes provider
      // API keys. Treating its config directory as login would suppress every
      // injected key and leave the freshly installed CLI unusable.
      return false;
    case 'cursor-agent':
      // Plugin CLI. Login writes ~/.cursor/cli-config.json authInfo.email
      // and a keychain access token. Identity in the file is the inbox
      // signal — the Attention list cannot wait on a Keychain probe.
      return cursorCliConfigHasSession(home);
    case 'muse': {
      try {
        return museAuthBlobIsUsable(
          fs.readFileSync(museAuthPath(home), 'utf8'),
        );
      } catch {
        return false;
      }
    }
    case 'omp':
      return ompAgentEnvHasKey(home);
    case 'qoder':
      return nonemptyFile(home, '.qoder', '.auth', 'user');
    case 'prime-agent': {
      try {
        return primeAuthBlobIsUsable(
          fs.readFileSync(path.join(home, '.prime', 'agent', 'auth.json'), 'utf8'),
        );
      } catch {
        return false;
      }
    }
    default:
      // Unknown is not evidence of an authenticated session. Failing closed
      // prevents a false positive from suppressing a valid API key.
      return false;
  }
}

/**
 * Five-state view of subscription/OAuth proof for first-wave seating.
 * Kimi file tokens alone are `incomplete` — `present` needs the live
 * `kimi provider list` probe. Other adapters: live session → `present`.
 */
export function detectSubscriptionAuthReadiness(
  adapterId: string,
): AuthReadiness {
  if (adapterId === 'kimi') {
    return (
      peekKimiSeatReadiness() ??
      (detectSubscriptionAuth(adapterId) ? 'incomplete' : 'no-credential')
    );
  }
  return detectSubscriptionAuth(adapterId) ? 'present' : 'no-credential';
}

/** Whether the CLI has a live subscription/OAuth session (cached 60s). */
export function hasSubscriptionAuth(
  adapterId: string,
  model?: string,
): boolean {
  const hit = cachedSubscriptionAuth(adapterId, model);
  if (hit === true) return true;
  const value = detectSubscriptionAuth(
    adapterId,
    os.homedir(),
    model,
    adapterId === 'agy' ? { probeAgyKeychain: false } : {},
  );
  // Never cache a miss: login in a live shell writes the session seconds
  // later and the Attention list must see it without waiting out the TTL.
  if (value) cacheSubscriptionAuth(adapterId, value, model);
  if (value) return value;
  // Keychain-only Claude session unreadable from this process (packaged-app
  // TCC/ACL denial): storage sniffing failed but the CLI may still attest a
  // live session. Positive-only fallback — a negative changes nothing.
  if (adapterId === 'claude' && claudeCliAuthStatusLoggedInSync()) {
    cacheSubscriptionAuth(adapterId, true, model);
    return true;
  }
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
  if (hit === true) return true;
  if (adapterId !== 'claude' && adapterId !== 'agy' && adapterId !== 'openclaude') {
    return hasSubscriptionAuth(adapterId, model);
  }

  const fileBacked =
    adapterId === 'openclaude'
      ? openclaudeCredentialsFileIsUsable(home)
      : adapterId === 'agy'
      ? detectSubscriptionAuth(adapterId, home, model, {
          probeAgyKeychain: false,
        })
      : detectSubscriptionAuth(adapterId, home, model, {
          probeClaudeKeychain: false,
        });
  if (fileBacked) cacheSubscriptionAuth(adapterId, true, model);
  return fileBacked;
}

/**
 * Warm Claude's status cache outside the renderer's request-critical path.
 * Concurrent list calls share one asynchronous `security` process. A miss
 * can be refreshed after login; inaccessible Keychain remains unknown.
 */
export function refreshClaudeSubscriptionAuthCache(
  home = os.homedir(),
  keychainProbe: () => Promise<boolean> = () => probeClaudeNativeSessionAsync(),
  options: { authoritative?: boolean } = {},
): Promise<ClaudeAuthRefreshResult> {
  const cached = cachedSubscriptionAuth('claude');
  if (cached === true && !options.authoritative) {
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
  // Require a usable payload, without blocking the Electron event loop.
  claudeRefreshInFlight = Promise.resolve()
    .then(() => keychainProbe())
    .then((value) => {
      cacheSubscriptionAuth('claude', value);
      return { value, cacheUpdated: value !== cached };
    })
    .catch((error) => { cache.delete('claude'); throw error; })
    .finally(() => {
      claudeRefreshInFlight = null;
    });
  return claudeRefreshInFlight;
}

export function refreshOpenClaudeSubscriptionAuthCache(
  home = os.homedir(),
  keychainProbe: () => Promise<boolean> = () => process.platform === 'darwin'
    ? readNativeOAuthKeychain(openClaudeKeychainService(home, process.env.OPENCLAUDE_CONFIG_DIR))
    : Promise.resolve(false),
  options: { authoritative?: boolean } = {},
): Promise<ClaudeAuthRefreshResult> {
  const cached = cachedSubscriptionAuth('openclaude');
  if (cached === true && !options.authoritative) return Promise.resolve({ value: true, cacheUpdated: false });
  if (openclaudeCredentialsFileIsUsable(home)) {
    cacheSubscriptionAuth('openclaude', true);
    return Promise.resolve({ value: true, cacheUpdated: true });
  }
  if (openClaudeRefreshInFlight) return openClaudeRefreshInFlight;
  openClaudeRefreshInFlight = Promise.resolve().then(keychainProbe).then((value) => {
    cacheSubscriptionAuth('openclaude', value);
    return { value, cacheUpdated: value !== cached };
  }).catch((error) => { cache.delete('openclaude'); throw error; })
    .finally(() => { openClaudeRefreshInFlight = null; });
  return openClaudeRefreshInFlight;
}

/** Warm AGY's Keychain-only status without blocking Electron's main loop. */
export function refreshAgySubscriptionAuthCache(
  home = os.homedir(),
  keychainProbe?: () => Promise<boolean>,
  options: { authoritative?: boolean; winCredentialHas?: () => boolean } = {},
): Promise<ClaudeAuthRefreshResult> {
  const cached = cachedSubscriptionAuth('agy');
  if (options.authoritative !== true && cached === true) {
    return Promise.resolve({ value: cached, cacheUpdated: false });
  }
  const fileBacked = detectSubscriptionAuth(
    'agy',
    home,
    undefined,
    { probeAgyKeychain: false },
  );
  if (fileBacked) {
    cacheSubscriptionAuth('agy', true);
    return Promise.resolve({ value: true, cacheUpdated: true });
  }
  // Windows keeps the session in Credential Manager instead of files or
  // the macOS keychain — without this the provider list reports a signed-in
  // CLI as "precisa login".
  const winCredentialHas = options.winCredentialHas ?? agyCredentialManagerHas;
  if (process.platform === 'win32' && winCredentialHas()) {
    cacheSubscriptionAuth('agy', true);
    return Promise.resolve({ value: true, cacheUpdated: true });
  }
  const runKeychainProbe =
    keychainProbe ??
    (() =>
      agyKeychainCredentialIsUsableAsync(execFile, {
        // Even status refreshes must see OAuth completed after a recent
        // negative result. The process is asynchronous, so rechecking cannot
        // freeze Main; a positive proof is reusable by the adjacent spawn gate.
        bypassCache: true,
      }));
  if (!agyRefreshInFlight) {
    agyRefreshInFlight = Promise.resolve()
      .then(runKeychainProbe)
      .finally(() => {
        agyRefreshInFlight = null;
      });
  }
  return agyRefreshInFlight
    .then((value) => {
      cacheSubscriptionAuth('agy', value);
      return {
        value,
        cacheUpdated: value ? cached !== true : cached === true,
      };
    })
    .catch((error) => {
      if (options.authoritative === true) {
        throw agyKeychainProbeUnavailable(error);
      }
      return { value: false, cacheUpdated: false };
    });
}

/**
 * Shared warm step for sync mission gates.
 *
 * Keychain-only subscription providers (AGY 1.1 keeps its session token ONLY
 * in the macOS login keychain) read as `login-needed` from the warm status
 * cache whenever no renderer/settings flow recently listed providers — the
 * sync file probes never see the native session. Sync readiness/roster
 * decisions (squad runtime inventory, sealed scheduler roster, reviewer
 * quorum) deliberately consume only that cache so a locked login Keychain can
 * never freeze Electron's main event loop; the price is that a cold cache
 * reads a live operator session as unauthenticated and the mission gate
 * blocks. Every ASYNC ancestor of such a sync gate must await this first:
 * the probe is main-loop-safe (async `security` call) and memoized, so the
 * sync decision right after it sees reality. No-op for providers whose auth
 * is file/token based.
 */
export async function warmKeychainOnlySubscriptionAuth(
  cliId: string,
  keychainProbe?: () => Promise<boolean>,
): Promise<void> {
  if (cliId !== 'agy') return;
  await refreshAgySubscriptionAuthCache(os.homedir(), keychainProbe, {
    authoritative: true,
  });
}

/** Test hook. */
export function resetSubscriptionAuthCacheForTests(): void {
  cache.clear();
  claudeRefreshInFlight = null;
  openClaudeRefreshInFlight = null;
  agyRefreshInFlight = null;
}
