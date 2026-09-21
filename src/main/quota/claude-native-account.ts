import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { readNativeOAuthCredential } from '../adapters/native-oauth-keychain';
import type { FetchLike } from './claude-oauth-usage';

const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const PROFILE_TIMEOUT_MS = 8_000;
const PROFILE_CACHE_MS = 60_000;
const profileSchema = z.object({ account: z.object({ uuid: z.string().min(1), email: z.string().email() }) });
let cached: { token: string; email: string; until: number } | null = null;

async function readCredential(): Promise<string | null> {
  if (process.platform === 'darwin') return readNativeOAuthCredential('Claude Code-credentials');
  return fs.readFile(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8').catch(() => null);
}

/** Read only. Native identity must be proved by the token's server profile. */
export async function resolveVerifiedNativeClaudeToken(
  expectedEmail: string,
  options: { readCredential?: () => Promise<string | null>; fetchImpl?: FetchLike; now?: number } = {},
): Promise<string | null> {
  if (!expectedEmail.trim()) return null;
  try {
    const blob = await (options.readCredential ?? readCredential)();
    const oauth = blob ? JSON.parse(blob)?.claudeAiOauth : null;
    const token = oauth?.accessToken;
    const now = options.now ?? Date.now();
    if (typeof token !== 'string' || !token || typeof oauth.expiresAt !== 'number' || oauth.expiresAt <= now) return null;
    const canCache = !options.readCredential && !options.fetchImpl;
    let email = canCache && cached?.token === token && cached.until > now ? cached.email : null;
    if (!email) {
      const response = await (options.fetchImpl ?? fetch)(PROFILE_URL, {
        headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' },
        signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS),
      });
      if (!response.ok) return null;
      const profile = profileSchema.safeParse(await response.json());
      if (!profile.success) return null;
      email = profile.data.account.email.trim().toLowerCase();
      if (canCache) cached = { token, email, until: now + PROFILE_CACHE_MS };
    }
    return email === expectedEmail.trim().toLowerCase() ? token : null;
  } catch {
    return null;
  }
}
