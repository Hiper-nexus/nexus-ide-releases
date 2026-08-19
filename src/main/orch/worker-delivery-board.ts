/**
 * Caminho files-modified → board selado.
 *
 * Recibo SUCCESS (MCP `nexus_handoff_submit` ou PTY `persistPtyHandoff`)
 * já avança a task. Este módulo NÃO reimplementa esse gancho. Completions
 * que só aparecem como pane death / idle / git dirty / mtime — e sem
 * recibo SUCCESS — avançam a próxima task selada aberta.
 *
 * Fail-closed: 0 arquivos sem handoff SUCCESS não move o board. Recibo
 * SUCCESS na missão ainda deixa fechar tasks abertas com match único no
 * disco (064 pending-with-file). Arquivos leftover sem casa única não
 * avançam o fallback — 060/061 ficam leftover. Não inventa stories.
 */
import type { ProjectExecutionScope } from '../../shared/types';
import { getContextBySession } from './gate';
import {
  getAgentSessionInfo,
  getSessionCwd,
  tapSessionExit,
  tapSessionState,
  type OwnedAgentSessionInfo,
} from '../pty/pty-manager';
import {
  advanceFastLaneStoryTaskFromWorkerDone,
  advanceSealedTasksFromFilesOnDisk,
  boardProgressFromSealedTasks,
} from './mission-story-plan';
import { tapAgentSemanticStatus } from './agent-status';
import {
  collectFilesModifiedSince,
  snapshotWorkerDeliveryBaseline,
  type WorkerDeliveryBaseline,
} from './worker-delivery-evidence';
import {
  getProjectDomainStores,
  type ProjectDomainStoreSuite,
} from './project-domain-store-registry';
import {
  clearSealedBoardSessionCredits,
  markMissionFilesCredited,
  markSessionSealedBoardCredited,
  sessionAlreadyCreditedSealedBoard,
  uncreditedMissionFiles,
} from './sealed-board-session-credit';

export {
  markMissionFilesCredited,
  markSessionSealedBoardCredited,
  sessionAlreadyCreditedSealedBoard,
  uncreditedMissionFiles,
};

export type WorkerDeliverySource =
  | 'pty-exit'
  | 'turn-end'
  | 'mcp-handoff'
  | 'idle'
  | 'disk-reconcile';

export interface WorkerDeliveryBoardDeps {
  readonly getAgent: (sessionId: string) => OwnedAgentSessionInfo | null;
  readonly getCwd: (sessionId: string) => string | null;
  readonly getStores: (scope: ProjectExecutionScope) => ProjectDomainStoreSuite;
  readonly snapshotBaseline: (cwd: string) => WorkerDeliveryBaseline;
  readonly collectFilesModified: (
    cwd: string,
    baseline: WorkerDeliveryBaseline,
  ) => string[];
}

export interface WorkerDeliveryResult {
  readonly advancedTaskId: string | null;
  readonly filesModified: readonly string[];
  readonly reason: string;
}

const baselines = new Map<string, WorkerDeliveryBaseline>();
const missionBaselines = new Map<string, WorkerDeliveryBaseline>();

let untapState: (() => void) | null = null;
let untapExit: (() => void) | null = null;
let untapStatus: (() => void) | null = null;

function productionDeps(): WorkerDeliveryBoardDeps {
  return {
    getAgent: (sessionId) => getAgentSessionInfo(sessionId),
    getCwd: (sessionId) => getSessionCwd(sessionId),
    getStores: (scope) => getProjectDomainStores(scope),
    snapshotBaseline: (cwd) => snapshotWorkerDeliveryBaseline(cwd),
    collectFilesModified: (cwd, baseline) =>
      collectFilesModifiedSince(cwd, baseline),
  };
}

