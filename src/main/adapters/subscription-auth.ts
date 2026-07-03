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
  const subscriptionCapable =
    input.authMethod === 'oauth' ||
    input.authMethod === 'subscription' ||
    input.authMethod === 'device_code';

  if (!subscriptionCapable) {
    // Pure API-key CLIs (codex api mode, glm, fugu…).
    return input.hasStoredKey
      ? { strategy: 'api-key', injectKey: true, suppressKeyEnv: false }
      : { strategy: 'login-needed', injectKey: false, suppressKeyEnv: false };
  }
  if (input.subscriptionAuthed) {
    return { strategy: 'subscription', injectKey: false, suppressKeyEnv: true };
  }
  if (input.hasStoredKey) {
    return { strategy: 'api-key', injectKey: true, suppressKeyEnv: false };
  }
  // No subscription session and no key: the CLI itself will prompt /login.
  return { strategy: 'login-needed', injectKey: false, suppressKeyEnv: false };
}

// ---------------------------------------------------------------------------
// Subscription-session detectors (ported from the ai-launcher account model).
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { value: boolean; at: number }>();

function exists(...segments: string[]): boolean {
  try {
    fs.statSync(path.join(os.homedir(), ...segments));
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
    return false;
  }
}

function claudeOauthAccount(): boolean {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'),
    );
    return Boolean(raw?.oauthAccount?.emailAddress);
  } catch {
    return false;
  }
}

function detect(adapterId: string): boolean {
  switch (adapterId) {
    case 'claude':
      return (
        claudeKeychainHas() ||
        claudeOauthAccount() ||
        exists('.claude', '.credentials.json')
      );
    case 'codex':
      // ChatGPT session file (the launcher's xconta model swaps this file).
      return exists('.codex', 'auth.json');
    case 'agy':
      return (
        exists('.gemini', 'antigravity') ||
        exists('.gemini', 'antigravity-cli') ||
        exists('.antigravity')
      );
    case 'kimi':
      return exists('.kimi') || exists('.config', 'kimi');
    default:
      // Unknown detector: assume the subscription session exists — the
      // directive is subscription-first, and an explicit upstream route is
      // the escape hatch for forcing API usage.
      return true;
  }
}

/** Whether the CLI has a live subscription/OAuth session (cached 60s). */
export function hasSubscriptionAuth(adapterId: string): boolean {
  const hit = cache.get(adapterId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const value = detect(adapterId);
  cache.set(adapterId, { value, at: Date.now() });
  return value;
}

/** Test hook. */
export function resetSubscriptionAuthCacheForTests(): void {
  cache.clear();
}
