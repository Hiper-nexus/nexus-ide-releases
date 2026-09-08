/**
 * Pronto civil da Via Rápida: header Pronto só com board selado N/N.
 * Story selada pendente + arquivo único na pasta fecha via pending-with-file
 * antes da decisão. Files-modified/handoff não pinta Pronto em 16/20.
 *
 * Não pinta o board. Não pula Maestro/revisor em guided/legacy.
 * DESIGN.md sozinho e rascunho nunca iniciado não fecham.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { missionResultSchema } from '../../shared/mission-engine-contract';
import { holdsAwaitingOperatorAdjustment } from '../../shared/mission-recovery-policy';
import type { Handoff, Mission, Squad } from '../../shared/orch-types';
import type { ProjectExecutionScope } from '../../shared/types';
import type { MissionEngine } from './mission-engine';
import {
  hasUnsettledQueuedHandoffs,
  isCivilianReviewRefusal,
  isJunkArtifactRef,
  isSatOrTombstonedPaneState,
  matchHandoffToAgent,
  noteCivilianReviewRefusal,
  shouldLogCivilianRefusal,
  toArtifactRefs,
  maybeCompleteFastLaneOnDelivery,
  type CivilianDeliveryDependencies,
} from './civilian-delivery-completion';
import { listPaneSnapshots } from './pane-registry';
import { getSquad } from './squad-store';
import { inspectTeamQuestionCompletion, isTeamQuestionMission, teamQuestionResponseSummary, type TeamQuestionCompletion, type TeamQuestionObserverBinding, type TeamQuestionPaneRuntime } from './mission-team-question-completion';
import { loadObserverPaneSessions } from './mission-team-question-observer';
import { advanceSealedTasksFromFilesOnDisk } from './mission-story-plan';
import {
  getProjectDomainStores,
  type ProjectDomainStoreSuite,
} from './project-domain-store-registry';

const JUNK_DIR = new Set([
  '.git',
  'node_modules',
  '.nexus',
  'dist',
  'coverage',
  '.cursor',
  '__pycache__',
  '.vite',
  '.next',
  'build',
]);

const FAIL_CLOSED_TOKEN =
  /session_authority_revoked|orchestrator_spawn_forbidden|sandbox_denied|sandbox_forbidden|process sandbox recusou/iu;

const MAX_WALK_FILES = 400;
const MAX_WALK_VISITS = 2_000;
const MAX_WALK_DEPTH = 6;

export type CivilianProntoPath = 'board' | 'files-modified/handoff' | 'handoffs';

export type CivilianProntoAction = 'pronto' | 'wait' | 'refuse';

export type CivilianProntoDecision = {
  readonly action: CivilianProntoAction;
  readonly path: CivilianProntoPath | null;
  readonly reason: string;
  readonly sealedDone: number;
  readonly sealedTotal: number;
};

export type CivilianProntoApplyResult = CivilianProntoDecision & {
  readonly completed: boolean;
};

export function isDesignOnlyFile(rel: string): boolean {
  const base = basename(rel).toLowerCase();
  return base === 'design.md' || base === 'product.md';
}

export function isLiveWriterPaneState(state: string | null | undefined): boolean {
  return state === 'busy' || state === 'spawning';
}

export function holdsGuidedOrLegacyReview(input: {
  readonly orchestrationMode?: string | null;
  readonly intentState?: string | null;
  readonly pendingReviewer: boolean;
}): boolean {
  const guided = input.orchestrationMode === 'guided';
  const legacy = input.intentState === 'legacy';
  if (!guided && !legacy) return false;
  return input.pendingReviewer;
}

export function decideCivilianPronto(input: {
  readonly missionStatus: string;
  readonly failClosed: boolean;
  readonly boardAllDone: boolean;
  readonly sealedDone: number;
  readonly sealedTotal: number;
  readonly hasSuccessHandoff: boolean;
  readonly productFileCount: number;
  readonly designOnly: boolean;
  readonly neverStarted: boolean;
  readonly liveWriterBusy: boolean;
  readonly holdForGuidedReview: boolean;
  readonly hasQueuedHandoffs: boolean;
  readonly idleWorkersWithoutHandoff: number;
  readonly workersDelivered: boolean;
  readonly deliveredWorkerCount?: number;
  readonly expectedWorkerCount?: number;
  readonly orchestratorBusy: boolean;
  readonly awaitingOperatorAdjustment?: boolean;
}): CivilianProntoDecision {
  const sealedDone = Math.max(0, Math.floor(input.sealedDone));
  const sealedTotal = Math.max(0, Math.floor(input.sealedTotal));
  const base = { sealedDone, sealedTotal, path: null as CivilianProntoPath | null };

  if (input.missionStatus !== 'running' || input.failClosed) {
    return { ...base, action: 'refuse', reason: 'fail-closed' };
  }
  if (input.hasQueuedHandoffs) {
    return { ...base, action: 'wait', reason: 'queued-handoffs' };
  }
  if (input.idleWorkersWithoutHandoff > 0) {
    return { ...base, action: 'wait', reason: 'idle-workers-without-handoff' };
  }
  // Writer ainda no teclado (Codex "Working") vence qualquer atalho de
  // Pronto — senão o motor sela done com o worker vivo, o Maestro "encerra
  // o turno" e o renderer varre o orquestrador. F-108.
  if (input.liveWriterBusy) {
    return { ...base, action: 'wait', reason: 'writer-busy' };
  }
  // Pedir um ajuste reabre running com os handoffs antigos ainda "success".
  // Sem esta espera o Pronto reseca a missão no mesmo tick — o botão
  // parece morto e o operador nunca chega a orientar.
  if (input.awaitingOperatorAdjustment) {
    return { ...base, action: 'wait', reason: 'awaiting-operator-adjustment' };
  }
  if (input.workersDelivered) {
    return {
      ...base,
      action: 'pronto',
      path: 'handoffs',
      reason: `all-workers-delivered (${input.deliveredWorkerCount ?? sealedDone}/${input.expectedWorkerCount ?? sealedTotal})`,
    };
  }
  if (input.boardAllDone && sealedTotal > 0) {
    return {
      ...base,
      action: 'pronto',
      path: 'board',
      reason: `board ${sealedDone}/${sealedTotal}`,
    };
  }
  if (sealedTotal > 0 && sealedDone < sealedTotal) {
    return { ...base, action: 'wait', reason: 'sealed-pending' };
  }
  if (input.designOnly || input.neverStarted) {
    return { ...base, action: 'refuse', reason: 'empty-or-design-only' };
  }
  if (input.holdForGuidedReview) {
    return { ...base, action: 'wait', reason: 'guided-legacy-review' };
  }

  const startedWork = input.hasSuccessHandoff || sealedDone > 0;
  const deliveryEvidence = input.hasSuccessHandoff;
  if (startedWork && deliveryEvidence) {
    return {
      ...base,
      action: 'pronto',
      path: 'files-modified/handoff',
      reason: `files-modified/handoff (${sealedDone}/${sealedTotal})`,
    };
  }
  return { ...base, action: 'wait', reason: 'no-delivery' };
}

function isJunkRelative(rel: string): boolean {
  return rel.split(/[/\\]/u).some((segment) => JUNK_DIR.has(segment));
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

function isNonEmptyFile(absolute: string): boolean {
  try {
    const stat = statSync(absolute);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

export function walkProductFiles(root: string): readonly string[] {
  if (!existsSync(root)) return Object.freeze([]);
  const found: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  let visits = 0;
  while (stack.length > 0 && found.length < MAX_WALK_FILES && visits < MAX_WALK_VISITS) {
    const current = stack.pop();
    if (!current) break;
    let entries;
    try {
      entries = readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visits += 1;
      const absolute = join(current.dir, String(entry.name));
      const rel = relative(root, absolute);
      if (!rel || isJunkRelative(rel)) continue;
      if (entry.isDirectory()) {
        if (current.depth < MAX_WALK_DEPTH) {
          stack.push({ dir: absolute, depth: current.depth + 1 });
        }
        continue;
      }
      if (
        entry.isFile() &&
        isNonEmptyFile(absolute) &&
        !isDesignOnlyFile(rel) &&
        !isJunkArtifactRef(rel)
      ) {
        found.push(rel);
      }
      if (found.length >= MAX_WALK_FILES) break;
    }
  }
  return Object.freeze(found);
}

export function inspectProductEvidence(files: readonly string[]): {
  readonly productFileCount: number;
  readonly designOnly: boolean;
} {
  const product = files.filter((file) => !isDesignOnlyFile(file));
  const design = files.filter((file) => isDesignOnlyFile(file));
  return {
    productFileCount: product.length,
    designOnly: product.length === 0 && design.length > 0,
  };
}

function failClosedHaystack(
  mission: Pick<Mission, 'status' | 'intentState' | 'description' | 'learnings'>,
  handoffs: readonly Pick<Handoff, 'summary' | 'status'>[],
): boolean {
  if (mission.status === 'failed' || mission.status === 'blocked') return true;
  if (mission.intentState === 'blocked_technical') return true;
  const haystack = [
    mission.description ?? '',
    mission.learnings ?? '',
    ...handoffs.map((handoff) => `${handoff.status} ${handoff.summary}`),
  ].join('\n');
  return FAIL_CLOSED_TOKEN.test(haystack);
}

function paneAgentKey(name: string | null | undefined): string {
  return (name ?? '').trim().toLowerCase();
}

function findOrchestratorHandoffSummary(
  mission: Mission,
  stores: Pick<ProjectDomainStoreSuite, 'missions' | 'handoffs' | 'missionPanes'>,
): string | null {
  try {
    const panes = stores.missionPanes?.list(mission.id) ?? [];
    const orchestratorNames = new Set(
      panes
        .filter((pane) => pane.role === 'orchestrator')
        .flatMap((pane) => [
          paneAgentKey(pane.agentName),
          paneAgentKey(pane.title),
        ])
        .filter((name) => name.length > 0),
    );
    if (orchestratorNames.size === 0) return null;
    const handoffs = stores.handoffs?.list({ missionId: mission.id, includeDelivered: true }) ?? [];
    const orchestratorHandoff = handoffs
      .reverse()
      .find(
        (handoff) =>
          (handoff.status === 'success' || handoff.status === 'partial') &&
          orchestratorNames.has(paneAgentKey(handoff.fromAgent)),
      );
    return orchestratorHandoff?.summary?.trim() || null;
  } catch {
    return null;
  }
}

function buildConsolidatedSummary(
  mission: Mission,
  stores: Pick<ProjectDomainStoreSuite, 'handoffs'>,
): string | null {
  try {
    const handoffs = stores.handoffs?.list({ missionId: mission.id, includeDelivered: true }) ?? [];
    const workerSummaries = handoffs
      .filter(
        (handoff) =>
          (handoff.status === 'success' || handoff.status === 'partial') &&
          handoff.summary?.trim(),
      )
      .map((handoff) => `- ${handoff.fromAgent}: ${handoff.summary!.trim()}`);
    if (workerSummaries.length === 0) return null;
    return `Consolidado das respostas dos panes para "${mission.title}":\n${workerSummaries.join('\n')}`;
  } catch {
    return null;
  }
}

/**
 * Traduz o motivo técnico do Pronto para uma frase que o leigo entende.
 * Desconhecido cai numa frase neutra e verdadeira — nunca no token cru.
 */
