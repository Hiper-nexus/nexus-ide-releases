import { randomUUID } from 'node:crypto';
import type { ProjectExecutionScope } from '../../shared/types';
import type { WorktreeRecord } from '../runtime/worktree-contract';
import { requireWorktreeRuntimeRegistry } from '../runtime/worktree-runtime-registry';
import { tapSessionExit } from '../pty/pty-manager';
import { getPaneRuntimeAuthorityBySession, listPaneSnapshots } from './pane-registry';
import { claimSameCheckoutWriter, hasPendingWriterClaim } from './delegated-writer-gate';
import { getProjectDomainStores } from './project-domain-store-registry';

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
  /**
   * Liga o pane nascido (e a sessão, se já existe) a esta worktree no
   * registry durável — autoridade do Main; `resume` volta a ela mesmo depois
   * de reiniciar o app.
   */
  readonly link: (paneId: string, sessionId?: string) => void;
}

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
  claim?: ReturnType<typeof claimSameCheckoutWriter>,
): IsolatedWriterAllocation {
  const registry = requireWorktreeRuntimeRegistry();
  const branch = record.branchRef.slice('refs/heads/'.length);
  const bind = (binding: { paneId?: string; sessionId?: string }) => {
    try {
      registry.bindPaneWriter(scope, registryKey, record.taskId, binding);
    } catch (error) {
      console.warn('[isolated-writer] vínculo pane→worktree não gravado', error);
    }
  };
  let released = false;
  const release = () => {
    if (released) return;
    claim?.settle();
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
    if ((agent?.missionId ?? authority?.missionId) !== missionId ||
      executionRoot !== record.worktreePath) return;
    // ACK pendente não tinha sessão no spawn: grava-a aqui, para `resume` por
    // id de task (h-N → sessão do handoff) achar esta worktree.
    if (!released) bind({ sessionId });
    release();
  });
  return {
    worktreePath: record.worktreePath,
    branch,
    baseSha: record.baseSha,
    release,
    link: (paneId, sessionId) => {
      claim?.settle(paneId);
      bind({ paneId, sessionId });
    },
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
  if (!fromPaneId) return null;
  const registry = requireWorktreeRuntimeRegistry();
  const linked = registry.findPaneWriter(scope, { paneId: fromPaneId });
  if (!linked) return null;
  let registryKey = missionId ?? OPERATOR_HAND_WORKTREE_KEY;
  if (linked.missionId !== registryKey) {
    // Missão dona encerrada (ou apagada): o pane voltou à mão do operador e
    // o trabalho não integrado da worktree tem que continuar alcançável.
    const owner = !missionId && linked.missionId !== OPERATOR_HAND_WORKTREE_KEY
      ? getProjectDomainStores(scope).missions.get(linked.missionId)
      : undefined;
    if (owner === undefined || (owner && owner.status !== 'done' && owner.status !== 'failed')) {
      throw new Error(`resume: o writer isolado ${fromPaneId} pertence a outro escopo (missão) — retome-o de lá`);
    }
    registryKey = linked.missionId;
  }
  let record: WorktreeRecord;
  // Reserva síncrona (mesmo claim dos writers novos): o spawn tem awaits
  // antes de o pane aparecer nos snapshots, e `reopenPaneWriter` aceita de
  // novo um registro `ready` — sem isto, dois resumes simultâneos recebiam a
  // mesma worktree/branch. `link(paneId)` passa a reserva ao pane nascido;
  // `release()` a solta.
  let claim: ReturnType<typeof claimSameCheckoutWriter> | undefined;
  try {
    const snapshots = listPaneSnapshots();
    if (snapshots.some((pane) => pane.executionScope?.rootRealPath === linked.worktreePath &&
      !['exited', 'parked', 'hibernated'].includes(pane.state))) {
      throw new Error('ainda há um pane ativo nela');
    }
    if (hasPendingWriterClaim(linked.worktreePath, snapshots)) {
      throw new Error('outra retomada dela já está em andamento');
    }
    claim = claimSameCheckoutWriter(linked.worktreePath);
    record = registry.reopenPaneWriter(scope, registryKey, linked.taskId);
  } catch (error) {
    claim?.settle();
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `resume: a worktree original do writer isolado ${fromPaneId} ` +
        `(branch ${linked.branchRef.slice('refs/heads/'.length)}) não está disponível ` +
        `(${reason}). Integre/recupere a branch ou abra um writer novo sem resume.`,
      { cause: error },
    );
  }
  return trackAllocation(scope, missionId, registryKey, record, claim);
}

/**
 * `resume` por id de task (h-N): a sessão que entregou o handoff → o pane
 * mais recente do writer isolado que ela rodou (vínculo durável do registry).
 */
export function isolatedWriterPaneOfSession(
  scope: ProjectExecutionScope,
  sessionId: string,
): string | undefined {
  return requireWorktreeRuntimeRegistry().findPaneWriter(scope, { sessionId })?.paneIds?.at(-1);
}
