/**
 * Resolve credentials for live provider usage probes.
 * Never logs secrets. Best-effort; empty list = skip network probe.
 *
 * Prefer multiple candidates (vault → launcher → env → system files) so a
 * stale vault key cannot shadow a working launcher/CLI login.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getKey,
  getSecret,
  hasCachedSecret,
} from '../persistence/secrets-store';
import { loadLauncherProviderKey } from '../adapters/launcher-provider-manager';
import {
  claudeOAuthAccessToken,
  getAccount,
} from '../persistence/account-store';
import {
  parseCodexAuthJson,
  type CodexChatGptAuth,
} from './codex-usage';
import { extractClaudeAccessToken } from './claude-oauth-usage';

const CRED_PREFIX = 'acctcred:';
const KEY_PREFIX = 'acctkey:';

function readText(filePath: string): string | null {
  try {
    const t = fs.readFileSync(filePath, 'utf8');
    return t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

function safeGetKey(adapterId: string): string | null {
  // Quota refreshes can run immediately after launch. A cold vault read would
  // synchronously enter the macOS Keychain and stall Electron's main thread.
  // Use only an already-decrypted cache entry here; a later provider spawn can
  // resolve the durable secret on demand.
  if (!hasCachedSecret(adapterId)) return null;
  try {
    return getKey(adapterId)?.trim() || null;
  } catch {
    return null;
  }
}

function safeGetSecret(key: string): string | null {
  if (!hasCachedSecret(key)) return null;
  try {
    const v = getSecret(key);
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

function pushUnique(out: string[], value: string | null | undefined): void {
  const v = value?.trim();
  if (!v) return;
  if (!out.includes(v)) out.push(v);
}

/** Claude OAuth token (vault account or active CLI). */
export function resolveClaudeToken(accountId?: string): string | null {
  return claudeOAuthAccessToken(accountId);
}

/**
 * All Codex ChatGPT auth candidates (account vault first, then system login).
 * Callers try each until usage API succeeds.
 */
