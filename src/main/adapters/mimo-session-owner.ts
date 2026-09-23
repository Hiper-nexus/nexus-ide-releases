import { createHash } from 'node:crypto';
import type { ProjectExecutionScope } from '../../shared/types';
import { providerSessionAccountIsCompatible } from '../persistence/provider-session-store';
import { parseMimoAuth, readMimoNativeAuthBlob } from './mimo-auth';

/** Private ownership key, never the renderer's sessionFingerprint or a public account id. */
export function mimoSessionOwnerKey(auth: { key: string; uid?: string; baseUrl: string }): string {
  return `native:${createHash('sha256').update(JSON.stringify([
    auth.uid ? 'uid' : 'key', auth.uid ?? auth.key, auth.baseUrl,
  ])).digest('hex')}`;
}

export function currentMimoSessionOwnerKey(selectedApiKey?: string): string | null {
  if (selectedApiKey?.trim()) return mimoSessionOwnerKey({ key: selectedApiKey.trim(), baseUrl: 'https://api.xiaomimimo.com/v1' });
  try {
    const auth = parseMimoAuth(readMimoNativeAuthBlob() ?? '');
    return auth ? mimoSessionOwnerKey(auth) : null;
  } catch { return null; }
}

/** The PTY calls this before emitting --session, using Main's selected key override. */
export function canResumeMimoNativeSession(scope: ProjectExecutionScope, sessionId: string, selectedApiKey?: string): boolean {
  const owner = currentMimoSessionOwnerKey(selectedApiKey);
  return owner !== null && providerSessionAccountIsCompatible(scope, 'mimo-code', sessionId, undefined, owner);
}
