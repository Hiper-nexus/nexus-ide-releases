import { randomUUID } from 'node:crypto';
import type { Mission } from '../../shared/orch-types';
import type { MissionWorkspaceBinding } from '../../shared/mission-intent';
import type { ProjectExecutionScope } from '../../shared/types';
import { preparePaneSpaceWorktree, resolvePaneSpaceWorktree, sharedPaneSpaceId } from '../pty/pane-space-worktree';
import { requireWorktreeRuntimeRegistry } from '../runtime/worktree-runtime-registry';

type ExecutionMission = Pick<Mission, 'intentContract'>;

/** Coordination/database identity stays unchanged; only filesystem consumers use this scope. */
export function missionExecutionScope(scope: ProjectExecutionScope, mission: ExecutionMission): ProjectExecutionScope {
  const id = mission.intentContract?.workspaceBinding?.spaceId;
  return id ? resolvePaneSpaceWorktree(scope, id) : scope;
}

export function missionExecutionBaseSha(scope: ProjectExecutionScope, mission: ExecutionMission): string | undefined {
  const id = mission.intentContract?.workspaceBinding?.spaceId;
  if (!id) return undefined;
  missionExecutionScope(scope, mission);
  return requireWorktreeRuntimeRegistry().get(scope, id, 'tab')!.baseSha;
}

export function newMissionWorkspaceBinding(): MissionWorkspaceBinding {
  return { version: 1, spaceId: `space-${randomUUID()}` };
}

export function adoptedMissionWorkspaceBinding(scope: ProjectExecutionScope, execution: ProjectExecutionScope, paneId: string): MissionWorkspaceBinding {
  if (execution.rootRealPath === scope.rootRealPath) return { version: 1, adoptedPaneId: paneId };
  const spaceId = sharedPaneSpaceId(scope, execution);
  if (!spaceId) throw new Error('Esse painel não pertence a uma aba de trabalho do projeto. Escolha outro painel para liderar.');
  return { version: 1, spaceId, adoptedPaneId: paneId };
}

/** Only a new reviewed mission may allocate. Resumes resolve the existing durable record. */
export async function prepareMissionExecutionScope(scope: ProjectExecutionScope, mission: ExecutionMission): Promise<ProjectExecutionScope> {
  const binding = mission.intentContract?.workspaceBinding;
  if (!binding?.spaceId) return scope;
  if (binding.adoptedPaneId || mission.intentContract?.dispatchedAt !== undefined || (mission.intentContract?.intentVersion ?? 0) > 1) return missionExecutionScope(scope, mission);
  return (await preparePaneSpaceWorktree(scope, binding.spaceId)).scope;
}

export function assertTabSupportsOperation(scope: ProjectExecutionScope, execution: ProjectExecutionScope, operation: string, sharedTabWorktree = false): void {
  // A missing record cannot erase provenance already minted into a live bearer.
  if (sharedTabWorktree || sharedPaneSpaceId(scope, execution)) {
    throw new Error(`A operação ${operation} ainda não suporta a pasta isolada da aba. Use os panes da própria aba e a revisão automática da missão; não execute essa operação no checkout principal.`);
  }
}
