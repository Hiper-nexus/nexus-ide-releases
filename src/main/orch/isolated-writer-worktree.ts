import { randomUUID } from 'node:crypto';
import type { ProjectExecutionScope } from '../../shared/types';
import type { CreateWorktreeInput, WorktreeRecord } from '../runtime/worktree-contract';
import type { MaterializeWorktreeResult } from '../runtime/worktree-cow';
import { requireWorktreeRuntimeRegistry } from '../runtime/worktree-runtime-registry';
import {
  getRequestedTerminationOrigin,
  tapSessionExit,
  tapSessionTermination,
  type OwnedAgentSessionInfo,
} from '../pty/pty-manager';
import {
  FAILOVER_RESPAWN_TERMINATION_ORIGIN,
  onFailoverRetirementVerdict,
} from './failover-retirement';
import { getPaneRuntimeAuthorityBySession, isPaneSpawnPending, listPaneSnapshots } from './pane-registry';
import { claimSameCheckoutWriter, hasPendingWriterClaim } from './delegated-writer-gate';
import { getProjectDomainStores } from './project-domain-store-registry';
import { scheduleWorktreeSalvage } from './isolated-writer-salvage';
import { KeyedCoalescingWorker } from '../util/keyed-coalescing-worker';
import { AsyncProcessGitRunner, type AsyncGitRunner } from '../runtime/git-command';

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
  /**
   * F-980: pasta isolada da aba de onde a worktree nasceu (o HEAD dela é o
   * `baseSha`). Ausente quando a base é o checkout de coordenação.
   */
  readonly baseRootRealPath?: string;
  readonly release: () => void;
  /**
   * Liga o pane nascido (e a sessão, se já existe) a esta worktree no
   * registry durável — autoridade do Main; `resume` volta a ela mesmo depois
   * de reiniciar o app.
   */
  readonly link: (paneId: string, sessionId?: string) => void;
  /**
   * F-215: resultado efêmero do materialize desta alocação (tempos por
   * etapa) — só existe quando a worktree foi criada agora.
   */
  readonly materialize?: MaterializeWorktreeResult;
}

function inUseByPane(worktreePath: string): boolean {
  return listPaneSnapshots().some(
    (pane) => pane.executionScope?.rootRealPath === worktreePath && pane.state !== 'exited',
  );
}

/**
 * GC seguro dos writers de pane já integrados (ver registry), da mão do
 * operador ou de uma missão (F-908: chave do próprio registro). Agendado fora
 * do caminho do spawn/fechamento (Git assíncrono, depois do turno atual) e
 * nunca dois na mesma chave do mesmo repo: pedidos durante uma coleta viram
 * uma única rodada extra ao fim dela, com o escopo mais novo.
 */
const paneWriterGc = new KeyedCoalescingWorker<string, { scope: ProjectExecutionScope; registryKey: string }>(
  async (_key, { scope, registryKey }) => {
    await new Promise((resolve) => setImmediate(resolve));
    await requireWorktreeRuntimeRegistry().collectIntegratedPaneWorktrees(scope, registryKey, inUseByPane);
  },
  (error) => console.warn('[isolated-writer] GC de worktrees integradas adiado', error),
);

function schedulePaneWriterGc(scope: ProjectExecutionScope, registryKey: string): void {
  paneWriterGc.enqueue(`${scope.rootRealPath}\0${registryKey}`, { scope, registryKey });
}