export function civilProntoReason(reason: string): string {
  const board = reason.match(/^board (\d+)\/(\d+)$/u);
  if (board) {
    const total = Number(board[2]);
    return total === 1
      ? 'A única etapa do quadro foi concluída.'
      : `As ${total} etapas do quadro foram concluídas.`;
  }
  const delivered = reason.match(/^all-workers-delivered \((\d+)\/(\d+)\)$/u);
  if (delivered) {
    const total = Number(delivered[2]);
    return total === 1
      ? 'O integrante da equipe entregou.'
      : `Os ${total} integrantes da equipe entregaram.`;
  }
  if (reason.startsWith('files-modified')) {
    return 'Os arquivos do projeto foram alterados e a entrega foi registrada.';
  }
  return 'A entrega foi verificada.';
}

export function applyCivilianProntoDecision(input: {
  readonly scope: ProjectExecutionScope;
  readonly mission: Mission;
  readonly decision: CivilianProntoDecision;
  readonly productFiles: readonly string[];
  readonly engine: Pick<MissionEngine, 'completeVerified'>;
  readonly stores: Pick<ProjectDomainStoreSuite, 'missions' | 'handoffs' | 'missionPanes'>;
  readonly teamQuestion?: TeamQuestionCompletion;
}): boolean {
  if (input.decision.action !== 'pronto') return false;
  const files = toArtifactRefs(input.productFiles);
  const orchestratorSummary = findOrchestratorHandoffSummary(
    input.mission,
    input.stores,
  );
  const consolidatedSummary = buildConsolidatedSummary(
    input.mission,
    input.stores,
  );
  // O `reason` é token de motor em inglês ("board 1/1",
  // "files-modified/handoff") e vazava para o ÚNICO texto que o leigo lê na
  // aba Resultado. Ele continua inteiro no log (linha do fast-lane); aqui vai
  // a versão civil.
  const civilReason = civilProntoReason(input.decision.reason);
  const baseSummary = input.teamQuestion?.applicable
    ? teamQuestionResponseSummary(input.teamQuestion)
    : orchestratorSummary
    ? `${orchestratorSummary} (${civilReason})`
    : consolidatedSummary
      ? `${consolidatedSummary} (${civilReason})`
      : `${civilReason} ${files.length} arquivo(s) no disco.`;
  const summary = baseSummary.slice(0, 65_536);
  const result = missionResultSchema.parse({
    outcome: 'success',
    summary,
    evidenceIds: [],
    artifactRefs: files,
  });
  const learnings = (
    input.mission.learnings.trim()
      ? `${input.mission.learnings}\n\n## Pronto (entrega civil)\n${summary}`
      : `## Pronto (entrega civil)\n${summary}`
  ).slice(-65_536);
  input.engine.completeVerified(input.scope, {
    missionId: input.mission.id,
    expectedStatus: 'running',
    expectedIntentState: input.mission.intentState ?? 'legacy',
    expectedUpdatedAt: input.mission.updatedAt,
    expectedIntentVersion: input.mission.intentVersion ?? 0,
    learnings,
    result,
  });
  const completed = input.stores.missions.get(input.mission.id);
  return completed?.status === 'done' && Boolean(completed.result);
}

