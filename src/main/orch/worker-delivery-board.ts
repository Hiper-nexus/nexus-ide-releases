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
import { trace } from '../observability/main-trace';
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
  readonly snapshotBaseline: (cwd: string) => WorkerDeliveryBaseline | Promise<WorkerDeliveryBaseline>;
  readonly collectFilesModified: (
    cwd: string,
    baseline: WorkerDeliveryBaseline,
  ) => string[] | Promise<string[]>;
}

export interface WorkerDeliveryResult {
  readonly advancedTaskId: string | null;
  readonly filesModified: readonly string[];
  readonly reason: string;
}

const baselines = new Map<string, WorkerDeliveryBaseline>();
const missionBaselines = new Map<string, WorkerDeliveryBaseline>();
const baselineFlights = new Map<string, Promise<WorkerDeliveryBaseline | null>>();
const deliveryFlights = new Set<Promise<unknown>>();
let boardGeneration = 0;

function authorityState(stores: ProjectDomainStoreSuite, missionId: string): string {
  const mission = stores.missions.get(missionId);
  return JSON.stringify({
    mission: mission && [mission.status, mission.intentVersion, mission.intentState,
      mission.updatedAt, mission.orchestratorSessionId, mission.intentContract],
    tasks: stores.tasks.list(missionId).map((task) => [task.id, task.status, task.updatedAt]),
  });
}

