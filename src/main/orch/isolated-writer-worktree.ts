import { randomUUID } from 'node:crypto';
import type { ProjectExecutionScope } from '../../shared/types';
import { requireWorktreeRuntimeRegistry } from '../runtime/worktree-runtime-registry';
import { tapSessionExit } from '../pty/pty-manager';
import { getPaneRuntimeAuthorityBySession } from './pane-registry';

/** Allocate through the same durable CAS + Git + optional CoW as sealed tasks. */
export async function allocateIsolatedWriterWorktree(
  scope: ProjectExecutionScope,
  missionId: string,
) {
  const workerId = randomUUID();
  const registry = requireWorktreeRuntimeRegistry();
  const record = await registry.create({
    scope,
    missionId,
    taskId: `pane-${workerId}`,
    workerId,
    ownerKind: 'pane',
    // No sealed file claims: the Maestro owns integration of these branches.
    ownership: { files: [], symbols: [], domains: [`pane-${workerId}`] },
  });
  let released = false;
  const release = () => {
    if (released) return;
    registry.markFailed(scope, missionId, record.taskId,
      'pane writer closed or spawn failed; worktree and branch retained for integration');
    released = true;
    untap();
  };
  // PTY taps run only after physical process-tree exit is proven. This covers
  // user close, natural exit and the existing mission termination/teardown.
  // Register before spawning, including the renderer's pending-ACK lane.
  const untap = tapSessionExit((sessionId, agent) => {
    const authority = agent ? null : getPaneRuntimeAuthorityBySession(sessionId);
    const executionRoot = agent?.scope.rootRealPath ?? authority?.executionScope?.rootRealPath;
    if ((agent?.missionId ?? authority?.missionId) === missionId &&
      executionRoot === record.worktreePath) release();
  });
  return { worktreePath: record.worktreePath, branch: record.branchRef.slice('refs/heads/'.length), release };
}
