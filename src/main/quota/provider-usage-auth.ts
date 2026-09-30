/**
 * Resolve credentials for live provider usage probes.
 * Never logs secrets. Best-effort; empty list = skip network probe.
 *
 * Pinned rows use only that account. Unpinned rows may try the operator's
 * configured vault, launcher, environment, and native login candidates.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getKey,
  getSecret,
  setSecret,
} from '../persistence/secrets-store';
import { loadLauncherProviderKey } from '../adapters/launcher-provider-manager';
import { fileSubscriptionAuthEnv, getAccount } from '../persistence/account-store';
import {
  parseCodexAuthJson,
  type CodexChatGptAuth,
} from './codex-usage';
import { extractClaudeAccessToken } from './claude-oauth-usage';
import { readNativeOAuthCredential } from '../adapters/native-oauth-keychain';
import { hasManagedClaudeAuth, readManagedClaudeAuthAsync } from '../adapters/managed-claude-auth';
import { accountCredentialCandidates } from '../adapters/account-credential-candidates';
import { probeCodexCliUsage } from './codex-cli-usage';
import type { LiveProviderProbe } from './provider-live-usage';
import { probeClaudeCredentialIdentity } from './claude-native-account';
import { kimiNativeCredentialFiles } from '../adapters/kimi-credential-files';

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
  try {
    return getKey(adapterId)?.trim() || null;
  } catch {
    return null;
  }
}

function safeGetSecret(key: string): string | null {
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

function declaredAnthropicToken(adapterId: string): string | null {
  const expectedHost = adapterId === 'glm' || adapterId === 'glm-flash' ? 'api.z.ai'
    : adapterId === 'longcat' ? 'api.longcat.chat' : null;
  if (!expectedHost) return null;
  try {
    const url = new URL(process.env.ANTHROPIC_BASE_URL ?? '');
    return url.protocol === 'https:' && url.hostname === expectedHost && !url.username && !url.password
      ? process.env.ANTHROPIC_AUTH_TOKEN?.trim() || null : null;
  } catch {
    return null;
  }
}

/**
 * Claude OAuth token for the renderer quota probe.
 *
 * Pinned probes only read the verified account secret. Refresh is owned by
 * account-store or the Claude CLI so quota cannot rotate the same grant twice.
 * Unpinned probes read file credentials or the native Keychain asynchronously.
 */
export async function resolveClaudeToken(accountId?: string): Promise<string | null> {
  if (accountId) {
    const account = getAccount(accountId);
    if (account?.adapterId !== 'claude') return null;
    const ownedToken = async (blob: string | null): Promise<string | null> => {
      if (!blob || claudeAccessExpired(blob) ||
          await probeClaudeCredentialIdentity(blob, account.email) !== 'match') return null;
      return extractClaudeAccessToken(blob);
    };
    // Managed Claude profiles are renewed by the CLI/sweeper through their
    // scoped secure-storage directory. A quota probe must only read that
    // profile; refreshing the vault blob here would create a second OAuth
    // actor and race the pane's refresh lock.
    if (hasManagedClaudeAuth(accountId)) {
      const managed = await readManagedClaudeAuthAsync(accountId);
      return ownedToken(managed);
    }
    const blob = safeGetSecret(CRED_PREFIX + accountId);
    return ownedToken(blob);
  }

  // The native file belongs to the Claude CLI, which owns its refresh.
  // Quota only reads it; rotating the grant here would race the CLI.
  const blob = readText(
    path.join(os.homedir(), '.claude', '.credentials.json'),
  );
  const fileToken = blob ? extractClaudeAccessToken(blob) : null;
  if (fileToken || process.platform !== 'darwin') return fileToken;
  const native = await readNativeOAuthCredential('Claude Code-credentials');
  return native ? extractClaudeAccessToken(native) : null;
}

function claudeAccessExpired(blob: string): boolean {
  try {
    const expiresAt = JSON.parse(blob)?.claudeAiOauth?.expiresAt;
    return typeof expiresAt === 'number' && expiresAt <= Date.now();
  } catch { return true; }
}

