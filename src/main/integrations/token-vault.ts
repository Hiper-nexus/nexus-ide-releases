/**
 * User-global forge tokens (GitHub PAT, Linear API key) via secrets store.
 * Never written into project `.nexus/` trees.
 */
import { execFileSync } from 'node:child_process';
import {
  hasStoredVoiceApiKey,
  resolveVoiceApiKey,
  setVoiceApiKey,
} from '../voice/voice-secrets';

const GITHUB_ENV = 'NEXUS_GITHUB_TOKEN';
const GITLAB_ENV = 'NEXUS_GITLAB_TOKEN';
const LINEAR_ENV = 'NEXUS_LINEAR_API_KEY';
const GH_TOKEN_TTL_MS = 60_000;

let ghCliTokenCache: { value: string | null; at: number } | null = null;
let glabCliTokenCache: { value: string | null; at: number } | null = null;

/** Token da sessão de um CLI de forge (gh/glab) — lido on-demand, nunca
 * persistido pelo Nexus, cacheado 60s. */
function forgeCliToken(
  bin: string,
  cache: { value: string | null; at: number } | null,
  save: (next: { value: string | null; at: number }) => void,
): string | null {
  const now = Date.now();
  if (cache && now - cache.at < GH_TOKEN_TTL_MS) return cache.value;
  let value: string | null = null;
  try {
    const out = execFileSync(bin, ['auth', 'token'], {
      encoding: 'utf8',
      timeout: 3_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    value = out.length > 0 ? out : null;
  } catch {
    value = null;
  }
  save({ value, at: now });
  return value;
}

/**
 * Fallback sem setup (paridade Orca): quando não há PAT salvo nem env, usa a
 * sessão do GitHub CLI (`gh auth token`) já autenticada na máquina. O token
 * nunca é persistido pelo Nexus — é lido on-demand do gh (que o guarda no
 * Keychain dele) e cacheado por 60s para não pagar um exec por listagem.
 * O PATH real do usuário já foi resolvido no boot (path-resolver).
 */
function ghCliToken(): string | null {
  return forgeCliToken('gh', ghCliTokenCache, (next) => {
    ghCliTokenCache = next;
  });
}

function glabCliToken(): string | null {
  return forgeCliToken('glab', glabCliTokenCache, (next) => {
    glabCliTokenCache = next;
  });
}

export function getGitlabToken(): string | null {
  return resolveVoiceApiKey(GITLAB_ENV)?.trim() || glabCliToken();
}

export function setGitlabToken(token: string): { ok: boolean; error?: string } {
  return setVoiceApiKey(GITLAB_ENV, token.trim());
}

export function hasGitlabToken(): boolean {
  return (
    hasStoredVoiceApiKey(GITLAB_ENV) ||
    Boolean(process.env[GITLAB_ENV]?.trim()) ||
    glabCliToken() !== null
  );
}

export function getGithubToken(): string | null {
  return resolveVoiceApiKey(GITHUB_ENV)?.trim() || ghCliToken();
}

export function setGithubToken(token: string): { ok: boolean; error?: string } {
  return setVoiceApiKey(GITHUB_ENV, token.trim());
}

export function hasGithubToken(): boolean {
  // Presence checks are used by renderer status/IPC during launch. Do not
  // decrypt a cold Keychain item just to answer a boolean.
  return (
    hasStoredVoiceApiKey(GITHUB_ENV) ||
    Boolean(process.env[GITHUB_ENV]?.trim()) ||
    ghCliToken() !== null
  );
}

export function getLinearKey(): string | null {
  return resolveVoiceApiKey(LINEAR_ENV)?.trim() || null;
}

export function setLinearKey(key: string): { ok: boolean; error?: string } {
  return setVoiceApiKey(LINEAR_ENV, key.trim());
}

export function hasLinearKey(): boolean {
  return hasStoredVoiceApiKey(LINEAR_ENV) || Boolean(process.env[LINEAR_ENV]?.trim());
}

export function maskedGithubToken(): string | null {
  const key = process.env[GITHUB_ENV]?.trim() ||
    (hasStoredVoiceApiKey(GITHUB_ENV) ? '••••••' : null);
  if (!key) return ghCliToken() ? 'sessão do gh CLI' : null;
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}