function resolveCwd(
  deps: WorkerDeliveryBoardDeps,
  sessionId: string,
  agent: OwnedAgentSessionInfo | null,
): string | null {
  const fromAgent = agent?.cwd?.trim();
  if (fromAgent) return fromAgent;
  const fromSession = deps.getCwd(sessionId)?.trim();
  if (fromSession) return fromSession;
  const fromExecution = agent?.scope?.rootRealPath?.trim();
  return fromExecution || null;
}

export function noteWorkerDeliveryBaseline(
  sessionId: string,
  cwd: string,
  deps: WorkerDeliveryBoardDeps = productionDeps(),
): WorkerDeliveryBaseline | null {
  const id = sessionId.trim();
  const root = cwd.trim();
  if (!id || !root) return null;
  const existing = baselines.get(id);
  if (existing && existing.cwd === root) return existing;
  try {
    const snapshot = deps.snapshotBaseline(root);
    baselines.set(id, snapshot);
    return snapshot;
  } catch (error) {
    console.warn(
      '[worker-delivery] snapshot do cwd falhou (fail-closed):',
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

const SUCCESS_RECEIPT_STATUSES = new Set(['success', 'partial']);

function listMissionHandoffs(
  stores: ProjectDomainStoreSuite,
  missionId: string,
): ReadonlyArray<{
  readonly status: string;
  readonly sessionId?: string;
  readonly workerIncarnationId?: string;
}> {
  try {
    return stores.handoffs?.list?.({ missionId, includeDelivered: true }) ?? [];
  } catch (error) {
    console.warn(
      '[worker-delivery] leitura de handoffs falhou (fail-closed):',
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}

function isSuccessReceiptStatus(status: string): boolean {
  return SUCCESS_RECEIPT_STATUSES.has(status);
}

/** Recibo MCP/PTY SUCCESS|partial desta sessão ou encarnação. */
export function sessionHasSealedBoardSuccessReceipt(
  stores: ProjectDomainStoreSuite,
  input: {
    readonly missionId: string;
    readonly sessionId: string;
    readonly workerIncarnationId?: string | null;
  },
): boolean {
  const sessionId = input.sessionId.trim();
  const incarnation = input.workerIncarnationId?.trim();
  if (!sessionId) return false;
  return listMissionHandoffs(stores, input.missionId).some((row) => {
    if (!isSuccessReceiptStatus(row.status)) return false;
    if (row.sessionId === sessionId) return true;
    return Boolean(incarnation && row.workerIncarnationId === incarnation);
  });
}

/** Qualquer SUCCESS|partial na missão — o watcher não reconcilia o disco. */
export function missionHasSealedBoardSuccessReceipt(
  stores: ProjectDomainStoreSuite,
  missionId: string,
): boolean {
  return listMissionHandoffs(stores, missionId).some((row) =>
    isSuccessReceiptStatus(row.status),
  );
}

function boundTaskId(
  stores: ProjectDomainStoreSuite,
  missionId: string,
  sessionId: string,
  workerIncarnationId?: string,
): string | null {
  try {
    const dispatches = stores.taskDispatches?.list?.(missionId) ?? [];
    const match = workerIncarnationId
      ? dispatches.find(
          (dispatch) =>
            dispatch.sessionId === sessionId &&
            dispatch.workerIncarnationId === workerIncarnationId,
        )
      : dispatches.find((dispatch) => dispatch.sessionId === sessionId);
    return match?.taskId ?? null;
  } catch {
    return null;
  }
}

/**
 * Worker pane/turno terminou. Se o cwd ganhou arquivos desde o spawn,
 * avança uma task selada aberta. Sem arquivos, o board não mexe.
 */
export function handleWorkerPaneDone(
  input: {
    readonly sessionId: string;
    readonly agent?: OwnedAgentSessionInfo | null;
    readonly source: WorkerDeliverySource;
    readonly summary?: string | null;
  },
  deps: WorkerDeliveryBoardDeps = productionDeps(),
): WorkerDeliveryResult {
  const sessionId = input.sessionId.trim();
  if (!sessionId) {
    return { advancedTaskId: null, filesModified: [], reason: 'sem sessionId' };
  }
  if (sessionAlreadyCreditedSealedBoard(sessionId)) {
    return {
      advancedTaskId: null,
      filesModified: [],
      reason: 'sessão já creditou uma task selada',
    };
  }

  const ctx = getContextBySession(sessionId);
  const agent = input.agent ?? deps.getAgent(sessionId);
  const role = agent?.role ?? ctx?.role;
  const missionId = agent?.missionId ?? ctx?.missionId;
  const scope = agent?.scope ?? ctx?.scope;
  if (role !== 'worker' || !missionId || !scope) {
    return {
      advancedTaskId: null,
      filesModified: [],
      reason: 'não é worker de missão',
    };
  }
  if (agent?.readOnly === true || ctx?.readOnly === true) {
    return {
      advancedTaskId: null,
      filesModified: [],
      reason: 'worker read-only não entrega arquivos',
    };
  }

  let stores: ProjectDomainStoreSuite;
  try {
    stores = deps.getStores(scope);
  } catch (error) {
    console.warn(
      '[worker-delivery] stores indisponíveis:',
      error instanceof Error ? error.message : error,
    );
    return {
      advancedTaskId: null,
      filesModified: [],
      reason: 'stores indisponíveis',
    };
  }
  if (
    sessionHasSealedBoardSuccessReceipt(stores, {
      missionId,
      sessionId,
      workerIncarnationId:
        agent?.workerIncarnationId ?? ctx?.workerIncarnationId,
    })
  ) {
    return {
      advancedTaskId: null,
      filesModified: [],
      reason: 'sessão já tem recibo SUCCESS',
    };
  }

  const cwd = resolveCwd(deps, sessionId, agent);
  if (!cwd) {
    return { advancedTaskId: null, filesModified: [], reason: 'cwd do worker ausente' };
  }

  let baseline = baselines.get(sessionId);
  if (!baseline) {
    // Sem snapshot de spawn: contar o dirty atual, não um snapshot tardio
    // que tornaria o delta vazio depois que os arquivos já estão no disco.
    // Não varrer mtime do passado — observedAt ≈ agora só pega o que nascer
    // depois; o git dirty com dirtyPaths=[] cobre o que já está no disco.
    try {
      const late = deps.snapshotBaseline(cwd);
      baseline = Object.freeze({
        cwd: late.cwd,
        headSha: late.headSha,
        dirtyPaths: Object.freeze([] as string[]),
        observedAt: late.observedAt,
      });
      baselines.set(sessionId, baseline);
    } catch (error) {
      console.warn(
        '[worker-delivery] baseline tardio falhou (fail-closed):',
        error instanceof Error ? error.message : error,
      );
      return {
        advancedTaskId: null,
        filesModified: [],
        reason: 'baseline indisponível (fail-closed)',
      };
    }
  }

  let filesModified: string[] = [];
  try {
    filesModified = deps.collectFilesModified(cwd, baseline);
  } catch (error) {
    console.warn(
      '[worker-delivery] colheita de files-modified falhou:',
      error instanceof Error ? error.message : error,
    );
    return {
      advancedTaskId: null,
      filesModified: [],
      reason: 'colheita de files-modified falhou',
    };
  }
  if (filesModified.length === 0) {
    return {
      advancedTaskId: null,
      filesModified: [],
      reason: '0 files-modified — board inalterado',
    };
  }

  try {
    const fromAgent = agent?.agentName ?? ctx?.agentName ?? ctx?.label ?? null;
    const advanced = advanceFastLaneStoryTaskFromWorkerDone(stores, {
      missionId,
      fromAgent,
      adapterId: agent?.adapterId ?? ctx?.providerId ?? null,
      summary: input.summary ?? fromAgent,
      preferredTaskId: boundTaskId(
        stores,
        missionId,
        sessionId,
        agent?.workerIncarnationId ?? ctx?.workerIncarnationId,
      ),
      filesModified,
    });
    if (advanced) {
      markSessionSealedBoardCredited(sessionId);
      markMissionFilesCredited(missionId, filesModified);
      return {
        advancedTaskId: advanced,
        filesModified,
        reason: `board avançou via ${input.source}`,
      };
    }
    return {
      advancedTaskId: null,
      filesModified,
      reason: 'files-modified sem task selada aberta',
    };
  } catch (error) {
    console.warn(
      '[worker-delivery] avanço do board falhou:',
      error instanceof Error ? error.message : error,
    );
    return {
      advancedTaskId: null,
      filesModified,
      reason: 'avanço do board falhou',
    };
  }
}

export interface DiskReconcileResult {
  readonly advancedTaskIds: readonly string[];
  readonly filesModified: readonly string[];
  readonly reason: string;
}

/**
 * First-wave / Via Rápida: writers entregam no disco e ficam no pane.
 * PTY exit e Stop hook não disparam. O watcher (e o idle semântico)
 * colhe files-modified no cwd da missão e avança o board selado.
 *
 * Se o board ainda está 0/N e o disco já tem arquivos, o dirty atual
 * conta — um snapshot tardio não pode zerar a evidência ao vivo.
 */
export function reconcileSealedBoardFromDisk(
  input: {
    readonly stores: ProjectDomainStoreSuite;
    readonly missionId: string;
    readonly cwd: string;
  },
  deps: Pick<
    WorkerDeliveryBoardDeps,
    'snapshotBaseline' | 'collectFilesModified'
  > = productionDeps(),
): DiskReconcileResult {
  const missionId = input.missionId.trim();
  const cwd = input.cwd.trim();
  if (!missionId || !cwd) {
    return { advancedTaskIds: [], filesModified: [], reason: 'missão/cwd ausente' };
  }
  const mission = input.stores.missions.get(missionId);
  if (!mission || mission.status !== 'running') {
    return { advancedTaskIds: [], filesModified: [], reason: 'missão não running' };
  }
  let tasks: { readonly status: string }[] = [];
  try {
    tasks = input.stores.tasks.list(missionId);
  } catch {
    return { advancedTaskIds: [], filesModified: [], reason: 'tasks ilegíveis' };
  }
  if (tasks.length === 0) {
    return { advancedTaskIds: [], filesModified: [], reason: 'sem plano selado' };
  }
  const uniqueMatchesOnly = missionHasSealedBoardSuccessReceipt(
    input.stores,
    missionId,
  );

  let baseline = missionBaselines.get(missionId);
  if (!baseline) {
    try {
      const snap = deps.snapshotBaseline(cwd);
      const progress = boardProgressFromSealedTasks(tasks);
      baseline = Object.freeze({
        cwd: snap.cwd,
        headSha: snap.headSha,
        dirtyPaths:
          progress.completed === 0
            ? Object.freeze([] as string[])
            : snap.dirtyPaths,
        observedAt: snap.observedAt,
      });
      missionBaselines.set(missionId, baseline);
    } catch (error) {
      console.warn(
        '[worker-delivery] baseline da missão falhou:',
        error instanceof Error ? error.message : error,
      );
      return {
        advancedTaskIds: [],
        filesModified: [],
        reason: 'baseline da missão indisponível',
      };
    }
  }

  const hasPending = tasks.some(
    (task) => task.status === 'pending' || task.status === 'running',
  );
  let filesModified: string[] = [];
  try {
    const delta = deps.collectFilesModified(cwd, baseline);
    const pasta = hasPending
      ? deps.collectFilesModified(cwd, {
          ...baseline,
          dirtyPaths: Object.freeze([]),
        })
      : [];
    filesModified = uncreditedMissionFiles(missionId, [
      ...new Set([...delta, ...pasta]),
    ]);
  } catch (error) {
    console.warn(
      '[worker-delivery] colheita da missão falhou:',
      error instanceof Error ? error.message : error,
    );
    return {
      advancedTaskIds: [],
      filesModified: [],
      reason: 'colheita da missão falhou',
    };
  }
  if (filesModified.length === 0) {
    return {
      advancedTaskIds: [],
      filesModified: [],
      reason: '0 files-modified — board inalterado',
    };
  }

  try {
    const advanced = advanceSealedTasksFromFilesOnDisk(input.stores, {
      missionId,
      filesModified,
      uniqueMatchesOnly,
    });
    if (advanced.length > 0) {
      markMissionFilesCredited(missionId, filesModified);
      return {
        advancedTaskIds: advanced,
        filesModified,
        reason: 'board avançou via files-modified no disco',
      };
    }
    return {
      advancedTaskIds: [],
      filesModified,
      reason: uniqueMatchesOnly
        ? 'recibo SUCCESS — leftover dirty sem match único (060/061 ficam leftover)'
        : 'files-modified sem task selada aberta',
    };
  } catch (error) {
    console.warn(
      '[worker-delivery] reconcile do board falhou:',
      error instanceof Error ? error.message : error,
    );
    return {
      advancedTaskIds: [],
      filesModified,
      reason: 'reconcile do board falhou',
    };
  }
}

/** Fire-and-forget a partir do turn-end / PTY exit / idle / watcher. Nunca lança. */
export function recordWorkerDeliveryIfDelivered(input: {
  readonly sessionId: string;
  readonly agent?: OwnedAgentSessionInfo | null;
  readonly source: WorkerDeliverySource;
  readonly summary?: string | null;
}): void {
  try {
    const result = handleWorkerPaneDone(input);
    if (result.advancedTaskId) {
      console.info(
        `[worker-delivery] ${input.sessionId}: ${result.reason} ` +
          `(task ${result.advancedTaskId}, ${result.filesModified.length} arquivos)`,
      );
      return;
    }
    if (result.reason !== 'não é worker de missão') {
      console.info(`[worker-delivery] ${input.sessionId}: ${result.reason}`);
    }
  } catch (error) {
    console.warn(
      '[worker-delivery] record falhou:',
      error instanceof Error ? error.message : error,
    );
  }
}

export function initWorkerDeliveryBoard(
  deps: WorkerDeliveryBoardDeps = productionDeps(),
): void {
  if (untapState || untapExit || untapStatus) return;
  untapState = tapSessionState((sessionId) => {
    const agent = deps.getAgent(sessionId);
    if (agent?.role !== 'worker' || !agent.missionId) return;
    const cwd = resolveCwd(deps, sessionId, agent);
    if (cwd) noteWorkerDeliveryBaseline(sessionId, cwd, deps);
  });
  untapStatus = tapAgentSemanticStatus((entry) => {
    if (entry.status !== 'idle' && entry.status !== 'completed') return;
    try {
      handleWorkerPaneDone(
        { sessionId: entry.sessionId, source: 'idle' },
        deps,
      );
    } catch (error) {
      console.warn(
        '[worker-delivery] idle falhou:',
        error instanceof Error ? error.message : error,
      );
    }
  });
  untapExit = tapSessionExit((sessionId, agent) => {
    try {
      handleWorkerPaneDone(
        { sessionId, agent, source: 'pty-exit' },
        deps,
      );
    } catch (error) {
      console.warn(
        '[worker-delivery] pty-exit falhou:',
        error instanceof Error ? error.message : error,
      );
    }
    baselines.delete(sessionId);
  });
}

export function shutdownWorkerDeliveryBoard(): void {
  untapState?.();
  untapState = null;
  untapStatus?.();
  untapStatus = null;
  untapExit?.();
  untapExit = null;
  baselines.clear();
  missionBaselines.clear();
  clearSealedBoardSessionCredits();
}

/** Test-only. */
export function __resetWorkerDeliveryBoardForTests(): void {
  shutdownWorkerDeliveryBoard();
}
