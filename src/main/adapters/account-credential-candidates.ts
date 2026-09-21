import fs from 'node:fs';
import path from 'node:path';
import { compareAuthFreshness } from './auth-freshness';
import {
  compareAuthBlobIdentity,
  authBlobIsUsable,
  identityFromAuthBlob,
  MANAGED_PROVIDER_SPECS,
  readBackFresherAuth,
  type FileAuthAdapterId,
} from './managed-credentials';

function matchesSavedIdentity(adapterId: FileAuthAdapterId, saved: string, candidate: string): boolean {
  const subject = identityFromAuthBlob(adapterId, saved).subject;
  if (subject) return identityFromAuthBlob(adapterId, candidate).subject === subject;
  return compareAuthBlobIdentity(adapterId, saved, candidate) === 'same';
}

/** Read-only: CLI renewal remains owned by the CLI, not quota polling. */
export function accountCredentialCandidates(
  adapterId: FileAuthAdapterId,
  accountId: string,
  vaultBlob: string | null,
): string[] {
  let managed = vaultBlob ? readBackFresherAuth(adapterId, accountId, vaultBlob) : null;
  const requiresIdentity = adapterId === 'codex' || adapterId === 'grok';
  if (requiresIdentity && managed && vaultBlob &&
    !matchesSavedIdentity(adapterId, vaultBlob, managed)) managed = null;
  const candidates = [managed, vaultBlob].filter((blob): blob is string => Boolean(blob));
  // These two providers expose stable subjects in their auth.json. Other
  // providers keep their existing capture/refresh authority.
  if (!requiresIdentity || !vaultBlob) return candidates;
  const home = MANAGED_PROVIDER_SPECS[adapterId].systemHome();
  if (!home) return candidates;
  try {
    const native = fs.readFileSync(path.join(home, 'auth.json'), 'utf8');
    const matches = matchesSavedIdentity(adapterId, vaultBlob, native);
    if (matches && authBlobIsUsable(adapterId, native) && !candidates.includes(native)) candidates.push(native);
  } catch {
    // Missing/unreadable native login cannot replace the saved account.
  }
  return candidates.sort((left, right) => -(compareAuthFreshness(left, right) ?? 0));
}