/**
 * Evidência de que o login nativo do Claude existiu: `oauthAccount` no
 * `~/.claude.json` sobrevive à rotação da credencial do keychain. Sem
 * token resolvível MAS com este bloco → a sessão morreu (auth-expired),
 * não «nunca conectou» (no-credential).
 */
/**
 * `expiresAt` do access token nativo (cliente). O refresh da linhagem
 * nativa pertence ao CLI — nós só lemos: token vencido + refresh
 * desconhecido = «sessão expirada» honesto, não «sem informação».
 */
export function claudeNativeAccessTokenExpiresAt(): number | null {
  const blob = readText(
    path.join(os.homedir(), '.claude', '.credentials.json'),
  );
  if (!blob) return null;
  try {
    const parsed = JSON.parse(blob) as Record<string, unknown>;
    const oauth = (parsed.claudeAiOauth ?? parsed) as Record<string, unknown>;
    const exp = oauth?.expiresAt;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp : null;
  } catch {
    return null;
  }
}

export function hasClaudeNativeSession(configDir?: string): boolean {
  try {
    const file = configDir
      ? path.join(configDir, '.claude.json')
      : path.join(os.homedir(), '.claude.json');
    const raw = JSON.parse(readText(file) ?? 'null') as Record<
      string,
      unknown
    > | null;
    const acct = raw?.oauthAccount as Record<string, unknown> | undefined;
    return Boolean(
      acct && (acct.emailAddress || acct.organizationUuid),
    );
  } catch {
    return false;
  }
}

/** Codex auth for the exact account, or the unpinned native login. */
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
      for (const blob of accountCredentialCandidates('codex', accountId,
        safeGetSecret(CRED_PREFIX + accountId))) add(parseCodexAuthJson(blob));
    }
    return out;
  }

  // Only the unpinned row may observe the current system login.
  const system = readText(path.join(os.homedir(), '.codex', 'auth.json'));
  if (system) add(parseCodexAuthJson(system));

  return out;
}

/** Back-compat: first codex auth candidate. */
export function resolveCodexAuth(accountId?: string): CodexChatGptAuth | null {
  return resolveCodexAuthCandidates(accountId)[0] ?? null;
}

/** Prepare the same durable account home used by panes, never the native login. */
export async function fetchCodexAccountUsage(accountId: string): Promise<LiveProviderProbe> {
  const account = getAccount(accountId);
  if (account?.adapterId !== 'codex' || account.mode !== 'subscription') return { windows: null, hint: 'no-credential' };
  const env = fileSubscriptionAuthEnv(account);
  const expectedAuthBlob = safeGetSecret(CRED_PREFIX + accountId);
  if (!env?.CODEX_HOME || !expectedAuthBlob) return { windows: null, hint: 'no-credential' };
  const probe = await probeCodexCliUsage({ authFile: path.join(env.CODEX_HOME, 'auth.json'), expectedAuthBlob });
  return { windows: probe.windows, ...(probe.failure ? { hint: probe.failure } : {}) };
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
    if (getAccount(accountId)?.adapterId !== adapterId) return out;
    pushUnique(out, safeGetSecret(KEY_PREFIX + accountId));
    return out;
  }

  pushUnique(out, safeGetKey(adapterId));

  try {
    pushUnique(out, loadLauncherProviderKey(adapterId));
  } catch {
    // ignore
  }

  if (adapterId === 'glm' || adapterId === 'glm-flash') {
    for (const alias of ['zai', 'zhipu', 'z-ai', 'z.ai'] as const) {
      pushUnique(out, safeGetKey(alias));
      try {
        pushUnique(out, loadLauncherProviderKey(alias));
      } catch {
        // ignore
      }
    }
    for (const envName of [
      'ZAI_API_KEY',
      'ZHIPU_API_KEY',
      'ZHIPUAI_API_KEY',
    ]) {
      pushUnique(out, process.env[envName]);
    }
    pushUnique(out, declaredAnthropicToken(adapterId));
  }

  if (adapterId === 'longcat') {
    for (const envName of ['LONGCAT_API_KEY']) {
      pushUnique(out, process.env[envName]);
    }
    pushUnique(out, declaredAnthropicToken(adapterId));
  }

  if (adapterId === 'minimax-code') {
    // A Subscription Key do Token Plan é a mesma chave da rota `minimax`
    // (Claude no endpoint Anthropic da MiniMax): cofre/launcher antes do env.
    pushUnique(out, safeGetKey('minimax'));
    try {
      pushUnique(out, loadLauncherProviderKey('minimax'));
    } catch {
      // ignore
    }
    pushUnique(out, process.env.MINIMAX_API_KEY);
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
    const account = getAccount(accountId);
    if (account?.adapterId !== 'grok') return out;
    for (const blob of accountCredentialCandidates('grok', accountId,
      safeGetSecret(CRED_PREFIX + accountId))) {
      pushUnique(out, extractGrokKeyFromAuthJson(blob));
      if (!blob.trim().startsWith('{')) pushUnique(out, blob);
    }
  }
  for (const k of resolveProviderApiKeyCandidates('grok', accountId)) {
    pushUnique(out, k);
  }
  if (accountId) return out;
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
    if (getAccount(accountId)?.adapterId !== 'kimi') return out;
    const blob = safeGetSecret(CRED_PREFIX + accountId);
    if (blob) pushUnique(out, extractKimiToken(blob));
  }
  for (const k of resolveProviderApiKeyCandidates('kimi', accountId)) {
    pushUnique(out, k);
  }
  if (accountId) return out;
  // F-694: o Kimi 2.x grava `kimi-code-env-<hash>.json`, não só `kimi-code.json`.
  for (const file of kimiNativeCredentialFiles(os.homedir())) {
    const blob = readText(file);
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
  /**
   * F-694: arquivo nativo de onde o grant foi lido. A rotação do refresh token
   * volta a ELE — gravar noutro arquivo deixaria a CLI com o token revogado.
   */
  sourcePath?: string;
}