export function resolveCodexAuthCandidates(
  accountId?: string,
): CodexChatGptAuth[] {
  const out: CodexChatGptAuth[] = [];
  const seen = new Set<string>();

  const add = (auth: CodexChatGptAuth | null): void => {
    if (!auth?.accessToken) return;
    const key = `${auth.accessToken}::${auth.accountId ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(auth);
  };

  if (accountId) {
    const account = getAccount(accountId);
    if (account?.adapterId === 'codex') {
      const blob = safeGetSecret(CRED_PREFIX + accountId);
      if (blob) add(parseCodexAuthJson(blob));
    }
  }

  // Always include active CLI login so multi-account vault rows still get a
  // live % when the vault blob is stale/missing.
  const system = readText(path.join(os.homedir(), '.codex', 'auth.json'));
  if (system) add(parseCodexAuthJson(system));

  return out;
}

/** Back-compat: first codex auth candidate. */
export function resolveCodexAuth(accountId?: string): CodexChatGptAuth | null {
  return resolveCodexAuthCandidates(accountId)[0] ?? null;
}

/**
 * API key candidates for key-based providers (glm, longcat, …).
 * Order: account vault → adapter vault → launcher → env aliases.
 */
export function resolveProviderApiKeyCandidates(
  adapterId: string,
  accountId?: string,
): string[] {
  const out: string[] = [];

  if (accountId) {
    pushUnique(out, safeGetSecret(KEY_PREFIX + accountId));
  }

  pushUnique(out, safeGetKey(adapterId));

  try {
    pushUnique(out, loadLauncherProviderKey(adapterId));
  } catch {
    // ignore
  }

  if (adapterId === 'glm') {
    for (const alias of ['zai', 'zhipu', 'z-ai', 'z.ai'] as const) {
      pushUnique(out, safeGetKey(alias));
      try {
        pushUnique(out, loadLauncherProviderKey(alias));
      } catch {
        // ignore
      }
    }
    for (const envName of [
      'ANTHROPIC_AUTH_TOKEN',
      'ZAI_API_KEY',
      'ZHIPU_API_KEY',
      'ZHIPUAI_API_KEY',
    ]) {
      pushUnique(out, process.env[envName]);
    }
  }

  if (adapterId === 'longcat') {
    for (const envName of ['ANTHROPIC_AUTH_TOKEN', 'LONGCAT_API_KEY']) {
      pushUnique(out, process.env[envName]);
    }
  }

  if (adapterId === 'grok') {
    pushUnique(out, process.env.XAI_API_KEY);
  }

  if (adapterId === 'kimi') {
    for (const envName of [
      'KIMI_MODEL_API_KEY',
      'KIMI_API_KEY',
      'KIMI_CODING_API_KEY',
      'MOONSHOT_API_KEY',
    ]) {
      pushUnique(out, process.env[envName]);
    }
  }

  // Multi-key CLIs: harvest every common provider credential.
  if (adapterId === 'opencode' || adapterId === 'aider') {
    for (const envName of [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'OPENAI_API_KEY',
      'XAI_API_KEY',
      'ZAI_API_KEY',
      'KIMI_API_KEY',
      'KIMI_CODING_API_KEY',
    ]) {
      pushUnique(out, process.env[envName]);
    }
    for (const alias of ['glm', 'zai', 'kimi', 'grok', 'claude', 'codex']) {
      try {
        pushUnique(out, loadLauncherProviderKey(alias));
      } catch {
        // ignore
      }
      pushUnique(out, safeGetKey(alias));
    }
  }

  return out;
}

/** First API key candidate (back-compat). */
export function resolveProviderApiKey(
  adapterId: string,
  accountId?: string,
): string | null {
  return resolveProviderApiKeyCandidates(adapterId, accountId)[0] ?? null;
}

/**
 * Grok CLI OAuth access JWT candidates (vault, API key, ~/.grok/auth.json).
 */
export function resolveGrokAccessTokenCandidates(
  accountId?: string,
): string[] {
  const out: string[] = [];
  if (accountId) {
    const blob = safeGetSecret(CRED_PREFIX + accountId);
    if (blob) {
      pushUnique(out, extractGrokKeyFromAuthJson(blob));
      if (!blob.trim().startsWith('{')) pushUnique(out, blob);
    }
  }
  for (const k of resolveProviderApiKeyCandidates('grok', accountId)) {
    pushUnique(out, k);
  }
  const system = readText(path.join(os.homedir(), '.grok', 'auth.json'));
  if (system) pushUnique(out, extractGrokKeyFromAuthJson(system));
  return out;
}

export function resolveGrokAccessToken(accountId?: string): string | null {
  return resolveGrokAccessTokenCandidates(accountId)[0] ?? null;
}

export function extractGrokKeyFromAuthJson(blob: string): string | null {
  try {
    const parsed = JSON.parse(blob) as Record<string, unknown>;
    for (const value of Object.values(parsed)) {
      if (value && typeof value === 'object') {
        const rec = value as Record<string, unknown>;
        if (typeof rec.key === 'string' && rec.key.length > 0) return rec.key;
        if (
          typeof rec.access_token === 'string' &&
          rec.access_token.length > 0
        ) {
          return rec.access_token;
        }
      }
    }
    for (const [k, v] of Object.entries(parsed)) {
      if (k.endsWith('.key') && typeof v === 'string' && v.length > 0) return v;
    }
    return null;
  } catch {
    return null;
  }
}

export function resolveKimiAccessTokenCandidates(
  accountId?: string,
): string[] {
  const out: string[] = [];
  if (accountId) {
    const blob = safeGetSecret(CRED_PREFIX + accountId);
    if (blob) pushUnique(out, extractKimiToken(blob));
  }
  for (const k of resolveProviderApiKeyCandidates('kimi', accountId)) {
    pushUnique(out, k);
  }
  for (const rel of [
    path.join('.kimi-code', 'credentials', 'kimi-code.json'),
    path.join('.kimi', 'credentials', 'kimi-code.json'),
  ]) {
    const blob = readText(path.join(os.homedir(), rel));
    if (blob) pushUnique(out, extractKimiToken(blob));
  }
  return out;
}

export function resolveKimiAccessToken(accountId?: string): string | null {
  return resolveKimiAccessTokenCandidates(accountId)[0] ?? null;
}

export interface KimiOauthCredsResolved {
  accessToken?: string;
  refreshToken?: string;
  /** Epoch seconds. */
  expiresAt?: number;
}

/**
 * Full Kimi OAuth blob from CLI credentials (for refresh + /usages).
 * Prefer this over bare access token — access expires in ~15 min.
 */
export function resolveKimiOauthCreds(
  accountId?: string,
): KimiOauthCredsResolved | null {
  if (accountId) {
    const blob = safeGetSecret(CRED_PREFIX + accountId);
    if (blob) {
      const c = parseKimiCredsBlob(blob);
      if (c) return c;
    }
  }
  for (const rel of [
    path.join('.kimi-code', 'credentials', 'kimi-code.json'),
    path.join('.kimi', 'credentials', 'kimi-code.json'),
  ]) {
    const blob = readText(path.join(os.homedir(), rel));
    if (blob) {
      const c = parseKimiCredsBlob(blob);
      if (c) return c;
    }
  }
  return null;
}

function parseKimiCredsBlob(blob: string): KimiOauthCredsResolved | null {
  try {
    const parsed = JSON.parse(blob) as {
      access_token?: unknown;
      refresh_token?: unknown;
      expires_at?: unknown;
    };
    const accessToken =
      typeof parsed.access_token === 'string' ? parsed.access_token : undefined;
    const refreshToken =
      typeof parsed.refresh_token === 'string' ? parsed.refresh_token : undefined;
    const expiresAt =
      typeof parsed.expires_at === 'number' ? parsed.expires_at : undefined;
    if (!accessToken && !refreshToken) return null;
    return { accessToken, refreshToken, expiresAt };
  } catch {
    return null;
  }
}

function extractKimiToken(blob: string): string | null {
  return parseKimiCredsBlob(blob)?.accessToken ?? null;
}

export function resolveGeminiAccessToken(accountId?: string): string | null {
  return resolveGeminiOauthCreds(accountId)?.accessToken ?? null;
}

export interface GeminiOauthCredsResolved {
  accessToken?: string;
  refreshToken?: string;
  expiryDate?: number;
}

/** Full OAuth blob for AGY/Gemini quota (access + refresh). */
export function resolveGeminiOauthCreds(
  accountId?: string,
): GeminiOauthCredsResolved | null {
  if (accountId) {
    const blob = safeGetSecret(CRED_PREFIX + accountId);
    if (blob) {
      const c = parseGeminiCredsBlob(blob);
      if (c) return c;
    }
  }
  const blob = readText(path.join(os.homedir(), '.gemini', 'oauth_creds.json'));
  if (blob) return parseGeminiCredsBlob(blob);
  return null;
}

function parseGeminiCredsBlob(blob: string): GeminiOauthCredsResolved | null {
  try {
    const parsed = JSON.parse(blob) as {
      access_token?: unknown;
      refresh_token?: unknown;
      expiry_date?: unknown;
    };
    const accessToken =
      typeof parsed.access_token === 'string' ? parsed.access_token : undefined;
    const refreshToken =
      typeof parsed.refresh_token === 'string' ? parsed.refresh_token : undefined;
    const expiryDate =
      typeof parsed.expiry_date === 'number' ? parsed.expiry_date : undefined;
    if (!accessToken && !refreshToken) return null;
    return { accessToken, refreshToken, expiryDate };
  } catch {
    return null;
  }
}

export { extractClaudeAccessToken };
