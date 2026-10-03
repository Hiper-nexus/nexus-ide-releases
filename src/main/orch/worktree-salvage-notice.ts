/**
 * F-794 — aviso ao orquestrador quando o Nexus guarda uma salvaguarda da
 * worktree de um writer. Vive fora de `isolated-writer-salvage` para o módulo
 * de Git não importar a entrega de handoffs (idle-delivery puxa o PTY inteiro).
 *
 * O aviso é um handoff SINTÉTICO (autor `nexus-worktree-salvage`, prefixo
 * `nexus-`, status `progress`), pela mesma via durável do supervisor: não
 * conta como relato do worker, não toca dispatch, não fecha missão — só deixa
 * no ledger e no PTY do orquestrador onde está o trabalho e como integrar.
 */
import type { Handoff } from '../../shared/orch-types';
import type { ProjectExecutionScope } from '../../shared/types';
import { getProjectDomainStores, type ProjectDomainStoreSuite } from './project-domain-store-registry';
import { onHandoffSubmitted } from './idle-delivery';
import { OPERATOR_HAND_WORKTREE_KEY } from './isolated-writer-worktree';
import {
  salvageNoticeSummary,
  setWorktreeSalvageNotifier,
  WORKTREE_SALVAGE_ARTIFACT_KIND,
  WORKTREE_SALVAGE_AUTHOR,
  type WorktreeSalvageNotice,
} from './isolated-writer-salvage';

export interface WorktreeSalvageNoticeDeps {
  readonly getStores: (scope: ProjectExecutionScope) => Pick<ProjectDomainStoreSuite, 'missions' | 'handoffs'>;
  readonly deliver: (handoff: Handoff, scope: ProjectExecutionScope) => unknown;
}

const productionDeps: WorktreeSalvageNoticeDeps = {
  getStores: getProjectDomainStores,
  deliver: onHandoffSubmitted,
};

/** Devolve o id do aviso gravado, ou null quando não há missão para avisar. */
export function submitWorktreeSalvageNotice(
  notice: WorktreeSalvageNotice,
  deps: WorktreeSalvageNoticeDeps = productionDeps,
): string | null {
  const { scope, target, result } = notice;
  // Writer da mão do operador não tem orquestrador: fica no trace e na ref.
  if (target.missionId === OPERATOR_HAND_WORKTREE_KEY) return null;
  const suite = deps.getStores(scope);
  if (!suite.missions.get(target.missionId)) return null;
  const handoff = suite.handoffs.submit({
    missionId: target.missionId,
    status: 'progress',
    summary: salvageNoticeSummary(target, result),
    fromAgent: WORKTREE_SALVAGE_AUTHOR,
    artifacts: [{
      kind: WORKTREE_SALVAGE_ARTIFACT_KIND,
      payload: {
        reason: target.reason,
        ref: result.ref,
        commit: result.commit,
        baseSha: result.baseSha,
        branch: target.branchRef.slice('refs/heads/'.length),
        taskId: target.taskId,
        fileCount: result.fileCount,
        files: result.files.slice(0, 50),
        skipped: result.skipped,
        untrackedOmitted: result.untrackedOmitted,
        ...(target.handoffId ? { handoffId: target.handoffId } : {}),
        ...(target.sessionId ? { sessionId: target.sessionId } : {}),
      },
    }],
  });
  deps.deliver(handoff, scope);
  return handoff.id;
}

export function installWorktreeSalvageNotifier(): void {
  setWorktreeSalvageNotifier((notice) => {
    submitWorktreeSalvageNotice(notice);
  });
}
