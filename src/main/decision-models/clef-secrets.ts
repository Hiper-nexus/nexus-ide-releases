import { CLEF_SECRET_NAME, CLOUDFLARE_TOKEN_ENV, CLOUDFLARE_ACCOUNT_ENV } from '../../shared/decision-models';
import { getSecret, hasSecret, isSecureStorageAvailable, setSecret } from '../persistence/secrets-store';

export function getClefApiToken(): string | null {
  return getSecret(CLEF_SECRET_NAME);
}

export function resolveClefApiToken(): string | undefined {
  return getClefApiToken()?.trim() || process.env[CLOUDFLARE_TOKEN_ENV]?.trim() || undefined;
}

export function hasStoredClefApiToken(): boolean {
  return hasSecret(CLEF_SECRET_NAME);
}

export function hasClefEnvToken(): boolean {
  return Boolean(process.env[CLOUDFLARE_TOKEN_ENV]?.trim());
}

export function hasClefCredential(): boolean {
  return hasStoredClefApiToken() || hasClefEnvToken();
}

export function resolveCloudflareAccountId(accountId: string): string | undefined {
  const candidate = accountId.trim() || process.env[CLOUDFLARE_ACCOUNT_ENV]?.trim();
  return candidate && /^[a-fA-F0-9]{32}$/.test(candidate) ? candidate.toLowerCase() : undefined;
}

export function maskedClefApiToken(): string | null {
  const token = getClefApiToken();
  if (!token) return null;
  return token.length <= 8 ? '••••' : `${token.slice(0, 3)}…${token.slice(-4)}`;
}

export function setClefApiToken(token: string): { ok: boolean; error?: string } {
  return setSecret(CLEF_SECRET_NAME, token.trim());
}

export function isClefSecretStorageAvailable(): boolean {
  return isSecureStorageAvailable({ probe: false });
}
