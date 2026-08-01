/**
 * Issue persistent agent attestation at spawn time (best-effort log on
 * failure — spawn itself must not die because the vault is briefly locked,
 * but the handoff gate will fail closed later if material is missing when
 * required).
 */
import type { ProjectExecutionScope } from '../../shared/types';
import { getOrchSettings } from '../persistence/settings-store';
import { getMissionEventRuntimeManager } from './mission-event-emit';
import {
  agentKeyringRegistry,
  defaultHandoffAttestationWindow,
  ensurePersistentAgentIdentity,
} from './agent-keyring-persistence';

export function withMissionWriteDatabase(
  scope: Readonly<ProjectExecutionScope>,
  fn: (db: import('better-sqlite3').Database) => void,
): void {
  const manager = getMissionEventRuntimeManager();
  if (!manager) {
    throw new Error('project runtime manager unavailable for agent identity');
  }
  const runtime = manager.open(scope);
  runtime.assertWritable();
  fn(runtime.db);
}

export function issueAgentIdentityRequired(input: {
  readonly missionId: string;
  readonly scope: Readonly<ProjectExecutionScope>;
  readonly agentId: string;
}): void {
  // Test/legacy callers that explicitly omit the gate retain the pre-identity
  // spawn contract. Production defaults the setting to `required`, so a vault
  // or migration failure blocks the spawn before a child can become orphaned.
  if (getOrchSettings().agentAttestationGate !== 'required') return;
  withMissionWriteDatabase(input.scope, (db) => {
    const window = defaultHandoffAttestationWindow(
      Math.floor(Date.now() / 1000),
    );
    ensurePersistentAgentIdentity(db, agentKeyringRegistry, {
      missionId: input.missionId,
      ownerId: `mission:${input.missionId}`,
      agentId: input.agentId,
      kind: window.kind,
      createdAt: window.createdAt,
      expiresAt: window.expiresAt,
    });
  });
}

export function issueAgentIdentityBestEffort(input: {
  readonly missionId: string;
  readonly scope: Readonly<ProjectExecutionScope>;
  readonly agentId: string;
}): void {
  try {
    issueAgentIdentityRequired(input);
  } catch (error) {
    console.warn(
      '[agent-identity] issuance skipped:',
      error instanceof Error ? error.message : error,
    );
  }
}
