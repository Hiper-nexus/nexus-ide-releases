/**
 * User-global forge tokens (GitHub PAT, Linear API key) via secrets store.
 * Never written into project `.nexus/` trees.
 */
import {
  getVoiceApiKey,
  resolveVoiceApiKey,
  setVoiceApiKey,
} from '../voice/voice-secrets';

const GITHUB_ENV = 'NEXUS_GITHUB_TOKEN';
const LINEAR_ENV = 'NEXUS_LINEAR_API_KEY';

export function getGithubToken(): string | null {
  return resolveVoiceApiKey(GITHUB_ENV)?.trim() || null;
}

export function setGithubToken(token: string): { ok: boolean; error?: string } {
  return setVoiceApiKey(GITHUB_ENV, token.trim());
}

export function hasGithubToken(): boolean {
  return Boolean(getGithubToken());
}

export function getLinearKey(): string | null {
  return resolveVoiceApiKey(LINEAR_ENV)?.trim() || null;
}

export function setLinearKey(key: string): { ok: boolean; error?: string } {
  return setVoiceApiKey(LINEAR_ENV, key.trim());
}

export function hasLinearKey(): boolean {
  return Boolean(getLinearKey());
}

export function maskedGithubToken(): string | null {
  const key = getVoiceApiKey(GITHUB_ENV);
  if (!key) return null;
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}