/** Testes: espera as coletas agendadas terminarem. */
export function operatorHandGcIdle(): Promise<void> {
  return paneWriterGc.drain();
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
    untapSwitchTermination();
    untapSwitchVerdict();
    schedulePaneWriterGc(scope, registryKey);
  };
  const writesHere = (sessionId: string, agent: OwnedAgentSessionInfo | null): boolean => {
    const authority = agent ? null : getPaneRuntimeAuthorityBySession(sessionId);
    const executionRoot = agent?.scope.rootRealPath ?? authority?.executionScope?.rootRealPath;
    return (agent?.missionId ?? authority?.missionId) === missionId &&
      executionRoot === record.worktreePath;
  };
  const releaseAfterExit = (sessionId: string): void => {
    // ACK pendente não tinha sessão no spawn: grava-a aqui, para `resume` por
    // id de task (h-N → sessão do handoff) achar esta worktree.
    if (!released) bind({ sessionId });
    release();
    // F-794: o processo do writer já saiu (prova física) — sem corrida com
    // ele. Alteração não commitada vira commit de salvaguarda em
    // refs/nexus-salvage/, sem tocar branch, índice ou arquivos.
    void scheduleWorktreeSalvage({
      worktreePath: record.worktreePath,
      branchRef: record.branchRef,
      missionId: registryKey,
      taskId: record.taskId,
      reason: 'pane-exit',
      sessionId,
    }, { scope, notify: missionId !== undefined });
  };
  // F-1480: sessão que o failover de conta aposentou. Com o pane novo vivo na
  // MESMA worktree, a saída dela não solta o writer: o registro segue pronto e
  // a saída do pane novo é que libera e ganha a salvaguarda. Veredito pendente
  // (no teto de panes a velha sai antes de o pane novo nascer) espera o respawn.
  const switching = new Map<string, { replaced: boolean | null; exited: boolean }>();
  const untapSwitchTermination = tapSessionTermination((sessionId, agent) => {
    if (released || switching.has(sessionId) ||
      getRequestedTerminationOrigin(sessionId) !== FAILOVER_RESPAWN_TERMINATION_ORIGIN ||
      !writesHere(sessionId, agent)) return;
    switching.set(sessionId, { replaced: null, exited: false });
  });
  const untapSwitchVerdict = onFailoverRetirementVerdict((sessionId, replaced) => {
    const pending = switching.get(sessionId);
    if (!pending) return;
    if (!pending.exited) {
      pending.replaced = replaced;
      return;
    }
    switching.delete(sessionId);
    if (!replaced) releaseAfterExit(sessionId);
  });
  // PTY taps run only after physical process-tree exit is proven. This covers
  // user close, natural exit and the existing mission termination/teardown.
  // Register before spawning, including the renderer's pending-ACK lane.
  const untap = tapSessionExit((sessionId, agent) => {
    if (!writesHere(sessionId, agent)) return;
    const pending = switching.get(sessionId);
    if (pending) {
      if (pending.replaced === null) {
        pending.exited = true;
        return;
      }
      switching.delete(sessionId);
      if (pending.replaced) return;
    }
    releaseAfterExit(sessionId);
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

const salvageSweptScopes = new Set<string>();

/**
 * F-794: o app fechado no meio da missão (o caso de 03/10) não deixa a
 * salvaguarda da saída do pane terminar — o Git assíncrono morre com o
 * processo. A worktree continua retida (o GC nunca remove worktree suja); na
 * primeira alocação de writer do escopo depois de reabrir, as worktrees de
 * writers já liberados que ainda têm alteração sem commit ganham o snapshot.
 * Uma vez por escopo por processo, sequencial, depois do turno atual, e só
 * quando o registry do escopo já foi construído pela própria alocação.
 */
function sweepReleasedPaneWriterWorktrees(scope: ProjectExecutionScope): void {
  const key = `${scope.installationId}\0${scope.projectId}\0${scope.checkoutId}`;
  if (salvageSweptScopes.has(key)) return;
  salvageSweptScopes.add(key);
  setImmediate(() => {
    void (async () => {
      let records: readonly WorktreeRecord[];
      try {
        const runtime = requireWorktreeRuntimeRegistry().forScope(scope);
        records = runtime.worktreeState.read(runtime.worktrees.scopeKey(scope)).records;
      } catch (error) {
        console.warn('[worktree-salvage] varredura de reabertura adiada:', error);
        return;
      }
      for (const record of records) {
        if (record.ownerKind !== 'pane' || record.status !== 'failed' || inUseByPane(record.worktreePath)) continue;
        await scheduleWorktreeSalvage({
          worktreePath: record.worktreePath,
          branchRef: record.branchRef,
          missionId: record.missionId,
          taskId: record.taskId,
          reason: 'reopen-sweep',
        }, { scope, notify: false });
      }
    })();
  });
}

/** Testes: permite varrer de novo o mesmo escopo. */
export function resetWorktreeSalvageSweepForTests(): void {
  salvageSweptScopes.clear();
}

/** Allocate through the same durable CAS + Git + optional CoW as sealed tasks. */
export async function allocateIsolatedWriterWorktree(
  scope: ProjectExecutionScope,
  missionId: string | undefined,
  authority: Pick<CreateWorktreeInput, 'assertCurrentAuthority' | 'signal' | 'baseRootRealPath' | 'baseRef'> = {},
): Promise<IsolatedWriterAllocation> {
  authority.assertCurrentAuthority?.();
  authority.signal?.throwIfAborted();
  const workerId = randomUUID();
  const registryKey = missionId ?? OPERATOR_HAND_WORKTREE_KEY;
  schedulePaneWriterGc(scope, registryKey);
  let materialize: MaterializeWorktreeResult | undefined;
  const record = await requireWorktreeRuntimeRegistry().create({
    ...authority,
    scope,
    missionId: registryKey,
    taskId: `pane-${workerId}`,
    workerId,
    ownerKind: 'pane',
    // No sealed file claims: the Maestro owns integration of these branches.
    ownership: { files: [], symbols: [], domains: [`pane-${workerId}`] },
    onMaterialized: (result) => {
      materialize = result;
    },
  });
  const tracked = trackAllocation(scope, missionId, registryKey, record);
  const allocation = authority.baseRootRealPath && authority.baseRootRealPath !== scope.rootRealPath
    ? { ...tracked, baseRootRealPath: authority.baseRootRealPath }
    : tracked;
  sweepReleasedPaneWriterWorktrees(scope);
  return materialize ? { ...allocation, materialize } : allocation;
}

let sharedGit: AsyncGitRunner | undefined;

/**
 * F-1429: adota uma worktree Git aninhada já existente no workspace (ex.:
 * `.harvest/s243-...`) como worktree do writer. Prova a branch e commit HEAD
 * atuais, registra o writer durável no registry e devolve a alocação para o
 * spawn e handoff/rework operarem exatamente como em isolatedWriter.
 */
export async function adoptNestedWorktreeWriter(
  scope: ProjectExecutionScope,
  missionId: string | undefined,
  nested: {
    readonly cwd: string;
    readonly scope: ProjectExecutionScope;
  },
  claim?: ReturnType<typeof claimSameCheckoutWriter>,
  git: AsyncGitRunner = (sharedGit ??= new AsyncProcessGitRunner()),
): Promise<IsolatedWriterAllocation> {
  const workerId = randomUUID();
  const registryKey = missionId ?? OPERATOR_HAND_WORKTREE_KEY;
  schedulePaneWriterGc(scope, registryKey);

  const branchResult = await git.run(nested.cwd, ['symbolic-ref', '--quiet', 'HEAD'], { allowFailure: true });
  let branchRef = branchResult.status === 0 ? branchResult.stdout.trim() : '';
  if (!branchRef) {
    const rev = await git.run(nested.cwd, ['rev-parse', 'HEAD']);
    branchRef = `refs/heads/nested-${rev.stdout.trim().slice(0, 12)}`;
  }
  const baseResult = await git.run(nested.cwd, ['rev-parse', 'HEAD']);
  const baseSha = baseResult.stdout.trim();

  const record = requireWorktreeRuntimeRegistry().registerExistingPaneWriter(
    scope,
    registryKey,
    {
      workerId,
      worktreePath: nested.cwd,
      branchRef,
      baseSha,
    },
  );
  return trackAllocation(scope, missionId, registryKey, record, claim);
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
    if (hasPendingWriterClaim(linked.worktreePath, snapshots, isPaneSpawnPending)) {
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

/**
 * Base durável do writer isolado que roda nesta sessão: o commit de onde a
 * worktree nasceu (registro do Main), não o HEAD no spawn — `resume` depois de
 * reiniciar reabre a mesma branch, e os commits anteriores continuam no diff.
 * Sessão ainda sem vínculo (ACK pendente) cai no vínculo do pane.
 */
export function isolatedWriterBaseShaOfSession(
  scope: ProjectExecutionScope,
  executionRoot: string,
  sessionId: string,
): string | undefined {
  try {
    const registry = requireWorktreeRuntimeRegistry();
    let record = registry.findPaneWriter(scope, { sessionId });
    if (!record) {
      const paneId = getPaneRuntimeAuthorityBySession(sessionId)?.paneId;
      record = paneId ? registry.findPaneWriter(scope, { paneId }) : null;
    }
    return record && record.worktreePath === executionRoot ? record.baseSha : undefined;
  } catch {
    return undefined;
  }
}
