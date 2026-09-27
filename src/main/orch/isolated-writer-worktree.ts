import { randomUUID } from 'node:crypto';
import type { ProjectExecutionScope } from '../../shared/types';
import type { WorktreeRecord } from '../runtime/worktree-contract';
import { requireWorktreeRuntimeRegistry } from '../runtime/worktree-runtime-registry';
import { tapSessionExit } from '../pty/pty-manager';
import { getPaneRuntimeAuthorityBySession, listPaneSnapshots } from './pane-registry';

/**
 * Chave do registry para writers isolados da mão do operador (sem missão).
 * O registry já é por projeto/checkout; registros `ownerKind: 'pane'` não
 * dependem de linha de task/missão, então uma chave fixa basta.
 */
export const OPERATOR_HAND_WORKTREE_KEY = 'operator-hand';

export interface IsolatedWriterAllocation {
  readonly worktreePath: string;
  readonly branch: string;
  /** Commit de onde a worktree nasceu (HEAD do checkout, sem o WIP dele). */
  readonly baseSha: string;
  readonly release: () => void;
  /** Liga o pane nascido a esta worktree, para `resume` voltar a ela. */
  readonly link: (paneId: string) => void;
}

/**
 * paneId → registro do writer isolado. Autoridade do Main (só o spawn grava);
 * `resume` de um desses panes reabre a MESMA worktree/branch. Vive o processo:
 * no restart o registry já marca todo writer de pane como interrompido.
 */
const paneLinks = new Map<string, { registryKey: string; taskId: string; branch: string }>();

function inUseByPane(worktreePath: string): boolean {
  return listPaneSnapshots().some(
    (pane) => pane.executionScope?.rootRealPath === worktreePath && pane.state !== 'exited',
  );
}

/** GC seguro dos writers da mão do operador já integrados (ver registry). */
function collectIntegratedOperatorHandWorktrees(scope: ProjectExecutionScope): void {
  try {
    requireWorktreeRuntimeRegistry().collectIntegratedPaneWorktrees(scope, OPERATOR_HAND_WORKTREE_KEY, inUseByPane);
  } catch (error) {
    console.warn('[isolated-writer] GC de worktrees integradas adiado', error);
  }
}

function trackAllocation(
  scope: ProjectExecutionScope,
  missionId: string | undefined,
  registryKey: string,
  record: WorktreeRecord,
): IsolatedWriterAllocation {
  const registry = requireWorktreeRuntimeRegistry();
  const branch = record.branchRef.slice('refs/heads/'.length);
  let released = false;
  const release = () => {
    if (released) return;
    registry.markFailed(scope, registryKey, record.taskId,
      'pane writer closed or spawn failed; worktree and branch retained for integration');
    released = true;
    untap();
    if (!missionId) collectIntegratedOperatorHandWorktrees(scope);
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
  return {
    worktreePath: record.worktreePath,
    branch,
    baseSha: record.baseSha,
    release,
    link: (paneId) => { paneLinks.set(paneId, { registryKey, taskId: record.taskId, branch }); },
  };
}

/** Allocate through the same durable CAS + Git + optional CoW as sealed tasks. */
export async function allocateIsolatedWriterWorktree(
  scope: ProjectExecutionScope,
  missionId: string | undefined,
): Promise<IsolatedWriterAllocation> {
  const workerId = randomUUID();
  const registryKey = missionId ?? OPERATOR_HAND_WORKTREE_KEY;
  if (!missionId) collectIntegratedOperatorHandWorktrees(scope);
  const record = await requireWorktreeRuntimeRegistry().create({
    scope,
    missionId: registryKey,
    taskId: `pane-${workerId}`,
    workerId,
    ownerKind: 'pane',
    // No sealed file claims: the Maestro owns integration of these branches.
    ownership: { files: [], symbols: [], domains: [`pane-${workerId}`] },
  });
  return trackAllocation(scope, missionId, registryKey, record);
}

/**
 * `resume` de um writer isolado: reabre a worktree/branch ORIGINAL (prova de
 * identidade no registry). Nunca aloca outra nem cai no checkout do pai.
 * `null` quando o pane retomado não era writer isolado.
 */
export function resumeIsolatedWriterWorktree(
  scope: ProjectExecutionScope,
  missionId: string | undefined,
  fromPaneId: string | undefined,
): IsolatedWriterAllocation | null {
  const link = fromPaneId ? paneLinks.get(fromPaneId) : undefined;
  if (!link) return null;
  const registryKey = missionId ?? OPERATOR_HAND_WORKTREE_KEY;
  if (link.registryKey !== registryKey) {
    throw new Error(`resume: o writer isolado ${fromPaneId} pertence a outro escopo (missão) — retome-o de lá`);
  }
  let record: WorktreeRecord;
  try {
    const registry = requireWorktreeRuntimeRegistry();
    const current = registry.get(scope, registryKey, link.taskId);
    if (current && listPaneSnapshots().some((pane) => pane.executionScope?.rootRealPath === current.worktreePath &&
      !['exited', 'parked', 'hibernated'].includes(pane.state))) {
      throw new Error('ainda há um pane ativo nela');
    }
    record = registry.reopenPaneWriter(scope, registryKey, link.taskId);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `resume: a worktree original do writer isolado ${fromPaneId} (branch ${link.branch}) não está disponível ` +
        `(${reason}). Integre/recupere a branch ou abra um writer novo sem resume.`,
    );
  }
  return trackAllocation(scope, missionId, registryKey, record);
}
