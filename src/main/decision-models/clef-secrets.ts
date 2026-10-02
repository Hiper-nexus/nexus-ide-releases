import { CLEF_SECRET_NAME, CLEF_TOKEN_ENV, CLEF_ACCOUNT_ENV } from '../../shared/decision-models';
import { getSecret, hasSecret, isSecureStorageAvailable, setSecret } from '../persistence/secrets-store';
import { bumpDecisionCredentialRevision } from './decision-revision';

export function getClefApiToken(): string | null {
  return getSecret(CLEF_SECRET_NAME);
}

export function resolveClefApiToken(): string | undefined {
  return getClefApiToken()?.trim() || process.env[CLEF_TOKEN_ENV]?.trim() || undefined;
}

export function hasStoredClefApiToken(): boolean {
  return hasSecret(CLEF_SECRET_NAME);
}

export function hasClefEnvToken(): boolean {
  return Boolean(process.env[CLEF_TOKEN_ENV]?.trim());
}

export function hasClefCredential(): boolean {
  return hasStoredClefApiToken() || hasClefEnvToken();
}

export function resolveCloudflareAccountId(accountId: string): string | undefined {
  const candidate = accountId.trim() || process.env[CLEF_ACCOUNT_ENV]?.trim();
  return candidate && /^[a-fA-F0-9]{32}$/.test(candidate) ? candidate.toLowerCase() : undefined;
}

/**
 * Mostra 3 + 4 caracteres de um token de ~40: o mesmo padrão da máscara do Jev
 * e o que a própria Cloudflare exibe. Reduz a entropia restante em ~7 caracteres;
 * se o formato do token passar a ser curto, encurte a máscara aqui.
 */
export function maskedClefApiToken(): string | null {
  const token = getClefApiToken();
  if (!token) return null;
  return token.length <= 8 ? '••••' : `${token.slice(0, 3)}…${token.slice(-4)}`;
}

export function setClefApiToken(token: string): { ok: boolean; error?: string } {
  const result = setSecret(CLEF_SECRET_NAME, token.trim());
  if (result.ok) bumpDecisionCredentialRevision();
  return result;
}

export function isClefSecretStorageAvailable(): boolean {
  return isSecureStorageAvailable({ probe: false });
}
