/**
 * Resolve credentials for live provider usage probes.
 * Never logs secrets. Best-effort; null = skip network probe.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getKey, getSecret } from '../persistence/secrets-store';
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

function readText(filePath: string): string | null {
  try {
    const t = fs.readFileSync(filePath, 'utf8');
    return t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

/** Claude OAuth token (vault account or active CLI). */
export function resolveClaudeToken(accountId?: string): string | null {
  return claudeOAuthAccessToken(accountId);
}

/**
 * Codex ChatGPT OAuth from vault blob or ~/.codex/auth.json.
 */
export function resolveCodexAuth(accountId?: string): CodexChatGptAuth | null {
  if (accountId) {
    const account = getAccount(accountId);
    if (!account || account.adapterId !== 'codex') return null;
    const blob = getSecret(CRED_PREFIX + accountId);
    if (typeof blob === 'string') {
      const fromVault = parseCodexAuthJson(blob);
      if (fromVault) return fromVault;
    }
    return null;
  }
  const system = readText(path.join(os.homedir(), '.codex', 'auth.json'));
  if (system) {
    const parsed = parseCodexAuthJson(system);
    if (parsed) return parsed;
  }
  return null;
}

const KEY_PREFIX = 'acctkey:';

/**
 * API key for key-based providers.
 * Priority: vault account key → adapter vault key → launcher → env.
 */
export function resolveProviderApiKey(
  adapterId: string,
  accountId?: string,
): string | null {
  if (accountId) {
    const accKey = getSecret(KEY_PREFIX + accountId);
    if (typeof accKey === 'string' && accKey.trim()) return accKey.trim();
  }

  const fromVault = getKey(adapterId)?.trim();
  if (fromVault) return fromVault;

  const fromLauncher = loadLauncherProviderKey(adapterId)?.trim();
  if (fromLauncher) return fromLauncher;

  // Common aliases for GLM / Z.ai
  if (adapterId === 'glm') {
    for (const alias of ['zai', 'zhipu', 'z-ai'] as const) {
      const k = getKey(alias)?.trim() || loadLauncherProviderKey(alias)?.trim();
      if (k) return k;
    }
    for (const envName of [
      'ANTHROPIC_AUTH_TOKEN',
      'ZAI_API_KEY',
      'ZHIPU_API_KEY',
      'ZHIPUAI_API_KEY',
    ]) {
      const v = process.env[envName]?.trim();
      if (v) return v;
    }
  }

  if (adapterId === 'longcat') {
    for (const envName of ['ANTHROPIC_AUTH_TOKEN', 'LONGCAT_API_KEY']) {
      const v = process.env[envName]?.trim();
      if (v) return v;
    }
  }

  if (adapterId === 'grok') {
    const env = process.env.XAI_API_KEY?.trim();
    if (env) return env;
  }

  if (adapterId === 'kimi') {
    for (const envName of ['KIMI_MODEL_API_KEY', 'MOONSHOT_API_KEY']) {
      const v = process.env[envName]?.trim();
      if (v) return v;
    }
  }

  return null;
}

/**
 * Grok CLI OAuth access JWT from ~/.grok/auth.json (nested `{ url::id: { key } }`).
 * Also accepts vault API key via resolveProviderApiKey('grok').
 */
export function resolveGrokAccessToken(accountId?: string): string | null {
  if (accountId) {
    const blob = getSecret(CRED_PREFIX + accountId);
    if (typeof blob === 'string') {
      const nested = extractGrokKeyFromAuthJson(blob);
      if (nested) return nested;
      // vault may store raw API key
      if (blob.trim().length > 8 && !blob.trim().startsWith('{')) {
        return blob.trim();
      }
    }
  }
  const api = resolveProviderApiKey('grok');
  if (api) return api;
  const system = readText(path.join(os.homedir(), '.grok', 'auth.json'));
  if (system) return extractGrokKeyFromAuthJson(system);
  return null;
}

export function extractGrokKeyFromAuthJson(blob: string): string | null {
  try {
    const parsed = JSON.parse(blob) as Record<string, unknown>;
    for (const value of Object.values(parsed)) {
      if (typeof value === 'string' && value.length > 20) {
        // flat map style
        continue;
      }
      if (value && typeof value === 'object') {
        const rec = value as Record<string, unknown>;
        if (typeof rec.key === 'string' && rec.key.length > 0) return rec.key;
        if (typeof rec.access_token === 'string' && rec.access_token.length > 0) {
          return rec.access_token;
        }
      }
    }
    // flat keys ending in .key
    for (const [k, v] of Object.entries(parsed)) {
      if (k.endsWith('.key') && typeof v === 'string' && v.length > 0) return v;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Kimi Code OAuth access token from credentials file or vault.
 */
export function resolveKimiAccessToken(accountId?: string): string | null {
  if (accountId) {
    const blob = getSecret(CRED_PREFIX + accountId);
    if (typeof blob === 'string') {
      const t = extractKimiToken(blob);
      if (t) return t;
    }
  }
  const api = resolveProviderApiKey('kimi');
  if (api) return api;
  for (const rel of [
    path.join('.kimi-code', 'credentials', 'kimi-code.json'),
    path.join('.kimi', 'credentials', 'kimi-code.json'),
  ]) {
    const blob = readText(path.join(os.homedir(), rel));
    if (blob) {
      const t = extractKimiToken(blob);
      if (t) return t;
    }
  }
  return null;
}

function extractKimiToken(blob: string): string | null {
  try {
    const parsed = JSON.parse(blob) as {
      access_token?: unknown;
      accessToken?: unknown;
    };
    if (typeof parsed.access_token === 'string' && parsed.access_token) {
      return parsed.access_token;
    }
    if (typeof parsed.accessToken === 'string' && parsed.accessToken) {
      return parsed.accessToken;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Gemini / AGY OAuth access token from ~/.gemini/oauth_creds.json.
 */
export function resolveGeminiAccessToken(accountId?: string): string | null {
  if (accountId) {
    const blob = getSecret(CRED_PREFIX + accountId);
    if (typeof blob === 'string') {
      const t = extractGeminiToken(blob);
      if (t) return t;
    }
  }
  const blob = readText(path.join(os.homedir(), '.gemini', 'oauth_creds.json'));
  if (blob) return extractGeminiToken(blob);
  return null;
}

function extractGeminiToken(blob: string): string | null {
  try {
    const parsed = JSON.parse(blob) as { access_token?: unknown };
    return typeof parsed.access_token === 'string' && parsed.access_token
      ? parsed.access_token
      : null;
  } catch {
    return null;
  }
}

// re-export for tests that already use extractClaudeAccessToken via account path
export { extractClaudeAccessToken };
