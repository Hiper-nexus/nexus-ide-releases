import { createHash } from 'node:crypto';
import type { OwnedAgentSessionInfo } from './pty-manager';

// Main-only launch proof. No prompt text, IPC, persistence or telemetry.
export type NativeArgvIdentity = Pick<OwnedAgentSessionInfo,
  'sessionId' | 'paneId' | 'adapterId' | 'accountId' | 'model' | 'scope' |
  'coordinationScope' | 'source' | 'role' | 'missionId' | 'workerIncarnationId' |
  'authoritySeal' | 'cwd' | 'requestedModel' | 'effort' | 'readOnly' | 'nativeReadOnly' |
  'allowedTools' | 'allowedSkills' | 'operatorOpened' | 'promotedFromUser'>;

export function nativeArgvIdentityKey(info: NativeArgvIdentity): string {
  const scope = (value: NativeArgvIdentity['scope'] | undefined) => value
    ? [value.version, value.installationId, value.projectId, value.checkoutId, value.rootRealPath, value.identitySource,
      value.workspaceRootDevice, value.workspaceRootInode] : null;
  const seal = info.authoritySeal;
  return JSON.stringify([info.sessionId, info.paneId, info.adapterId, info.accountId,
    info.model, info.requestedModel, info.effort, info.readOnly, info.nativeReadOnly,
    info.allowedTools, info.allowedSkills, info.operatorOpened, info.promotedFromUser, info.cwd, scope(info.scope), scope(info.coordinationScope), info.source,
    info.role, info.missionId, info.workerIncarnationId, seal ? [seal.intentVersion,
      seal.intentContractHash, seal.contextRevision, seal.contractHash, seal.squadRevisionHash] : null]);
}
const launches = new Map<string, { startKey: string; identity: string;
  digest: string; gateToken?: string; submitted: boolean; accepted: boolean }>();
const digest = (prompt: string) => createHash('sha256').update(prompt, 'utf8').digest('hex');

/** Called only at the physical boundary after final argv placement. */
export function armNativeArgvAcceptance(info: NativeArgvIdentity, startKey: string, prompt: string, gateToken?: string): void {
  launches.set(info.sessionId, { startKey, identity: nativeArgvIdentityKey(info),
    digest: digest(prompt), gateToken, submitted: false, accepted: false });
}
export function forgetNativeArgvAcceptance(sessionId: string): void { launches.delete(sessionId); }

/** Only the first applied, authenticated native UserPromptSubmit is eligible.
 * A missing/mismatching first prompt permanently closes this generation. */
export function recordNativeArgvSubmission(info: NativeArgvIdentity, startKey: string, prompt: unknown, gateToken?: string): void {
  const launch = launches.get(info.sessionId);
  if (!launch || launch.submitted) return;
  launch.submitted = true;
  launch.accepted = launch.gateToken === gateToken && launch.startKey === startKey && launch.identity === nativeArgvIdentityKey(info)
    && typeof prompt === 'string' && launch.digest === digest(prompt);
}
export function acceptedNativeArgvPrompt(info: NativeArgvIdentity, startKey: string, prompt: string, gateToken?: string): boolean {
  const launch = launches.get(info.sessionId);
  return Boolean(launch?.accepted && launch.gateToken === gateToken && launch.startKey === startKey
    && launch.identity === nativeArgvIdentityKey(info) && launch.digest === digest(prompt));
}
