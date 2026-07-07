import { randomBytes } from 'node:crypto';
import {
  permissionKey,
  type PermissionScope,
} from './permissions';

const CONFIRMATION_TOKEN_TTL_MS = 30_000;

interface ConfirmationTokenEntry {
  scopeKey: string;
  expiresAt: number;
}

const tokens = new Map<string, ConfirmationTokenEntry>();

function pruneExpiredTokens(now = Date.now()): void {
  for (const [token, entry] of tokens.entries()) {
    if (entry.expiresAt <= now) tokens.delete(token);
  }
}

export function createConfirmationToken(scope: PermissionScope): string {
  pruneExpiredTokens();
  const token = randomBytes(32).toString('hex');
  tokens.set(token, {
    scopeKey: permissionKey(scope),
    expiresAt: Date.now() + CONFIRMATION_TOKEN_TTL_MS,
  });
  return token;
}

export function consumeConfirmationToken(
  token: string,
  scope: PermissionScope,
): boolean {
  pruneExpiredTokens();
  const entry = tokens.get(token);
  if (!entry) return false;
  tokens.delete(token);
  return entry.scopeKey === permissionKey(scope);
}

export function clearConfirmationTokensForTests(): void {
  tokens.clear();
}