/**
 * Full Kimi OAuth blob from CLI credentials (for refresh + /usages).
 * Prefer this over bare access token — access expires in ~15 min.
 */
export function resolveKimiOauthCreds(
  accountId?: string,
): KimiOauthCredsResolved | null {
  if (accountId) {
    if (getAccount(accountId)?.adapterId !== 'kimi') return null;
    const blob = safeGetSecret(CRED_PREFIX + accountId);
    if (blob) {
      const c = parseKimiCredsBlob(blob);
      if (c) return c;
    }
    return null;
  }
  for (const file of kimiNativeCredentialFiles(os.homedir())) {
    const blob = readText(file);
    if (blob) {
      const c = parseKimiCredsBlob(blob);
      if (c) return { ...c, sourcePath: file };
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

/**
 * Write-back do grant rotacionado no blob VAULT da conta (linhagem da
 * conta, nunca o ~/.kimi-code nativo). Preserva campos extras do blob —
 * o refresh do token endpoint devolve um grant inteiro, mas o vault pode
 * carregar metadados (email, label) que a releitura precisa manter.
 */
export function persistKimiRotatedCreds(
  accountId: string,
  rotated: { accessToken: string; refreshToken?: string; expiresIn?: number },
  now = Date.now(),
): void {
  if (!accountId || getAccount(accountId)?.adapterId !== 'kimi') return;
  const prior = safeGetSecret(CRED_PREFIX + accountId);
  let base: Record<string, unknown> = {};
  if (prior) {
    try {
      const parsed = JSON.parse(prior) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        base = parsed as Record<string, unknown>;
      }
    } catch {
      base = {};
    }
  }
  const next = {
    ...base,
    access_token: rotated.accessToken,
    ...(rotated.refreshToken ? { refresh_token: rotated.refreshToken } : {}),
    ...(typeof rotated.expiresIn === 'number'
      ? { expires_at: Math.floor(now / 1000) + rotated.expiresIn }
      : {}),
  };
  setSecret(CRED_PREFIX + accountId, JSON.stringify(next));
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
    if (getAccount(accountId)?.adapterId !== 'agy') return null;
    const blob = safeGetSecret(CRED_PREFIX + accountId);
    if (blob) {
      const c = parseGeminiCredsBlob(blob);
      if (c) return c;
    }
    return null;
  }
  const blob = readText(path.join(os.homedir(), '.gemini', 'oauth_creds.json'));
  if (blob) {
    const parsed = parseGeminiCredsBlob(blob);
    if (parsed) return parsed;
  }
  if (process.platform === 'win32') return readAgyWindowsCredential();
  return null;
}

function tokenFields(source: {
  access_token?: unknown;
  refresh_token?: unknown;
  expiry_date?: unknown;
  expiry?: unknown;
}): GeminiOauthCredsResolved | null {
  const accessToken =
    typeof source.access_token === 'string' ? source.access_token : undefined;
  const refreshToken =
    typeof source.refresh_token === 'string' ? source.refresh_token : undefined;
  let expiryDate: number | undefined;
  if (typeof source.expiry_date === 'number') expiryDate = source.expiry_date;
  else if (typeof source.expiry === 'number') expiryDate = source.expiry;
  else if (typeof source.expiry === 'string') {
    const parsed = Date.parse(source.expiry);
    if (!Number.isNaN(parsed)) expiryDate = parsed;
  }
  if (!accessToken && !refreshToken) return null;
  return { accessToken, refreshToken, expiryDate };
}

/**
 * Arquivo `~/.gemini/oauth_creds.json` (tokens no topo) ou o blob do
 * Gerenciador de Credenciais do Windows (`token.access_token`).
 */
export function parseGeminiOauthBlob(blob: string): GeminiOauthCredsResolved | null {
  try {
    const parsed = JSON.parse(blob) as {
      access_token?: unknown;
      refresh_token?: unknown;
      expiry_date?: unknown;
      expiry?: unknown;
      token?: {
        access_token?: unknown;
        refresh_token?: unknown;
        expiry_date?: unknown;
        expiry?: unknown;
      };
    };
    return tokenFields(parsed.token ?? parsed);
  } catch {
    return null;
  }
}

function parseGeminiCredsBlob(blob: string): GeminiOauthCredsResolved | null {
  return parseGeminiOauthBlob(blob);
}

const AGY_WIN_CRED_TTL_MS = 60_000;
let agyWinCredCache: { at: number; value: GeminiOauthCredsResolved | null } | null = null;

/** go-keyring no Windows grava o OAuth em `gemini:antigravity`. Sem segredo no log. */
function readAgyWindowsCredential(): GeminiOauthCredsResolved | null {
  if (process.platform !== 'win32') return null;
  const now = Date.now();
  if (agyWinCredCache && now - agyWinCredCache.at < AGY_WIN_CRED_TTL_MS) {
    return agyWinCredCache.value;
  }
  let value: GeminiOauthCredsResolved | null = null;
  try {
    const script = [
      'Add-Type @"',
      'using System; using System.Runtime.InteropServices; using System.Text;',
      'public class NexusAgyCred {',
      '  [DllImport("advapi32", SetLastError=true, CharSet=CharSet.Unicode)]',
      '  public static extern bool CredRead(string t, int type, int f, out IntPtr p);',
      '  [DllImport("advapi32")] public static extern void CredFree(IntPtr p);',
      '  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]',
      '  public struct C { public uint Flags; public uint Type; public IntPtr TargetName; public IntPtr Comment; public long LastWritten; public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist; public uint AttributeCount; public IntPtr Attributes; public IntPtr TargetAlias; public IntPtr UserName; }',
      '  public static string Read() { IntPtr p; if (!CredRead("gemini:antigravity", 1, 0, out p)) return ""; try { var c = Marshal.PtrToStructure<C>(p); if (c.CredentialBlobSize==0) return ""; var b = new byte[c.CredentialBlobSize]; Marshal.Copy(c.CredentialBlob, b, 0, b.Length); return Encoding.UTF8.GetString(b); } finally { CredFree(p); } }',
      '}',
      '"@',
      '[Console]::Out.Write([NexusAgyCred]::Read())',
    ].join('\n');
    const raw = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', timeout: 8_000, windowsHide: true },
    );
    value = raw.trim() ? parseGeminiOauthBlob(raw) : null;
  } catch {
    value = null;
  }
  agyWinCredCache = { at: now, value };
  return value;
}

export { extractClaudeAccessToken };