export type CivilianProntoDependencies = {
  readonly getStores?: (scope: ProjectExecutionScope) => ProjectDomainStoreSuite;
  readonly getSquad?: (squadId: string) => Squad | null;
  readonly listPanes?: () => readonly (TeamQuestionPaneRuntime & {
    readonly missionId?: string | null;
    readonly agentName?: string | null;
    readonly role?: string;
    readonly state?: string | null;
  })[];
  readonly listObserverPaneSessions?: (missionId: string) => readonly TeamQuestionObserverBinding[];
  readonly listProductFiles?: (root: string) => readonly string[];
  readonly missionEngine?: Pick<MissionEngine, 'completeVerified' | 'blockUser'>;
  readonly runAutoReviewGate?: CivilianDeliveryDependencies['runAutoReviewGate'];
  readonly captureCandidate?: CivilianDeliveryDependencies['captureCandidate'];
};

/**
 * Via Rápida: se o motor justifica Pronto, persiste `done` + result.
 * O header civil (estado `completed` → rótulo Pronto) só quando N/N.
 * Board N/M permanece honesto — não inventa 20/20.
 */
export async function maybeApplyCivilianPronto(
  scope: ProjectExecutionScope,
  missionId: string | undefined,
  deps: CivilianProntoDependencies = {},
): Promise<CivilianProntoApplyResult> {
  const empty = (action: CivilianProntoAction, reason: string): CivilianProntoApplyResult => ({
    action,
    path: null,
    reason,
    sealedDone: 0,
    sealedTotal: 0,
    completed: false,
  });
  if (!missionId) return empty('refuse', 'no-mission');

  const stores = deps.getStores?.(scope) ?? getProjectDomainStores(scope);
  const mission = stores.missions.get(missionId);
  if (!mission) return empty('refuse', 'missing');
  if (mission.status !== 'running') return empty('refuse', 'not-running');

  let handoffs: readonly Handoff[] = [];
  try {
    handoffs = stores.handoffs.list({ missionId, includeDelivered: true });
  } catch {
    return empty('wait', 'handoffs-unreadable');
  }
  if (failClosedHaystack(mission, handoffs)) {
    return empty('refuse', 'fail-closed');
  }

  const panes = deps.listPanes?.() ??
    (typeof listPaneSnapshots === 'function' ? listPaneSnapshots() : []);
  const teamQuestion = inspectTeamQuestionCompletion({
    mission,
    squad: isTeamQuestionMission(mission) && mission.squadId
      ? (deps.getSquad ?? getSquad)(mission.squadId) : null,
    panes: stores.missionPanes?.list?.(missionId) ?? [],
    runtimePanes: panes,
    handoffs,
    observerPaneSessions: deps.listObserverPaneSessions?.(missionId) ??
      loadObserverPaneSessions(scope, missionId),
  });
  if (!teamQuestion.ready) return empty('wait', teamQuestion.reason);

  const files = teamQuestion.applicable ? [] :
    deps.listProductFiles?.(scope.rootRealPath) ??
    walkProductFiles(scope.rootRealPath);
  try {
    advanceSealedTasksFromFilesOnDisk(stores, {
      missionId,
      filesModified: files,
      uniqueMatchesOnly: true,
    });
  } catch (error) {
    console.warn(
      '[civilian-pronto] pending-with-file falhou (fail-closed):',
      error instanceof Error ? error.message : error,
    );
  }

  const tasks = stores.tasks.list(missionId);
  const sealedDone = tasks.filter((task) => task.status === 'done').length;
  const sealedTotal = tasks.length;
  const boardAllDone =
    sealedTotal > 0 && tasks.every((task) => task.status === 'done');

  let planned: ReturnType<ProjectDomainStoreSuite['tasks']['listPlannedTasks']> =
    [];
  try {
    planned = stores.tasks.listPlannedTasks(
      missionId,
      mission.intentVersion ?? 0,
    );
  } catch {
    planned = [];
  }

  const missionPanes = panes.filter((pane) => pane.missionId === mission.id);
  const liveWriterBusy = missionPanes.some(
    (pane) =>
      pane.role !== 'orchestrator' && isLiveWriterPaneState(pane.state),
  );
  const orchestratorBusy = missionPanes.some(
    (pane) => pane.role === 'orchestrator' && isLiveWriterPaneState(pane.state),
  );

  const pendingReviewer = planned.some((row) => {
    if (row.agentCategory !== 'reviewer' && row.agent.category !== 'reviewer') {
      return false;
    }
    const task = tasks.find((candidate) => candidate.id === row.taskId);
    if (!task || task.status === 'done') return false;
    const live = missionPanes.some(
      (pane) =>
        paneAgentKey(pane.agentName) === paneAgentKey(row.agent.agentName) &&
        (pane.state === 'busy' || pane.state === 'spawning' || pane.state === 'idle'),
    );
    return !live || task.status === 'pending';
  });

  const evidence = inspectProductEvidence(files);
  const hasSuccessHandoff = handoffs.some(
    (handoff) => handoff.status === 'success' || handoff.status === 'partial',
  );
  const neverStarted =
    !hasSuccessHandoff &&
    evidence.productFileCount === 0 &&
    sealedDone === 0 &&
    !liveWriterBusy;

  const hasQueuedHandoffs = hasUnsettledQueuedHandoffs(handoffs, {
    orchestratorSessionId: mission.orchestratorSessionId,
  });

  const successHandoffs = handoffs.filter(
    (handoff) => handoff.status === 'success' || handoff.status === 'partial',
  );
  const idleWorkersWithoutHandoff = missionPanes.filter(
    (pane) =>
      pane.role !== 'orchestrator' &&
      isSatOrTombstonedPaneState(pane.state) &&
      !successHandoffs.some((handoff) =>
        matchHandoffToAgent(handoff, pane.agentName ?? '', ''),
      ),
  ).length;
  const workersDelivered = successHandoffs.length > 0 && !liveWriterBusy;

  const decision = decideCivilianPronto({
    missionStatus: mission.status,
    failClosed: failClosedHaystack(mission, handoffs),
    boardAllDone,
    sealedDone,
    sealedTotal,
    hasSuccessHandoff,
    productFileCount: evidence.productFileCount,
    designOnly: evidence.designOnly,
    neverStarted,
    liveWriterBusy,
    holdForGuidedReview: holdsGuidedOrLegacyReview({
      orchestrationMode: mission.intentContract?.orchestrationMode,
      intentState: mission.intentState,
      pendingReviewer,
    }),
    hasQueuedHandoffs,
    idleWorkersWithoutHandoff,
    workersDelivered,
    ...(teamQuestion.applicable ? {
      deliveredWorkerCount: teamQuestion.responses.length,
      expectedWorkerCount: teamQuestion.responses.length + teamQuestion.missingTargets.length,
    } : {}),
    orchestratorBusy,
    awaitingOperatorAdjustment: holdsAwaitingOperatorAdjustment(
      mission.description ?? '',
      successHandoffs,
    ),
  });

  if (decision.action !== 'pronto') {
    return { ...decision, completed: false };
  }

  console.info(
    `[fast-lane] Pronto justified by ${decision.reason}`,
  );

  let completed = false;
  try {
    const result = await maybeCompleteFastLaneOnDelivery(scope, missionId, deps);
    completed = result.completed;
    if (!completed) {
      return {
        ...decision,
        action: result.action.startsWith('refuse') ? 'refuse' : 'wait',
        reason: result.reason ?? result.action,
        completed: false,
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Recusa por revisão: o civilian-delivery é quem abre o revisor; aqui só
    // não podemos virar loop de log a cada tick.
    // Chave própria: o pronto NÃO pode consumir a janela do civilian-delivery
    // (é o delivery quem abre o revisor pós-recusa).
    if (
      isCivilianReviewRefusal(message)
        ? noteCivilianReviewRefusal(`${mission.id}:pronto`)
        : shouldLogCivilianRefusal(`${mission.id}:pronto`, message)
    ) {
      console.warn(
        `[civilian-pronto] completeVerified recusou (mission=${mission.id}):`,
        message,
      );
    }
  }

  return { ...decision, completed };
}

/** @internal — resolve workspace path for tests. */
export function resolveWorkspaceFile(root: string, rawPath: string): string | null {
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.includes('\0')) return null;
  const absolute = isAbsolute(trimmed) ? resolve(trimmed) : resolve(root, trimmed);
  if (!isWithin(root, absolute)) return null;
  return absolute;
}
