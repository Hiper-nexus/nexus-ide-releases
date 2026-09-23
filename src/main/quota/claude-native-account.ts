import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { readNativeOAuthCredential } from '../adapters/native-oauth-keychain';
import type { FetchLike } from './claude-oauth-usage';

const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const PROFILE_TIMEOUT_MS = 8_000;
const PROFILE_CACHE_MS = 5 * 60_000;
const MAX_CACHED_PROFILES = 32;
const profileSchema = z.object({ account: z.object({ uuid: z.string().min(1), email: z.string().email() }) });

type ProfileResult =
  | { kind: 'ok'; email: string; accountUuid: string }
  | { kind: 'auth-expired' | 'unavailable' };
const profileCache = new Map<string, { profile: Extract<ProfileResult, { kind: 'ok' }>; until: number }>();

async function fetchProfileEmail(token: string, fetchImpl: FetchLike): Promise<ProfileResult> {
  try {
    const response = await fetchImpl(PROFILE_URL, {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' },
      signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { kind: response.status === 401 || response.status === 403 ? 'auth-expired' : 'unavailable' };
    }
    const profile = profileSchema.safeParse(await response.json());
    return profile.success
      ? {
          kind: 'ok',
          email: profile.data.account.email.trim().toLowerCase(),
          accountUuid: profile.data.account.uuid,
        }
      : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}

async function profileForToken(
  token: string,
  now: number,
  fetchImpl: FetchLike,
  cacheAllowed: boolean,
): Promise<ProfileResult> {
  const cached = cacheAllowed ? profileCache.get(token) : undefined;
  if (cached && cached.until > now) return cached.profile;
  const profile = await fetchProfileEmail(token, fetchImpl);
  if (cacheAllowed && profile.kind === 'ok') {
    // Bounded, process-local proof: a different access token never inherits it.
    if (profileCache.size >= MAX_CACHED_PROFILES) profileCache.delete(profileCache.keys().next().value!);
    profileCache.set(token, { profile, until: now + PROFILE_CACHE_MS });
  }
  return profile;
}

/** Provider identity for an explicit post-login capture; no local owner inference. */
export async function resolveClaudeCredentialProfile(
  blob: string | null,
  options: { fetchImpl?: FetchLike; now?: number } = {},
): Promise<{ email: string; accountUuid: string } | null> {
  try {
    const oauth = blob ? JSON.parse(blob)?.claudeAiOauth : null;
    const now = options.now ?? Date.now();
    if (typeof oauth?.accessToken !== 'string' || !oauth.accessToken ||
        typeof oauth.expiresAt !== 'number' || oauth.expiresAt <= now) return null;
    const profile = await profileForToken(oauth.accessToken, now,
      options.fetchImpl ?? fetch, !options.fetchImpl);
    return profile.kind === 'ok'
      ? { email: profile.email, accountUuid: profile.accountUuid }
      : null;
  } catch {
    return null;
  }
}

/** A managed Claude quota/credential is usable only for its saved account. */
export async function probeClaudeCredentialIdentity(
  blob: string | null,
  expectedEmail: string | undefined,
  options: { fetchImpl?: FetchLike; now?: number; expectedAccountUuid?: string } = {},
): Promise<'match' | 'mismatch' | 'auth-expired' | 'unavailable'> {
  if (!expectedEmail?.trim()) return 'unavailable';
  let oauth: { accessToken?: unknown; expiresAt?: unknown } | undefined;
  try { oauth = blob ? JSON.parse(blob)?.claudeAiOauth : undefined; }
  catch { return 'auth-expired'; }
  const now = options.now ?? Date.now();
  if (typeof oauth?.accessToken !== 'string' || !oauth.accessToken ||
      typeof oauth.expiresAt !== 'number' || oauth.expiresAt <= now) return 'auth-expired';
  const profile = await profileForToken(
    oauth.accessToken, now, options.fetchImpl ?? fetch, !options.fetchImpl,
  );
  if (profile.kind !== 'ok') return profile.kind;
  return profile.email === expectedEmail.trim().toLowerCase() &&
    (!options.expectedAccountUuid || profile.accountUuid === options.expectedAccountUuid)
    ? 'match' : 'mismatch';
}

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
    const profile = await profileForToken(
      token, now, options.fetchImpl ?? fetch, !options.readCredential && !options.fetchImpl,
    );
    return profile.kind === 'ok' && profile.email === expectedEmail.trim().toLowerCase()
      ? token : null;
  } catch {
    return null;
  }
}