function ownDelivery<T>(flight: Promise<T>): Promise<T> {
  deliveryFlights.add(flight);
  void flight.then(() => deliveryFlights.delete(flight), () => deliveryFlights.delete(flight));
  return flight;
}

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
): Promise<WorkerDeliveryBaseline | null> {
  const id = sessionId.trim();
  const root = cwd.trim();
  if (!id || !root) return Promise.resolve(null);
  const existing = baselines.get(id);
  if (existing && existing.cwd === root) return Promise.resolve(existing);
  const pending = baselineFlights.get(id);
  if (pending) return pending;
  const generation = boardGeneration;
  const flight = ownDelivery((async () => {
    try {
      const snapshot = await deps.snapshotBaseline(root);
      if (generation !== boardGeneration) return null;
      const agent = deps.getAgent(id);
      if (agent && resolveCwd(deps, id, agent) !== root) return null;
      baselines.set(id, snapshot);
      return snapshot;
    } catch (error) {
      console.warn('[worker-delivery] snapshot do cwd falhou (fail-closed):', error);
      return null;
    }
  })());
  baselineFlights.set(id, flight);
  void flight.finally(() => { if (baselineFlights.get(id) === flight) baselineFlights.delete(id); });
  return flight;
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
export async function handleWorkerPaneDone(
  input: {
    readonly sessionId: string;
    readonly agent?: OwnedAgentSessionInfo | null;
    readonly source: WorkerDeliverySource;
    readonly summary?: string | null;
  },
  deps: WorkerDeliveryBoardDeps = productionDeps(),
): Promise<WorkerDeliveryResult> {
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
  // F-1006: missão, tasks e handoffs moram no banco do checkout de
  // COORDENAÇÃO. `agent.scope` é a worktree de execução (writer isolado, aba
  // com worktree): abrir os stores por ela batia na guarda de identidade e o
  // quadro nunca via a entrega. O cwd segue vindo da execução (resolveCwd).
  const scope = agent?.coordinationScope ?? ctx?.scope ?? agent?.scope;
  if (role !== 'worker' || !missionId || !scope) {
    return {
      advancedTaskId: null,
      filesModified: [],
      reason: 'não é worker de missão',
    };
  }
  // F-1157: só a lane que o Hardened confina à leitura não entrega arquivos;
  // nas demais, `readOnly` é rótulo e o que ela escreveu entra no quadro.
  if (ctx?.readOnlyEnforced === true) {
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

  const generation = boardGeneration;
  const authority = authorityState(stores, missionId);
  const incarnation = agent?.workerIncarnationId ?? ctx?.workerIncarnationId;
  const taskId = boundTaskId(stores, missionId, sessionId, incarnation);
  const current = () => {
    if (generation !== boardGeneration || authorityState(stores, missionId) !== authority) return false;
    if (ctx && getContextBySession(sessionId) !== ctx) return false;
    const live = deps.getAgent(sessionId);
    if (live && (live.missionId !== missionId || live.workerIncarnationId !== incarnation ||
      resolveCwd(deps, sessionId, live) !== cwd)) return false;
    return boundTaskId(stores, missionId, sessionId, incarnation) === taskId &&
      !sessionAlreadyCreditedSealedBoard(sessionId) &&
      !sessionHasSealedBoardSuccessReceipt(stores, { missionId, sessionId, workerIncarnationId: incarnation });
  };
  await baselineFlights.get(sessionId);
  if (!current()) return { advancedTaskId: null, filesModified: [], reason: 'autoridade alterada durante coleta' };
  let baseline = baselines.get(sessionId);
  if (!baseline) {
    // Sem snapshot de spawn: usar o dirty-state ACTUAL como baseline para
    // não contar arquivos pré-existentes do workspace como produzidos pelo
    // worker — caso contrário, arquivos sujos irrelevantes avançam o board.
    try {
      const late = await deps.snapshotBaseline(cwd);
      if (!current()) return { advancedTaskId: null, filesModified: [], reason: 'autoridade alterada durante baseline' };
      baseline = Object.freeze({
        cwd: late.cwd,
        headSha: late.headSha,
        dirtyPaths: late.dirtyPaths,
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
    filesModified = await deps.collectFilesModified(cwd, baseline);
    if (!current() || baselines.get(sessionId) !== baseline) return { advancedTaskId: null, filesModified: [], reason: 'autoridade alterada durante coleta' };
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
export async function reconcileSealedBoardFromDisk(
  input: {
    readonly stores: ProjectDomainStoreSuite;
    readonly missionId: string;
    readonly cwd: string;
  },
  deps: Pick<
    WorkerDeliveryBoardDeps,
    'snapshotBaseline' | 'collectFilesModified'
  > = productionDeps(),
): Promise<DiskReconcileResult> {
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

  const generation = boardGeneration;
  const authority = authorityState(input.stores, missionId);
  const current = () => generation === boardGeneration && authorityState(input.stores, missionId) === authority;
  let baseline = missionBaselines.get(missionId);
  if (!baseline) {
    try {
      const snap = await deps.snapshotBaseline(cwd);
      if (!current()) return { advancedTaskIds: [], filesModified: [], reason: 'autoridade alterada durante baseline' };
      baseline = Object.freeze({
        cwd: snap.cwd,
        headSha: snap.headSha,
        dirtyPaths: snap.dirtyPaths,
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

  let filesModified: string[] = [];
  try {
    const delta = await deps.collectFilesModified(cwd, baseline);
    const progress = boardProgressFromSealedTasks(tasks);
    const hasPending = tasks.some(
      (task) => task.status === 'pending' || task.status === 'running',
    );
    // Re-include baseline dirty files only when workers already advanced the
    // board (completed > 0). At progress 0, pre-existing workspace dirt must
    // NOT count — otherwise unrelated dirty files trigger a false "Pronto".
    const pasta =
      hasPending && progress.completed > 0
        ? await deps.collectFilesModified(cwd, {
            ...baseline,
            dirtyPaths: Object.freeze([]),
          })
        : [];
    if (!current() || missionBaselines.get(missionId) !== baseline) return { advancedTaskIds: [], filesModified: [], reason: 'autoridade alterada durante coleta' };
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
export async function recordWorkerDeliveryIfDelivered(input: {
  readonly sessionId: string;
  readonly agent?: OwnedAgentSessionInfo | null;
  readonly source: WorkerDeliverySource;
  readonly summary?: string | null;
}): Promise<void> {
  try {
    const result = await ownDelivery(handleWorkerPaneDone(input));
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

/**
 * F-1006: o desfecho do quadro por worker de missão vai para o trace do Main.
 * Antes, "stores indisponíveis" (colisão de escopo) só aparecia como aviso
 * solto e o E2E de missão não tinha como afirmar que o quadro viu a entrega.
 */
function traceBoardOutcome(
  sessionId: string,
  source: WorkerDeliverySource,
  result: WorkerDeliveryResult,
): void {
  if (result.reason === 'não é worker de missão' || result.reason === 'sem sessionId') return;
  trace({
    kind: 'worker-delivery-board',
    sessionId,
    origin: source,
    reason: result.reason,
    count: result.filesModified.length,
    ...(result.advancedTaskId ? { taskId: result.advancedTaskId } : {}),
  });
}

export function initWorkerDeliveryBoard(
  deps: WorkerDeliveryBoardDeps = productionDeps(),
): void {
  if (untapState || untapExit || untapStatus) return;
  untapState = tapSessionState((sessionId) => {
    const agent = deps.getAgent(sessionId);
    if (agent?.role !== 'worker' || !agent.missionId) return;
    const cwd = resolveCwd(deps, sessionId, agent);
    if (cwd) void noteWorkerDeliveryBaseline(sessionId, cwd, deps);
  });
  untapStatus = tapAgentSemanticStatus((entry) => {
    if (entry.status !== 'idle' && entry.status !== 'completed') return;
    void ownDelivery(handleWorkerPaneDone({ sessionId: entry.sessionId, source: 'idle' }, deps))
      .then((result) => traceBoardOutcome(entry.sessionId, 'idle', result))
      .catch((error) => console.warn('[worker-delivery] idle falhou:', error));
  });
  untapExit = tapSessionExit((sessionId, agent) => {
    void ownDelivery(handleWorkerPaneDone({ sessionId, agent, source: 'pty-exit' }, deps))
      .then((result) => traceBoardOutcome(sessionId, 'pty-exit', result))
      .catch((error) => console.warn('[worker-delivery] pty-exit falhou:', error))
      .finally(() => baselines.delete(sessionId));
  });
}

export async function shutdownWorkerDeliveryBoard(): Promise<void> {
  boardGeneration++;
  untapState?.();
  untapState = null;
  untapStatus?.();
  untapStatus = null;
  untapExit?.();
  untapExit = null;
  await Promise.allSettled([...deliveryFlights]);
  baselineFlights.clear();
  baselines.clear();
  missionBaselines.clear();
  clearSealedBoardSessionCredits();
}

/** Test-only. */
export async function __resetWorkerDeliveryBoardForTests(): Promise<void> {
  await shutdownWorkerDeliveryBoard();
}
