import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

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

function existsAt(home: string, ...segments: string[]): boolean {
  try {
    fs.statSync(path.join(home, ...segments));
    return true;
  } catch {
    return false;
  }
}

/** Claude Code stores its OAuth session in the login keychain on macOS. */
function claudeKeychainHas(): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    execFileSync(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials'],
      { stdio: 'pipe' },
    );
    return true;
  } catch {
    // Keychain can fail inside packaged Electron (TCC) even when the CLI works.
    return false;
  }
}

/** Email of the active Claude OAuth account from ~/.claude.json, if any. */
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


function existsInEnv(envVar: string, ...segments: string[]): boolean {
  const customHome = process.env[envVar];
  if (customHome) {
    try {
      fs.statSync(path.join(customHome, ...segments));
      return true;
    } catch {}
  }
  return false;
}

export function detectSubscriptionAuth(
  adapterId: string,
  home = os.homedir(),
): boolean {
  const exists = (...segments: string[]) => existsAt(home, ...segments);
  switch (adapterId) {
    case 'claude':
      // Prefer file-backed oauthAccount: Keychain probes often fail from
      // packaged Electron (TCC / no user keychain prompt) even when the
      // terminal CLI is fully logged in.
      return (
        claudeOauthEmail(home) !== null ||
        exists('.claude', '.credentials.json') ||
        claudeKeychainHas()
      );
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
      return (
        exists('.gemini', 'antigravity') ||
        exists('.gemini', 'antigravity-cli') ||
        exists('.antigravity')
      );
    case 'kimi':
      return (
        existsInEnv('KIMI_CODE_HOME', 'oauth', 'kimi-code') ||
        existsInEnv('KIMI_CODE_HOME', 'credentials', 'kimi-code.json') ||
        exists('.kimi-code', 'oauth', 'kimi-code') ||
        exists('.kimi-code', 'credentials', 'kimi-code.json') ||
        exists('.kimi', 'credentials', 'kimi-code.json') ||
        exists('.config', 'kimi', 'credentials.json')
      );
    case 'opencode':
      // Official OpenCode docs use the XDG path. Keep the native macOS data
      // path as a compatibility probe for package-manager variants.
      return (
        existsInEnv('OPENCODE_HOME', 'auth.json') ||
        exists('.local', 'share', 'opencode', 'auth.json') ||
        exists('Library', 'Application Support', 'opencode', 'auth.json')
      );
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
export function hasSubscriptionAuth(adapterId: string): boolean {
  const hit = cache.get(adapterId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const value = detectSubscriptionAuth(adapterId);
  cache.set(adapterId, { value, at: Date.now() });
  return value;
}

/** Test hook. */
export function resetSubscriptionAuthCacheForTests(): void {
  cache.clear();
}
