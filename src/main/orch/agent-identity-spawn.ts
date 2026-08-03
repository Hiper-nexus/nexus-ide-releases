/**
 * Issue persistent agent attestation at spawn time.
 *
 * Product floor (Autopilot / Overclock-order): `agentAttestationGate` defaults
 * to `off`, so this is a no-op on the critical path. When Hardened enables
 * `required`, prefer {@link issueAgentIdentityBestEffort} at spawn so a locked
 * vault never blocks the first PTY — handoff still fails closed later if the
 * material is missing.
 */
import type { ProjectExecutionScope } from '../../shared/types';
import { isAgentAttestationRequired } from '../../shared/settings-types';
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
  // Only when Hardened crypto handoffs are explicitly enabled.
  if (!isAgentAttestationRequired(getOrchSettings().agentAttestationGate)) {
    return;
  }
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

/** Spawn path: never throw — PTY availability beats keyring readiness. */
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
