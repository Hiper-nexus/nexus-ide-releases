import { missionExecutionScope, missionExecutionBaseSha } from './mission-execution-scope';
import { awaitsOperatorTabCompletionRequest, hasCurrentCompletionRequest } from './operator-tab-completion';
import { missionIntentAuthoritySnapshot } from '../../shared/mission-intent';
import { execFile } from 'node:child_process';
import { hasCurrentMissionRuntimeCloseVerdict, holdsAwaitingOperatorAdjustment } from '../../shared/mission-recovery-policy';
import {
  existsSync,
  statSync,
} from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { AgentCategory, Handoff, Mission, Squad, SquadAgent } from '../../shared/orch-types';
import { PET_STUDIO_SQUAD_ID } from '../../shared/pet-studio';
import { missionResultSchema } from '../../shared/mission-engine-contract';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  enforceCivilianAutoReview,
  resolveAutoReviewBaseSha,
  type CivilianAutoReviewOutcome,
} from './civilian-auto-review';
import { missionRequiresIndependentReview } from './mission-independent-review-gate';
import { listPaneSnapshots, requestPaneSpawn } from './pane-registry';
import { isAgentAwaitingOperator } from './agent-status';
import {
  getProjectDomainStores,
  requireProjectDomainStoreRegistry,
  type ProjectDomainStoreSuite,
} from './project-domain-store-registry';
import { missionEngineForScope } from './mission-engine-registry';
import { getSquad } from './squad-store';
import { inspectTeamQuestionCompletion, isTeamQuestionMission, teamQuestionResponseSummary, type TeamQuestionObserverBinding, type TeamQuestionPaneRuntime } from './mission-team-question-completion';
import { loadObserverPaneSessions } from './mission-team-question-observer';
import { classifySeatAuth } from '../adapters/seat-auth-readiness';
import { detectSubscriptionAuthReadiness } from '../adapters/subscription-auth';
import {
  hasRuntimeKey,
  providerAuthStrategy,
  providerReadiness,
} from '../persistence/provider-config-store';
import { firstSeatableCli } from '../../shared/seat-chains';
import type { MissionEngine } from './mission-engine';
import {
  advanceSealedTasksFromFilesOnDisk,
  storyConfirmationScript,
} from './mission-story-plan';
import type { ScopedTaskRecord } from './task-store';
import { missionLifecycleKey } from './mission-lifecycle-lock';
import { captureWorkingTreeCandidate } from '../context/candidate-working-tree-snapshot';
import { withAutomaticCompletionProof, assertCompletionEffectsSettled, type AutomaticCompletionProof } from './automatic-completion-proof';
import type { MissionCodeCompletionOutcome } from './mission-code-completion';
import { SKIP_DIRECTORIES } from '../context/orientation/orientation-types';
import { readFrozenMissionReviewContext } from './mission-review-proof';
import { AsyncProcessGitRunner } from '../runtime/git-command';
import { listMtimePathsSince } from './worker-delivery-evidence';
import { MissionLeadershipError, type MissionLeader } from './mission-leadership';
import { getMissionLeadership } from './mission-leadership-runtime';
import { runPeriodicTask, type PeriodicTaskContext } from '../observability/periodic-task';

const execFileAsync = promisify(execFile);

/** After this, queued review seats must spawn or the civilian mission closes. */
export const CIVILIAN_REVIEW_QUEUE_GRACE_MS = 45_000;

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
  '.nuxt',
  'build',
]);

const JUNK_FILE = /(?:^|[/\\])(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|\.DS_Store)$/u;

const REVIEW_HOLD_TASK =
  /regression|quality-gate|independent-review|guided-regression|guided-quality/iu;

const KICKOFF_FILE =
  /(?:^|[^\w./-])((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z][A-Za-z0-9]{0,7})/gu;


export type CivilianDeliveryAction =
  | 'complete'
  | 'spawn-review'
  | 'reroute'
  | 'wait'
  | 'refuse-empty'
  | 'refuse-fail-closed';

export type CivilianRemainderKind = 'review' | 'never-started' | 'sat' | 'blocking';

export type CivilianCompletionPath = 'board' | 'evidence' | 'handoff' | null;

export interface CivilianDeliveryDecisionInput {
  readonly failClosed: boolean;
  readonly boardAllDone: boolean;
  readonly hasExpectedDelivery: boolean;
  readonly designOnly: boolean;
  readonly neverStartedDraft: boolean;
  readonly hasSuccessHandoff: boolean;
  readonly hasRealWorkerDelivery: boolean;
  readonly holdForReview: boolean;
  readonly productFileCount: number;
  readonly activeWriterCount: number;
  readonly workersDelivered: boolean;
  readonly hasQueuedHandoffs: boolean;
  readonly idleWorkersWithoutHandoff: number;
  readonly remainingKinds: readonly CivilianRemainderKind[];
  readonly oldestReviewQueuedMs: number | null;
  readonly orchestratorBusy?: boolean;
  readonly awaitingOperatorAdjustment?: boolean;
}

export interface CivilianDeliveryResult {
  readonly action: CivilianDeliveryAction;
  readonly completed: boolean;
  readonly path: CivilianCompletionPath;
  readonly spawnedReviewers: readonly string[];
  readonly markedDoneTaskIds: readonly string[];
  readonly productFiles: readonly string[];
  readonly reason?: string;
  readonly missingTargets?: readonly string[];
}

export type CivilianRemainderTask = {
  readonly id: string;
  readonly kind: CivilianRemainderKind;
  readonly status: string;
  readonly agentName: string;
  readonly queuedMs: number;
};

type LivePane = TeamQuestionPaneRuntime & {
  readonly missionId?: string | null;
  readonly agentName?: string | null;
  readonly role?: 'orchestrator' | 'worker' | string;
  readonly state?: string | null;
  readonly sessionId?: string | null;
  /** F-1272: one-shot (agy --print / opencode run) com a raiz viva. */
  readonly oneShotAlive?: boolean;
};

// F-1272: one-shot com a raiz viva trabalha de tela muda — conta como writer
// vivo, nunca como writer que sentou (idle/parou sem entrega).
function isLiveWorkerPane(pane: LivePane): boolean {
  return isLiveWriterPaneState(pane.state) || pane.oneShotAlive === true;
}

function isSatWorkerPane(pane: LivePane): boolean {
  return isSatOrTombstonedPaneState(pane.state) && pane.oneShotAlive !== true;
}

export interface CivilianDeliveryDependencies {
  readonly runCodeCompletionGate?: CivilianCodeCompletionGate;
  readonly readFrozenReviewContext?: typeof readFrozenMissionReviewContext;
  readonly captureCandidate?: (scope: ProjectExecutionScope) => Promise<{
    readonly fingerprint: string;
    readonly complete: boolean;
    readonly deletedPaths?: readonly string[];
  }>;
  readonly getStores?: (scope: ProjectExecutionScope) => CivilianStores;
  readonly listPanes?: () => readonly LivePane[];
  readonly listObserverPaneSessions?: (missionId: string) => readonly TeamQuestionObserverBinding[];
  readonly listProductFiles?: (
    root: string,
    handoffs: readonly Handoff[],
    kickoffText?: string,
    createdAt?: number,
  ) => readonly string[] | Promise<readonly string[]>;
  readonly now?: () => number;
  readonly spawnReviewers?: (
    scope: ProjectExecutionScope,
    mission: Mission,
    reviewers: readonly SquadAgent[],
  ) => Promise<readonly string[]>;
  readonly missionEngine?: Pick<MissionEngine, 'completeVerified' | 'blockUser'>;
  readonly getSquad?: (squadId: string) => {
    readonly id?: string;
    agents: readonly SquadAgent[];
  } | null;
  /** First-wave curto: senta stories seladas ainda pending/never-started. */
  readonly rerouteUnassigned?: (
    pendingTitles: readonly string[],
  ) => Promise<number | void> | number | void;
  /** Revisão automática main-owned (injetável para testes). */
  readonly runAutoReviewGate?: (
    input: {
      mission: Mission;
      scope: ProjectExecutionScope;
      productFiles: readonly string[];
      /** Internal Main lifetime; never supplied by renderer/provider payload. */
      lifetime?: PeriodicTaskContext;
    },
  ) => Promise<CivilianAutoReviewOutcome>;
  /** Injetável para testes; produção usa `getMissionLeadership().resolveMissionLeader`. */
  readonly resolveMissionLeader?: (
    scope: ProjectExecutionScope,
    missionId: string,
  ) => MissionLeader | null;
}

export type CivilianCodeCompletionGate = (input: {
  readonly scope: ProjectExecutionScope;
  readonly mission: Mission;
  readonly productFiles: readonly string[];
  readonly liveOrchestratorSessionId?: string | null;
  readonly lifetime?: PeriodicTaskContext;
}) => Promise<MissionCodeCompletionOutcome>;
let civilianCodeCompletionGate: CivilianCodeCompletionGate | null = null;

/** Main startup wiring; an absent verifier never turns into scanner-only approval. */
export function configureCivilianCodeCompletionGate(gate: CivilianCodeCompletionGate | null): void {
  civilianCodeCompletionGate = gate;
}

export type CivilianStores = {
  readonly missions: {
    get: (id: string) => (Mission & { result?: unknown }) | null;
  };
  readonly handoffs: {
    list: (query?: { missionId?: string; includeDelivered?: boolean }) => readonly Handoff[];
  };
  readonly tasks: {
    list: (missionId?: string) => readonly ScopedTaskRecord[];
    listPlannedTasks: (
      missionId: string,
      intentVersion: number,
    ) => readonly {
      readonly taskId: string;
      readonly agentCategory: AgentCategory;
      readonly agent: Pick<SquadAgent, 'id' | 'agentName' | 'category'>;
    }[];
    markLifecycleStatus: (
      taskId: string,
      status: 'running' | 'done' | 'failed',
    ) => ScopedTaskRecord | null;
    advanceSealedTaskStatus?: (
      taskId: string,
      status: 'running' | 'done' | 'failed',
    ) => ScopedTaskRecord | null;
  };
  readonly missionPanes?: Pick<ProjectDomainStoreSuite['missionPanes'], 'record' | 'list'>;
};

function storesReady(stores: Partial<CivilianStores> | null | undefined): stores is CivilianStores {
  const tasks = stores?.tasks;
  return Boolean(
    stores?.missions &&
      typeof stores.missions.get === 'function' &&
      stores.handoffs &&
      typeof stores.handoffs.list === 'function' &&
      tasks &&
      typeof tasks.list === 'function' &&
      typeof tasks.listPlannedTasks === 'function' &&
      typeof tasks.markLifecycleStatus === 'function',
  );
}

export function isLiveWriterPaneState(state: string | null | undefined): boolean {
  return state === 'busy' || state === 'spawning';
}

export function isSatOrTombstonedPaneState(state: string | null | undefined): boolean {
  return (
    state === 'idle' ||
    state === 'exited' ||
    state === 'hibernated' ||
    state === 'parou' ||
    state === 'tombstoned'
  );
}

/**
 * Recusa do gate de revisão (review_missing/without_evidence): responder a
 * CADA tick re-tentando completeVerified virava loop quente — 163 recusas em
 * minutos na missão real de 19/08. Uma recusa por missão abre UMA janela:
 * loga uma vez, spawna o revisor pendente uma vez e silencia até o cooldown.
 */
const REVIEW_REFUSAL_COOLDOWN_MS = 60_000;
const reviewRefusalAt = new Map<string, number>();

export function isCivilianReviewRefusal(message: string): boolean {
  return /review_(missing|without_evidence)/.test(message);
}

/** true = primeira recusa desta janela (chamador loga/spawna); false = silencia. */
export function noteCivilianReviewRefusal(
  missionId: string,
  now = Date.now(),
): boolean {
  const last = reviewRefusalAt.get(missionId);
  if (last !== undefined && now - last < REVIEW_REFUSAL_COOLDOWN_MS) {
    return false;
  }
  reviewRefusalAt.set(missionId, now);
  return true;
}

export function clearCivilianReviewRefusal(missionId: string): void {
  reviewRefusalAt.delete(missionId);
  refusalLogReasonByMission.delete(missionId);
  reviewerRespawnUsed.delete(missionId);
}

/**
 * Disjuntor do respawn de revisor (caso de campo 20/08): o revisor do roster
 * (AGY) morria no spawn e a janela de 1s reabria OUTRO a cada tick — 17 panes
 * vazios "abrindo do nada" numa missão de 1+1. Um orçamento por missão limita
 * o total de tentativas; esgotado, o chamador loga UMA instrução acionável e
 * para de fabricar pane. O orçamento zera quando a missão completa.
 */
const REVIEWER_RESPAWN_BUDGET = 3;
const reviewerRespawnUsed = new Map<string, number>();

/** true = ainda há orçamento (e consome 1); false = disjuntor aberto. */
export function takeReviewerRespawnBudget(missionId: string): boolean {
  const used = reviewerRespawnUsed.get(missionId) ?? 0;
  if (used >= REVIEWER_RESPAWN_BUDGET) return false;
  reviewerRespawnUsed.set(missionId, used + 1);
  return true;
}

/**
 * Recusa idêntica repetida a cada tick vira UMA linha nomeada com missionId
 * (gate 0.62: dezenas de "review_rejected" anônimos afogavam o log e ninguém
 * sabia de QUAL missão). Loga de novo só quando o motivo MUDA.
 */
const refusalLogReasonByMission = new Map<string, string>();

export function shouldLogCivilianRefusal(
  missionId: string,
  reason: string,
): boolean {
  if (refusalLogReasonByMission.get(missionId) === reason) return false;
  refusalLogReasonByMission.set(missionId, reason);
  return true;
}

/** Auth present real do CLI (mesma classificação do first-wave). */
function reviewerCliCanSeat(cli: string): boolean {
  try {
    if (cli === 'qwen' && !providerReadiness(cli).ready) return false;
    const readiness = detectSubscriptionAuthReadiness(cli);
    return (
      classifySeatAuth({
        adapterId: cli,
        authStrategy: String(providerAuthStrategy(cli) ?? ''),
        hasKey: hasRuntimeKey(cli),
        kimiListReadiness: cli === 'kimi' ? readiness : undefined,
        hasCredentiallessModel: readiness === 'present',
      }) === 'present'
    );
  } catch {
    return false;
  }
}

/**
 * Roster com reviewer sem credencial (voo de 19/08: reviewer:cursor-agent
 * sem login) não pode virar loop de spawn-falha — o assento caminha a CADEIA
 * de sucessão (primário → escalação → piso, shared/seat-chains) e o primeiro
 * elo present senta. Sem elo present, mantém o original: a falha fica
 * VISÍVEL no pane em vez de silenciosa.
 */
export function remintReviewerForSeat(
  agent: SquadAgent,
  canSeat: (cli: string) => boolean = reviewerCliCanSeat,
): SquadAgent {
  const successor = firstSeatableCli({ primaryCli: agent.cli, canSeat });
  if (!successor || successor === agent.cli) return agent;
  // SEM modelo (chave ausente): o spawn resolve provider-default →
  // adapter-default. String vazia explodia o zod min(1) do
  // missionPanes.record NO MEIO do loop de spawn (gate 0.62: revisor
  // nasceu e o registro morreu — missão presa com trabalho pronto).
  const { model: _dropped, ...rest } = agent;
  return { ...rest, cli: successor } as SquadAgent;
}

export function isReviewCategory(category: AgentCategory | string | undefined): boolean {
  return category === 'reviewer';
}

export function isWriterCategory(category: AgentCategory | string | undefined): boolean {
  return category === 'executor' || category === 'architect';
}

export function isDesignOnlyFile(rel: string): boolean {
  const base = basename(rel).toLowerCase();
  return base === 'design.md' || base === 'product.md';
}

export function extractKickoffRequestedFiles(text: string): string[] {
  const found = new Set<string>();
  KICKOFF_FILE.lastIndex = 0;
  for (const match of text.matchAll(KICKOFF_FILE)) {
    const raw = match[1]?.trim();
    if (!raw || isDesignOnlyFile(raw)) continue;
    found.add(raw.split('\\').join('/'));
  }
  return [...found];
}

function posixRel(rel: string): string {
  return rel.split(/[/\\]/u).join('/');
}

function isServerFile(rel: string): boolean {
  return /^(server|app|main|index)\.(js|ts|mjs|cjs|py|go)$/iu.test(basename(rel));
}

function isPageFile(rel: string): boolean {
  const posix = posixRel(rel);
  const base = basename(rel);
  return (
    /^(page|layout|app|landing|index)\.(tsx|jsx|js|html)$/iu.test(base) ||
    /(?:^|\/)index\.html$/iu.test(posix) ||
    /(?:^|\/)(?:public|src|app|pages|www)\/.+\.(html|tsx|jsx)$/iu.test(posix)
  );
}

function isSmokeFile(rel: string): boolean {
  const base = basename(rel).toLowerCase();
  return /smoke/u.test(base) && /\.(js|mjs|cjs|ts|sh|html)$/u.test(base);
}

function isPackageFile(rel: string): boolean {
  return basename(rel).toLowerCase() === 'package.json';
}

function isImplFile(rel: string): boolean {
  return (
    /\.(js|ts|tsx|jsx|mjs|cjs|html|css|py|go|json)$/iu.test(rel) &&
    !isDesignOnlyFile(rel) &&
    !JUNK_FILE.test(rel)
  );
}

export function inspectDeliveryEvidence(
  files: readonly string[],
  kickoffText = '',
): {
  readonly expected: boolean;
  readonly designOnly: boolean;
  readonly productFiles: readonly string[];
} {
  const product = files.filter((file) => !isDesignOnlyFile(file) && !isJunkRelative(file));
  const design = files.filter((file) => isDesignOnlyFile(file));
  const kickoff = new Set(extractKickoffRequestedFiles(kickoffText).map(posixRel));
  const kickoffHit = product.filter((file) => kickoff.has(posixRel(file)));
  const hasPackage = product.some((file) => isPackageFile(file));
  const hasServer = product.some((file) => isServerFile(file));
  const hasPage = product.some((file) => isPageFile(file));
  const hasSmoke = product.some((file) => isSmokeFile(file));
  const impl = product.filter((file) => isImplFile(file) && !isPackageFile(file));
  const expected =
    kickoffHit.length > 0 ||
    (hasPackage && (hasServer || hasPage || impl.length >= 1)) ||
    (hasServer && hasPage) ||
    (hasSmoke && (hasServer || hasPage || impl.length >= 2)) ||
    impl.length >= 3;
  return {
    expected,
    designOnly: product.length === 0 && design.length > 0,
    productFiles: product,
  };
}

export function isFailClosedCivilianMission(
  mission: Pick<Mission, 'status' | 'intentState'>,
): boolean {
  return (
    mission.status === 'failed' ||
    mission.status === 'blocked' ||
    mission.intentState === 'blocked_technical'
  );
}

export function holdsReviewForLegacyOrRegression(
  mission: Pick<Mission, 'intentState' | 'intentContract'>,
  planned: readonly { readonly taskId: string; readonly agent: { readonly agentName: string } }[],
  remaining: readonly Pick<CivilianRemainderTask, 'kind' | 'agentName'>[],
): boolean {
  const guided = mission.intentContract?.orchestrationMode === 'guided';
  const legacy = mission.intentState === 'legacy';
  const hasRegressionPlan = planned.some(
    (row) =>
      REVIEW_HOLD_TASK.test(row.taskId) || REVIEW_HOLD_TASK.test(row.agent.agentName),
  );
  if (!guided && !legacy && !hasRegressionPlan) return false;
  return remaining.some(
    (row) =>
      row.kind === 'review' ||
      REVIEW_HOLD_TASK.test(row.agentName) ||
      /revisor/iu.test(row.agentName),
  );
}

function needsSealedReroute(
  remaining: readonly CivilianRemainderKind[],
): boolean {
  return remaining.includes('never-started') || remaining.includes('sat');
}

export function decideCivilianDeliveryAction(
  input: CivilianDeliveryDecisionInput,
): CivilianDeliveryAction {
  if (input.failClosed) return 'refuse-fail-closed';
  if (input.awaitingOperatorAdjustment) return 'wait';
  if (input.hasQueuedHandoffs && !input.boardAllDone) return 'wait';
  if (input.idleWorkersWithoutHandoff > 0 && input.boardAllDone) return 'wait';
  // Writer ainda no teclado vence o board N/N, como em decideCivilianPronto:
  // o reconcile do disco marca a story done nos primeiros arquivos do turno,
  // e fechar aqui matava o worker no meio do trabalho (F-166).
  if (input.boardAllDone && input.activeWriterCount > 0) return 'wait';
  // Orchestrator busy: ele pode spawnar mais workers — não fechar a missão
  // só porque o board selado está N/N (tasks marcadas done pelo handoff do
  // primeiro worker antes de o Maestro pedir o segundo).
  if (input.boardAllDone && !input.orchestratorBusy) return 'complete';
  if (input.boardAllDone && input.orchestratorBusy) return 'wait';
  if (input.designOnly || input.neverStartedDraft) return 'refuse-empty';

  if (
    input.hasExpectedDelivery &&
    input.activeWriterCount === 0 &&
    input.hasRealWorkerDelivery
  ) {
    if (input.holdForReview) {
      const hasReview = input.remainingKinds.includes('review');
      if (
        hasReview &&
        input.oldestReviewQueuedMs !== null &&
        input.oldestReviewQueuedMs >= CIVILIAN_REVIEW_QUEUE_GRACE_MS
      ) {
        return 'spawn-review';
      }
      return 'wait';
    }
    if (needsSealedReroute(input.remainingKinds)) return 'reroute';
    if (input.remainingKinds.some((kind) => kind !== 'review')) return 'wait';
    if (input.orchestratorBusy) return 'wait';
    return 'complete';
  }

  if (input.productFileCount <= 0) return 'refuse-empty';
  if (!input.hasSuccessHandoff || !input.workersDelivered) return 'wait';
  if (input.activeWriterCount > 0) return 'wait';

  const remaining = input.remainingKinds;
  if (input.holdForReview && remaining.includes('review')) {
    if (
      input.oldestReviewQueuedMs !== null &&
      input.oldestReviewQueuedMs >= CIVILIAN_REVIEW_QUEUE_GRACE_MS
    ) {
      return 'spawn-review';
    }
    return 'wait';
  }

  const hasReview = remaining.includes('review');
  if (
    hasReview &&
    input.oldestReviewQueuedMs !== null &&
    input.oldestReviewQueuedMs >= CIVILIAN_REVIEW_QUEUE_GRACE_MS
  ) {
    return 'spawn-review';
  }
  if (needsSealedReroute(remaining)) return 'reroute';
  if (remaining.some((kind) => kind !== 'review')) return 'wait';
  if (input.orchestratorBusy) return 'wait';
  return 'complete';
}

function artifactPath(artifact: unknown): string | null {
  if (typeof artifact === 'string') return artifact;
  if (!artifact || typeof artifact !== 'object') return null;
  const candidate = (artifact as { path?: unknown }).path;
  return typeof candidate === 'string' ? candidate : null;
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

function isJunkRelative(rel: string): boolean {
  if (JUNK_FILE.test(rel)) return true;
  return rel.split(/[/\\]/u).some((segment) => JUNK_DIR.has(segment));
}

function isAutomaticallyDiscoverableArtifact(relativePath: string): boolean {
  return !relativePath.split(/[/\\]/u).slice(0, -1).some((directory) =>
    SKIP_DIRECTORIES.has(directory) || directory === '.qwen' || directory === '.opencode');
}

function resolveWorkspaceFile(root: string, rawPath: string): string | null {
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.includes('\0')) return null;
  const absolute = isAbsolute(trimmed)
    ? resolve(trimmed)
    : resolve(root, trimmed);
  if (!isWithin(root, absolute)) return null;
  const rel = relative(root, absolute);
  if (!rel || isJunkRelative(rel)) return null;
  return absolute;
}

function isNonEmptyFile(absolute: string): boolean {
  try {
    const stat = statSync(absolute);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function collectArtifactFiles(root: string, handoffs: readonly Handoff[]): string[] {
  const found = new Set<string>();
  for (const handoff of handoffs) {
    if (handoff.status !== 'success') continue;
    for (const artifact of handoff.artifacts ?? []) {
      const raw = artifactPath(artifact);
      if (!raw) continue;
      const absolute = resolveWorkspaceFile(root, raw);
      if (absolute && isNonEmptyFile(absolute)) found.add(relative(root, absolute));
    }
  }
  return [...found];
}

async function listGitProductFiles(root: string, baseSha?: string): Promise<string[]> {
  if (!existsSync(join(root, '.git'))) return [];
  const found = new Set<string>();
  for (const args of [
    ['diff', '--name-only', '--diff-filter=ACMR', ...(baseSha ? [baseSha] : [])],
    ['diff', '--cached', '--name-only', '--diff-filter=ACMR'],
    ['ls-files', '--others', '--exclude-standard'],
  ] as const) {
    try {
      const { stdout } = await execFileAsync('git', [...args], {
        cwd: root,
        timeout: 4_000,
      });
      for (const line of stdout.split('\n')) {
        if (!isAutomaticallyDiscoverableArtifact(line.trim())) continue;
        const absolute = resolveWorkspaceFile(root, line.trim());
        if (absolute && isNonEmptyFile(absolute)) {
          found.add(relative(root, absolute));
        }
      }
    } catch {
      // git ausente/ilegível: fail-closed neste canal — walk e artifacts ainda valem.
    }
  }
  return [...found];
}

export async function listDeliveredProductFiles(
  root: string,
  handoffs: readonly Handoff[],
  kickoffText = '',
  createdAt?: number,
  baseSha?: string,
): Promise<string[]> {
  const found = new Set<string>([
    ...collectArtifactFiles(root, handoffs),
    ...(await listGitProductFiles(root, baseSha)),
  ]);
  for (const requested of extractKickoffRequestedFiles(kickoffText)) {
    const absolute = resolveWorkspaceFile(root, requested);
    if (absolute && isNonEmptyFile(absolute)) found.add(relative(root, absolute));
  }
  if (createdAt !== undefined) {
    for (const changed of await listMtimePathsSince(root, createdAt)) {
      if (!isAutomaticallyDiscoverableArtifact(changed)) continue;
      const absolute = resolveWorkspaceFile(root, changed);
      if (absolute && isNonEmptyFile(absolute)) found.add(relative(root, absolute));
    }
  }
  return [...found].sort();
}

function paneAgentKey(name: string | null | undefined): string {
  return (name ?? '').trim().toLowerCase();
}

function classifyTaskKind(input: {
  readonly category: AgentCategory | string | undefined;
  readonly status: string;
  readonly hasLivePane: boolean;
  readonly liveBusy: boolean;
  readonly satOrTombstoned: boolean;
}): CivilianRemainderKind {
  if (isReviewCategory(input.category)) return 'review';
  if (input.liveBusy) return 'blocking';
  if (input.satOrTombstoned && isWriterCategory(input.category)) return 'sat';
  if (input.status === 'pending' && !input.hasLivePane) return 'never-started';
  if (input.status === 'running' && !input.liveBusy) return 'sat';
  if (input.status === 'pending' && input.hasLivePane && !input.liveBusy) {
    return 'sat';
  }
  return 'blocking';
}

export function matchHandoffToAgent(
  handoff: Handoff,
  agentName: string,
  agentId: string,
): boolean {
  const from = paneAgentKey(handoff.fromAgent);
  if (from && (from === paneAgentKey(agentName) || from === paneAgentKey(agentId))) {
    return true;
  }
  return false;
}

/**
 * Settlement idempotente: handoff com veredito terminal (success/partial) já
 * É o resultado — o ack físico é best-effort e nunca apodrece (paridade
 * Overclock: registro em disco é a autoridade). Só entrega EM VOO
 * (queued/submitted sem veredito) segura a conclusão da missão.
 */
export function hasUnsettledQueuedHandoffs(
  handoffs: readonly Pick<Handoff, 'deliveryState' | 'sessionId'>[],
  opts?: { readonly orchestratorSessionId?: string | null },
): boolean {
  const orch = opts?.orchestratorSessionId?.trim() ?? '';
  return handoffs.some((handoff) => {
    if (handoff.deliveryState !== 'queued') return false;
    if (orch && handoff.sessionId && handoff.sessionId === orch) return false;
    return true;
  });
}

export function inspectCivilianDelivery(input: {
  readonly mission: Mission;
  readonly tasks: readonly ScopedTaskRecord[];
  readonly planned: readonly {
    readonly taskId: string;
    readonly agentCategory: AgentCategory;
    readonly agent: Pick<SquadAgent, 'id' | 'agentName' | 'category'>;
  }[];
  readonly handoffs: readonly Handoff[];
  readonly panes: readonly LivePane[];
  readonly now: number;
  /**
   * sessionId provado por `resolveMissionLeader` (chamador resolve antes de
   * montar este input — `inspectCivilianDelivery` continua puro). `undefined`
   * quando não há líder provado; nunca `mission.orchestratorSessionId` cru.
   */
  readonly provenOrchestratorSessionId?: string;
}): {
  readonly hasSuccessHandoff: boolean;
  readonly workersDelivered: boolean;
  readonly hasRealWorkerDelivery: boolean;
  readonly neverStartedDraft: boolean;
  readonly boardAllDone: boolean;
  readonly failClosed: boolean;
  readonly holdForReview: boolean;
  readonly activeWriterCount: number;
  readonly hasQueuedHandoffs: boolean;
  readonly idleWorkersWithoutHandoff: number;
  readonly remaining: CivilianRemainderTask[];
  readonly deliveredWorkerTaskIds: string[];
  readonly orchestratorBusy: boolean;
} {
  const plannedById = new Map(input.planned.map((row) => [row.taskId, row]));
  const successHandoffs = input.handoffs.filter((handoff) => handoff.status === 'success');
  const missionPanes = input.panes.filter((pane) => pane.missionId === input.mission.id);
  const workerPanes = missionPanes.filter((pane) => pane.role !== 'orchestrator');
  const liveWorkerPanes = workerPanes.filter((pane) => isLiveWorkerPane(pane));
  const satWorkerPanes = workerPanes.filter((pane) => isSatWorkerPane(pane));
  const idleWorkersWithoutHandoff = workerPanes.filter(
    (pane) =>
      pane.role !== 'orchestrator' &&
      isSatWorkerPane(pane) &&
      !successHandoffs.some((handoff) =>
        matchHandoffToAgent(handoff, pane.agentName ?? '', ''),
      ),
  ).length;
  const liveByAgent = new Map<string, LivePane[]>();
  for (const pane of missionPanes) {
    const key = paneAgentKey(pane.agentName);
    if (!key) continue;
    const list = liveByAgent.get(key) ?? [];
    list.push(pane);
    liveByAgent.set(key, list);
  }

  const deliveredWorkerTaskIds: string[] = [];
  const remaining: CivilianRemainderTask[] = [];
  let writerTasks = 0;
  let deliveredWriters = 0;
  let doneWriters = 0;
  let satWriters = 0;
  let activeWriterCount = 0;
  let failedTasks = 0;

  for (const task of input.tasks) {
    if (task.status === 'failed') {
      failedTasks += 1;
      remaining.push({
        id: task.id,
        kind: 'blocking',
        status: task.status,
        agentName: plannedById.get(task.id)?.agent.agentName ?? task.title,
        queuedMs: Math.max(0, input.now - task.createdAt),
      });
      continue;
    }
    const planned = plannedById.get(task.id);
    const category = planned?.agentCategory ?? planned?.agent.category;
    const agentName = planned?.agent.agentName ?? task.title;
    const agentId = planned?.agent.id ?? '';
    const panes = [
      ...(liveByAgent.get(paneAgentKey(agentName)) ?? []),
      ...(liveByAgent.get(paneAgentKey(agentId)) ?? []),
    ];
    const liveBusy = panes.some(
      (pane) => pane.role !== 'orchestrator' && isLiveWorkerPane(pane),
    );
    const satOrTombstoned = panes.some(
      (pane) => pane.role !== 'orchestrator' && isSatWorkerPane(pane),
    );
    const hasLivePane = panes.some((pane) =>
      ['busy', 'idle', 'spawning', 'exited', 'hibernated', 'parou', 'tombstoned'].includes(
        pane.state ?? '',
      ),
    );
    const deliveredByHandoff = successHandoffs.some((handoff) =>
      matchHandoffToAgent(handoff, agentName, agentId),
    );
    const delivered = task.status === 'done' || deliveredByHandoff;

    if (isWriterCategory(category)) {
      writerTasks += 1;
      if (task.status === 'done') doneWriters += 1;
      if (delivered) {
        deliveredWriters += 1;
        if (task.status !== 'done') deliveredWorkerTaskIds.push(task.id);
      } else if (liveBusy) {
        activeWriterCount += 1;
      } else if (satOrTombstoned || (task.status === 'running' && !liveBusy)) {
        satWriters += 1;
      }
    } else if (deliveredByHandoff && task.status !== 'done' && !isReviewCategory(category)) {
      deliveredWorkerTaskIds.push(task.id);
    }

    if (task.status === 'done') continue;
    if (delivered && isWriterCategory(category)) continue;

    remaining.push({
      id: task.id,
      kind: classifyTaskKind({
        category,
        status: task.status,
        hasLivePane,
        liveBusy,
        satOrTombstoned,
      }),
      status: task.status,
      agentName,
      queuedMs: Math.max(0, input.now - task.createdAt),
    });
  }

  const satRemaining = remaining.filter((row) => row.kind === 'sat').length;
  // Story 01 no board vs pane "Frontend": liveness é do pane, não do nome.
  // Qualquer worker busy/spawning bloqueia Pronto; idle/parou/tombstoned conta
  // como writer que já sentou — entrega real, sem pintar o board.
  activeWriterCount = Math.max(activeWriterCount, liveWorkerPanes.length);
  const startedOrFinishedWork = input.tasks.some(
    (task) => task.status === 'done' || task.status === 'running',
  );
  const hasRealWorkerDelivery =
    successHandoffs.length > 0 ||
    deliveredWriters > 0 ||
    doneWriters > 0 ||
    satWriters > 0 ||
    satRemaining > 0 ||
    satWorkerPanes.length > 0 ||
    startedOrFinishedWork;
  const neverStartedDraft =
    !hasRealWorkerDelivery &&
    liveWorkerPanes.length === 0 &&
    satWorkerPanes.length === 0 &&
    remaining.every((row) => row.kind === 'never-started' || row.kind === 'review');
  const boardAllDone =
    input.tasks.length > 0 &&
    failedTasks === 0 &&
    input.tasks.every((task) => task.status === 'done');
  const workersDelivered =
    (successHandoffs.length > 0 && (writerTasks === 0 || deliveredWriters > 0) &&
      activeWriterCount === 0) ||
    (boardAllDone && activeWriterCount === 0);

  const hasQueuedHandoffs = hasUnsettledQueuedHandoffs(input.handoffs, {
    orchestratorSessionId: input.provenOrchestratorSessionId,
  });

  const orchestratorPanes = missionPanes.filter(
    (pane) => pane.role === 'orchestrator',
  );
  // F-660: parado numa pergunta ao operador conta como ocupado — o pane fica
  // `idle`, mas o turno do Maestro não acabou e a missão não pode fechar.
  const orchestratorBusy = orchestratorPanes.some(
    (pane) =>
      isLiveWriterPaneState(pane.state) ||
      (pane.sessionId ? isAgentAwaitingOperator(pane.sessionId) : false),
  );

  return {
    hasSuccessHandoff: successHandoffs.length > 0,
    workersDelivered,
    hasRealWorkerDelivery,
    neverStartedDraft,
    boardAllDone,
    failClosed: isFailClosedCivilianMission(input.mission),
    holdForReview: holdsReviewForLegacyOrRegression(
      input.mission,
      input.planned,
      remaining,
    ),
    activeWriterCount,
    hasQueuedHandoffs,
    idleWorkersWithoutHandoff,
    remaining,
    deliveredWorkerTaskIds,
    orchestratorBusy,
  };
}

function buildConsolidatedSummary(
  mission: Mission,
  handoffs: readonly Handoff[],
): string | null {
  try {
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

/** Lixo que o walk do workspace pinta como artefato mas não é entrega:
 * dotfiles (.DS_Store, .env — SEGREDO, .gitignore, .cdp-*) e logs. */
export function isJunkArtifactRef(rel: string): boolean {
  const base = basename(rel).toLowerCase();
  return base.startsWith('.') || base.endsWith('.log');
}

/** Normaliza caminhos para artifactRefs (sep→/, cap 256) sem lixo, máx 64. */
export function toArtifactRefs(files: readonly string[], max = 64): string[] {
  return files
    .map((file) => file.split(sep).join('/').slice(0, 256))
    .filter((file) => file.length > 0 && !isJunkArtifactRef(file))
    .slice(0, max);
}

function completionSummary(
  mission: Mission,
  files: readonly string[],
  remaining: readonly CivilianRemainderTask[],
  path: CivilianCompletionPath,
  orchestratorSummary?: string | null,
): string {
  const fileList = files.slice(0, 12).join(', ');
  const leftover = remaining
    .map((task) => `${task.agentName} (${task.kind})`)
    .slice(0, 8)
    .join(', ');
  const via =
    path === 'board'
      ? 'board selado N/N'
      : path === 'evidence'
        ? 'evidência no disco (writers pararam)'
        : 'handoff + entrega';
  const note = orchestratorSummary?.trim()
    ? `${orchestratorSummary} (Entrega civil da Via Rápida: ${files.length} arquivo(s) no disco via ${via}.)`
    : `Entrega civil da Via Rápida (${mission.title}): ${files.length} arquivo(s) no disco` +
      (fileList ? ` (${fileList})` : '') +
      ` via ${via}` +
      (leftover
        ? `. Assentos restantes não bloqueiam Pronto: ${leftover}.`
        : '. Nenhuma task residual de implementação.');
  return note.slice(0, 65_536);
}

function markTasksDone(
  stores: CivilianStores,
  taskIds: readonly string[],
  context: PeriodicTaskContext,
): string[] {
  const marked: string[] = [];
  for (const taskId of taskIds) {
    context.assertCurrent();
    try {
      const updated = stores.tasks.markLifecycleStatus(taskId, 'done');
      if (updated?.status === 'done') marked.push(taskId);
    } catch (error) {
      context.assertCurrent();
      console.warn(
        '[civilian-delivery] não avançou task selada',
        taskId,
        error instanceof Error ? error.message : error,
      );
    }
  }
  return marked;
}

/**
 * Prompt do revisor pós-recusa com o board selado e o "como confirmar" de
 * cada story VERBATIM (herança do overclick, 19/08). O voo real fechou
 * 10/10 com 4 stories sem arquivo no disco — o gate segurou, mas o revisor
 * genérico não sabia O QUE verificar. Agora ele valida story por story:
 * feito ≠ validado.
 */
export function buildCivilianReviewerPrompt(
  mission: Pick<Mission, 'title' | 'description'>,
  agent: Pick<SquadAgent, 'agentName'>,
  sealedTasks: readonly Pick<ScopedTaskRecord, 'title' | 'status'>[],
): string {
  const board =
    sealedTasks.length > 0
      ? [
          '',
          `## Board selado (${sealedTasks.length} stories) — valide UMA A UMA`,
          ...sealedTasks.map(
            (task, index) =>
              `${index + 1}. [${task.status}] ${task.title}\n` +
              `   Como confirmar: ${storyConfirmationScript(task.title)}`,
          ),
        ]
      : [];
  return [
    `## Missão: ${mission.title}`,
    `Objetivo: ${mission.description ?? ''}`,
    `Você é ${agent.agentName} (reviewer).`,
    'A implementação DECLAROU entrega — declaração não é evidência.',
    'Feito ≠ validado: siga o "como confirmar" de cada story antes de',
    'aprovar qualquer coisa.',
    ...board,
    '',
    'Ao terminar, chame nexus_handoff_submit com um veredito POR STORY',
    'usando EXATAMENTE os marcadores "[VALIDADA]" ou "[REPROVADA]" no início',
    'de cada item (ex.: "1. [VALIDADA] <story> — evidência citada" |',
    '"2. [REPROVADA] <story> — o que falta, com caminho"). O gate lê esses',
    'marcadores. Não reescreva o produto sem um defeito concreto.',
  ].join('\n');
}

async function defaultSpawnReviewers(
  scope: ProjectExecutionScope,
  mission: Mission,
  reviewers: readonly SquadAgent[],
  stores: CivilianStores,
  context: PeriodicTaskContext,
): Promise<string[]> {
  context.assertCurrent();
  const spawned: string[] = [];
  const sealedTasks = (() => {
    try {
      return stores.tasks.list(mission.id);
    } catch {
      return [] as readonly ScopedTaskRecord[];
    }
  })();
  for (const agent of reviewers) {
    await context.checkpoint();
    const prompt = buildCivilianReviewerPrompt(mission, agent, sealedTasks);
    const spawn = await context.wait(requestPaneSpawn({
      abortSignal: context.signal,
      adapterId: agent.cli,
      model: agent.model || undefined,
      effort: agent.effort || undefined,
      cwd: missionExecutionScope(scope, mission).rootRealPath,
      title: agent.agentName,
      missionId: mission.id,
      agentName: agent.agentName,
      allowedTools: agent.allowedTools ? [...agent.allowedTools] : null,
      allowedSkills: agent.allowedSkills ? [...agent.allowedSkills] : [],
      role: 'worker',
      scope,
      executionScope: missionExecutionScope(scope, mission),
      executionMode: 'same_checkout',
      initialPrompt: prompt,
    }));
    if (!spawn.ok || !spawn.paneId || !spawn.sessionId) continue;
    stores.missionPanes?.record({
      missionId: mission.id,
      paneId: spawn.paneId,
      adapterId: agent.cli,
      // Coerção obrigatória: o schema do record exige min(1) — '' derruba o
      // loop inteiro depois do pane já ter nascido (gate 0.62).
      model: agent.model || undefined,
      effort: agent.effort || undefined,
      cwd: missionExecutionScope(scope, mission).rootRealPath,
      title: agent.agentName,
      agentName: agent.agentName,
      role: 'worker',
      allowedTools: agent.allowedTools ? [...agent.allowedTools] : null,
      allowedSkills: agent.allowedSkills ? [...agent.allowedSkills] : [],
      readOnly: true,
      executionScope: missionExecutionScope(scope, mission),
    });
    spawned.push(agent.agentName);
  }
  return spawned;
}

/**
 * Etapa 1 do plano dev-sênior: missão civil não fecha sem verificação
 * independente. Onde o gate de revisão NÃO cobre (civil), o scanner
 * determinístico main-owned decide ANTES do completeVerified.
 */
async function civilianAutoReviewGate(
  scope: ProjectExecutionScope,
  stores: CivilianStores,
  mission: Mission,
  productFiles: readonly string[],
  panes: readonly LivePane[],
  provenOrchestratorSessionId: string | undefined,
  deps: CivilianDeliveryDependencies,
  context: PeriodicTaskContext,
): Promise<
  | { readonly action: 'proceed'; readonly proof?: AutomaticCompletionProof; readonly extras?: { note?: string; evidenceIds?: readonly string[] } }
  | { readonly action: 'wait'; readonly spawnedReviewers: readonly string[] }
  | { readonly action: 'block'; readonly description: string }
> {
  context.assertCurrent();
  const squad = mission.squadId
    ? ((deps.getSquad ?? getSquad)(mission.squadId) ?? null)
    : null;
  // A revisão de um candidato congelado já tem Council próprio. Missões
  // sem esse workflow usam o mesmo scanner/reparo, inclusive guided/legacy.
  if ((missionRequiresIndependentReview(mission, squad) ||
       (mission.intentContract?.lane ?? 'standard') === 'standard') &&
      (deps.readFrozenReviewContext ?? readFrozenMissionReviewContext)(scope, mission.id)) {
    return { action: 'proceed' };
  }
  if (
    mission.squadId === PET_STUDIO_SQUAD_ID ||
    squad?.id === PET_STUDIO_SQUAD_ID
  ) {
    return { action: 'proceed' };
  }

  if ((mission.intentContract?.lane ?? 'standard') === 'standard') {
    const verify = deps.runCodeCompletionGate ?? civilianCodeCompletionGate;
    if (!verify) return { action: 'block', description: 'O verificador de conclusão de código não está disponível. Restabeleça o serviço do Nexus e retome a missão; a entrega não foi marcada como verificada.' };
    const checked = await context.wait(verify({ scope, mission, productFiles,
      liveOrchestratorSessionId: provenOrchestratorSessionId, lifetime: context }));
    context.assertCurrent();
    if ('proof' in checked) return { action: 'proceed', proof: checked.proof,
      extras: { note: checked.proof.note, evidenceIds: checked.proof.codeCompletion?.evidenceIds } };
    if (checked.kind === 'waiting') return { action: 'wait', spawnedReviewers: [] };
    return { action: 'block', description: `${checked.reason}\n${checked.hint}` };
  }

  const outcome =
    (deps.runAutoReviewGate ? await context.wait(deps.runAutoReviewGate({
      mission,
      scope,
      productFiles,
      lifetime: context,
    })) : undefined) ??
    (await context.wait(enforceCivilianAutoReview({
      mission,
      scope,
      productFiles,
      liveOrchestratorSessionId: provenOrchestratorSessionId ?? null,
      lifetime: context,
    })));

  switch (outcome.kind) {
    case 'approved':
      return {
        action: 'proceed',
        proof: { status: 'verified', note: outcome.note },
        extras: { note: outcome.note, evidenceIds: [outcome.evidenceId] },
      };
    case 'repair-dispatched':
      return { action: 'wait', spawnedReviewers: [] };
    case 'blocked':
      return { action: 'block', description: outcome.description };
    case 'defer-to-roster-review': {
      // Scanner indisponível (sem git etc.): revisor do roster assume; sem
      // revisor no roster, conclui com nota honesta — nunca beco sem saída.
      const roster = mission.squadId ? squad?.agents ?? [] : [];
      const reviewers = roster.filter((agent) =>
        isReviewCategory(agent.category),
      );
      if (reviewers.length > 0 && takeReviewerRespawnBudget(mission.id)) {
        const liveNames = new Set(
          panes
            .filter(
              (pane) =>
                pane.missionId === mission.id &&
                pane.role === 'worker' &&
                ['busy', 'idle', 'spawning'].includes(pane.state ?? ''),
            )
            .map((pane) => paneAgentKey(pane.agentName)),
        );
        const toSpawn = reviewers
          .filter((agent) => !liveNames.has(paneAgentKey(agent.agentName)))
          .map((agent) => remintReviewerForSeat(agent));
        try {
          const spawned = await context.wait(Promise.resolve(deps.spawnReviewers?.(scope, mission, toSpawn) ??
            defaultSpawnReviewers(scope, mission, toSpawn, stores, context)));
          if (spawned.length > 0) {
            return { action: 'wait', spawnedReviewers: spawned };
          }
        } catch (error) {
          context.assertCurrent();
          // F-144: mesmo padrão do catch do scanner — sem log, uma falha de spawn
          // de revisor é indistinguível de "não havia revisor para spawnar".
          console.warn(
            '[civilian-delivery] spawn de revisor do roster falhou; concluindo com nota:',
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      // F-144: o motivo real viaja até a nota persistida. Antes, tanto "não há
      // repositório git" quanto "o scanner lançou" quanto "o spawn do revisor
      // falhou" produziam o mesmo texto genérico, e a prova gravada como
      // `unavailable` não permitia diagnosticar depois o que tinha acontecido.
      const reasonSuffix = outcome.reason ? ` Motivo: ${outcome.reason}` : '';
      return {
        action: 'proceed',
        proof: {
          status: 'unavailable',
          note: `Scanner indisponível; conclusão pela política de entrega existente.${reasonSuffix}`,
        },
        extras: {
          note: `Scanner determinístico indisponível (workspace sem repositório git, leitura falhou, ou o revisor do roster não pôde ser spawnado); conclusão sem varredura automática.${reasonSuffix}`,
        },
      };
    }
  }
}

function completeMission(
  scope: ProjectExecutionScope,
  stores: CivilianStores,
  mission: Mission,
  files: readonly string[],
  remaining: readonly CivilianRemainderTask[],
  engine: Pick<MissionEngine, 'completeVerified'>,
  path: CivilianCompletionPath,
  handoffs?: readonly Handoff[],
  extras?: {
    readonly note?: string;
    readonly evidenceIds?: readonly string[];
  },
  responseSummary?: string,
): boolean {
  const orchestratorNames = new Set(
    (stores.missionPanes?.list(mission.id) ?? [])
      .filter((pane) => pane.role === 'orchestrator')
      .flatMap((pane) => [paneAgentKey(pane.agentName), paneAgentKey(pane.title)])
      .filter((name) => name.length > 0),
  );
  const orchestratorSummary =
    orchestratorNames.size === 0
      ? null
      : [...(handoffs ?? [])]
          .reverse()
          .find(
            (handoff) =>
              (handoff.status === 'success' || handoff.status === 'partial') &&
              orchestratorNames.has(paneAgentKey(handoff.fromAgent)),
          )?.summary ?? null;
  const consolidatedSummary = buildConsolidatedSummary(mission, handoffs ?? []);
  const summary = responseSummary ?? completionSummary(
    mission,
    files,
    remaining,
    path,
    orchestratorSummary ?? consolidatedSummary,
  );
  const result = missionResultSchema.parse({
    outcome: 'success',
    summary,
    evidenceIds: (extras?.evidenceIds ?? []).slice(0, 64),
    artifactRefs: toArtifactRefs(files),
  });
  const learnings = (
    mission.learnings.trim()
      ? `${mission.learnings}\n\n## Pronto (entrega civil)\n${summary}`
      : `## Pronto (entrega civil)\n${summary}`
  ).slice(-65_536);
  engine.completeVerified(scope, {
    missionId: mission.id,
    expectedStatus: 'running',
    expectedIntentState: mission.intentState ?? 'legacy',
    expectedUpdatedAt: mission.updatedAt,
    expectedIntentVersion: mission.intentVersion ?? 0,
    learnings:
      extras?.note
        ? `${learnings}\n\n## Revisão automática (main-owned)\n${extras.note}`.slice(
            -65_536,
          )
        : learnings,
    result,
  });
  const completed = stores.missions.get(mission.id);
  return completed?.status === 'done' && Boolean(completed.result);
}

function emptyResult(
  action: CivilianDeliveryAction = 'wait',
): CivilianDeliveryResult {
  return {
    action,
    completed: false,
    path: null,
    spawnedReviewers: [],
    markedDoneTaskIds: [],
    productFiles: [],
  };
}

/**
 * Via Rápida: fecha Pronto quando o board selado está N/N. Arquivo único
 * na pasta avança story selada pendente (pending-with-file) antes da
 * decisão. never-started após first-wave curto → reroute, não toast 16/20.
 * DESIGN.md sozinho e rascunho nunca iniciado não pintam verde.
 * Fail-closed: sandbox / session_authority_revoked / orchestrator_spawn_forbidden
 * / blocked_technical / failed. Não inventa números do board.
 */
interface CompletionFlight {
  readonly promise: Promise<CivilianDeliveryResult>;
  wake?: { readonly deps: CivilianDeliveryDependencies; readonly authority: string };
}
const completionFlights = new Map<string, CompletionFlight>();
let completionGeneration = 1;
let completionLifetime: { generation: number; controller: AbortController } | null =
  { generation: completionGeneration, controller: new AbortController() };

/** Start only after the previous physical epoch settled. Existing startup is idempotent. */
export function startCivilianDeliveryCompletion(): void {
  if (completionLifetime) return;
  if (completionFlights.size) throw new Error('civilian completion is still draining');
  completionLifetime = { generation: ++completionGeneration, controller: new AbortController() };
}

/** Revocation is synchronous; its promise retains all physical waits until settlement. */
export function stopCivilianDeliveryCompletion(): Promise<void> {
  const previous = completionLifetime;
  completionLifetime = null;
  previous?.controller.abort(new Error('civilian completion stopped'));
  return Promise.allSettled([...completionFlights.values()].map(entry => entry.promise)).then(() => undefined);
}

/** A deferred done wake cannot migrate to another leader, goal or approval. */
function completionWakeAuthority(scope: ProjectExecutionScope, missionId: string, deps: CivilianDeliveryDependencies): string | null {
  try {
    const mission = (deps.getStores?.(scope) ?? getProjectDomainStores(scope)).missions.get(missionId);
    if (!mission || mission.status !== 'running' || hasCurrentMissionRuntimeCloseVerdict(mission) ||
      !hasCurrentCompletionRequest(scope, mission)) return null;
    const leader = deps.resolveMissionLeader?.(scope, missionId) ??
      (deps.resolveMissionLeader ? null : getMissionLeadership().resolveMissionLeader(scope, missionId));
    if (!leader?.proven || leader.sessionId !== mission.orchestratorSessionId) return null;
    return JSON.stringify([mission.intentVersion ?? 0, leader.sessionId,
      mission.intentContract ? missionIntentAuthoritySnapshot(mission.intentContract) : null]);
  } catch { return null; }
}

export function maybeCompleteFastLaneOnDelivery(
  scope: ProjectExecutionScope,
  missionId: string | undefined,
  deps: CivilianDeliveryDependencies = {},
): Promise<CivilianDeliveryResult> {
  const owner = completionLifetime;
  if (!missionId || !owner) return Promise.resolve({ ...emptyResult(), reason: 'completion-stopped' });
  const key = missionLifecycleKey(scope, missionId);
  const active = completionFlights.get(key);
  if (active) {
    const authority = completionWakeAuthority(scope, missionId, deps);
    if (authority !== null) active.wake = { deps, authority };
    return Promise.resolve({ ...emptyResult(), reason: 'review-in-progress' });
  }
  let resolve!: (result: CivilianDeliveryResult) => void, reject!: (error: unknown) => void;
  const flight = new Promise<CivilianDeliveryResult>((yes, no) => { resolve = yes; reject = no; });
  const entry: CompletionFlight = { promise: flight };
  completionFlights.set(key, entry);
  let result = emptyResult();
  const work = runPeriodicTask(`civilian-delivery:${owner.generation}:${key}`, async context => {
    result = await reconcileCivilianCompletionAttempt(scope, missionId, deps, context);
  }, { signal: owner.controller.signal });
  const settled = () => {
    if (completionFlights.get(key) !== entry) return;
    completionFlights.delete(key);
    const wake = entry.wake;
    // F-1130: one fresh attempt for the idle/done wake that arrived during IO.
    // Install its physical flight before resolving this one, so Stop owns it.
    // Only external wakes schedule another attempt; there is no polling loop.
    if (wake && completionLifetime === owner && !owner.controller.signal.aborted &&
      completionWakeAuthority(scope, missionId, wake.deps) === wake.authority) {
      void maybeCompleteFastLaneOnDelivery(scope, missionId, wake.deps).catch(() => {
        console.warn('[civilian-delivery] deferred completion wake failed');
      });
    }
  };
  void work.then(() => { settled(); resolve(result); }, error => {
    settled();
    if (owner.controller.signal.aborted) resolve({ ...emptyResult(), reason: 'completion-stopped' });
    else reject(error);
  });
  return flight;
}

/**
 * Fingerprint de reconciliação (detecta "algo mudou" entre tentativas), não
 * decisão de autoridade — `orchestratorSessionId` cru é intencional aqui:
 * a mudança da própria coluna A também deve invalidar o fingerprint.
 */
function completionState(stores: CivilianStores, missionId: string, panes: readonly LivePane[]): string {
  const current = stores.missions.get(missionId);
  return JSON.stringify({
    mission: current && [
      current.status, current.intentState, current.intentVersion,
      current.updatedAt, current.intentContract, current.orchestratorSessionId,
    ],
    tasks: stores.tasks.list(missionId)
      .map((task) => [task.id, task.status, task.updatedAt]),
    handoffs: stores.handoffs.list({ missionId, includeDelivered: true })
      .map((handoff) => [handoff.id, handoff.status, handoff.deliveryState, handoff.createdAt]),
    panes: panes.filter((pane) => pane.missionId === missionId)
      .map((pane) => [pane.paneId, pane.sessionId, pane.agentName, pane.role, pane.state]),
  });
}

async function captureCompletionCandidate(scope: ProjectExecutionScope, deps: CivilianDeliveryDependencies, baseSha?: string) {
  try {
    return await (deps.captureCandidate?.(scope) ?? captureWorkingTreeCandidate({ scope, baseSha }));
  } catch {
    // Optional race detector: absence is reported, never a new prerequisite.
    return null;
  }
}

async function reconcileCivilianCompletionAttempt(
  scope: ProjectExecutionScope,
  missionId: string | undefined,
  deps: CivilianDeliveryDependencies,
  context: PeriodicTaskContext,
): Promise<CivilianDeliveryResult> {
  context.assertCurrent();
  if (!missionId) return emptyResult();
  const stores = deps.getStores?.(scope) ?? getProjectDomainStores(scope);
  if (!storesReady(stores)) return emptyResult();

  const mission = stores.missions.get(missionId);
  if (!mission) return emptyResult();
  if (mission.status === 'failed' || mission.status === 'blocked') {
    return emptyResult('refuse-fail-closed');
  }
  if (mission.intentState === 'blocked_technical') {
    return emptyResult('refuse-fail-closed');
  }
  if (mission.status !== 'running') return emptyResult();

  let handoffs: readonly Handoff[] = [];
  try {
    handoffs = stores.handoffs.list({ missionId, includeDelivered: true });
  } catch {
    return emptyResult();
  }
  if (isFailClosedCivilianMission(mission)) {
    return emptyResult('refuse-fail-closed');
  }

  const successHandoffs = handoffs.filter(
    (handoff) => handoff.status === 'success' || handoff.status === 'partial',
  );
  if (
    holdsAwaitingOperatorAdjustment(mission.description ?? '', successHandoffs)
  ) {
    return emptyResult('wait');
  }

  const now = deps.now?.() ?? Date.now();
  const panes =
    deps.listPanes?.() ??
    (typeof listPaneSnapshots === 'function' ? listPaneSnapshots() : []);
  const teamQuestion = inspectTeamQuestionCompletion({
    mission,
    squad: isTeamQuestionMission(mission) && mission.squadId
      ? (deps.getSquad ?? getSquad)(mission.squadId) as Squad | null : null,
    panes: stores.missionPanes?.list?.(missionId) ?? [],
    runtimePanes: panes,
    handoffs,
    observerPaneSessions: deps.listObserverPaneSessions?.(missionId) ??
      loadObserverPaneSessions(scope, missionId),
  });
  if (!teamQuestion.ready) {
    return { ...emptyResult('wait'), reason: teamQuestion.reason, missingTargets: teamQuestion.missingTargets };
  }
  let planned: ReturnType<CivilianStores['tasks']['listPlannedTasks']> = [];
  try {
    planned = stores.tasks.listPlannedTasks(
      missionId,
      mission.intentVersion ?? 0,
    );
  } catch {
    planned = [];
  }

  const rawFiles = teamQuestion.applicable ? [] : [
    ...new Set(
      await context.wait(Promise.resolve(deps.listProductFiles?.(
        missionExecutionScope(scope, mission).rootRealPath,
        handoffs,
        mission.description ?? '',
        mission.intentContract?.workspaceBinding?.spaceId ? undefined : mission.createdAt,
      ) ??
        listDeliveredProductFiles(
          missionExecutionScope(scope, mission).rootRealPath,
          handoffs,
          mission.description ?? '',
          mission.intentContract?.workspaceBinding?.spaceId ? undefined : mission.createdAt,
          missionExecutionBaseSha(scope, mission),
        ))),
    ),
  ];
  const evidence = inspectDeliveryEvidence(rawFiles, mission.description ?? '');
  const productFiles = [...evidence.productFiles];

  const storyStores = {
    ...stores,
    tasks: {
      ...stores.tasks,
      advanceSealedTaskStatus:
        stores.tasks.advanceSealedTaskStatus?.bind(stores.tasks) ??
        ((taskId: string, status: 'running' | 'done' | 'failed') =>
          stores.tasks.markLifecycleStatus(taskId, status)),
    },
  };
  context.assertCurrent();
  let uniqueAdvanced: readonly string[] = [];
  try {
    uniqueAdvanced = advanceSealedTasksFromFilesOnDisk(
      storyStores as ProjectDomainStoreSuite,
      {
        missionId,
        filesModified: productFiles,
        uniqueMatchesOnly: true,
      },
    );
  } catch (error) {
    context.assertCurrent();
    console.warn(
      '[civilian-delivery] pending-with-file falhou (fail-closed):',
      error instanceof Error ? error.message : error,
    );
  }

  let leader: MissionLeader | null;
  // Engine indisponível (registry não inicializado — fixtures, boot parcial):
  // leitor sem efeito degrada à ligação durável da missão, como antes da onda 1.
  let engineUnavailable = false;
  try {
    leader = deps.resolveMissionLeader
      ? deps.resolveMissionLeader(scope, missionId)
      : getMissionLeadership().resolveMissionLeader(scope, missionId);
  } catch (error) {
    if (error instanceof MissionLeadershipError && error.code === 'unavailable') {
      engineUnavailable = true;
      leader = null;
    } else if (error instanceof MissionLeadershipError) {
      return { ...emptyResult('refuse-fail-closed'), reason: `leadership-${error.code}` };
    } else {
      throw error;
    }
  }
  const provenOrchestratorSessionId = engineUnavailable
    ? (mission.orchestratorSessionId?.trim() || undefined)
    : leader?.proven ? leader.sessionId : undefined;

  const tasks = stores.tasks.list(missionId);
  const inspection = inspectCivilianDelivery({
    mission,
    tasks,
    planned,
    handoffs,
    panes,
    now,
    provenOrchestratorSessionId,
  });

  const markedDoneTaskIds = [
    ...uniqueAdvanced,
    ...markTasksDone(stores, inspection.deliveredWorkerTaskIds, context),
  ];

  if (awaitsOperatorTabCompletionRequest(scope, mission)) {
    return { ...emptyResult('wait'), markedDoneTaskIds, productFiles, reason: 'awaiting-orchestrator-completion-request' };
  }

  const decisionInput: CivilianDeliveryDecisionInput = {
    failClosed: inspection.failClosed,
    boardAllDone: inspection.boardAllDone,
    hasExpectedDelivery: evidence.expected,
    designOnly: evidence.designOnly,
    neverStartedDraft: inspection.neverStartedDraft,
    hasSuccessHandoff: inspection.hasSuccessHandoff,
    hasRealWorkerDelivery: inspection.hasRealWorkerDelivery,
    hasQueuedHandoffs: inspection.hasQueuedHandoffs,
    idleWorkersWithoutHandoff: inspection.idleWorkersWithoutHandoff,
    holdForReview: inspection.holdForReview,
    productFileCount: productFiles.length,
    activeWriterCount: inspection.activeWriterCount,
    workersDelivered: inspection.workersDelivered,
    orchestratorBusy: inspection.orchestratorBusy,
    remainingKinds: inspection.remaining.map((task) => task.kind),
    awaitingOperatorAdjustment: holdsAwaitingOperatorAdjustment(
      mission.description ?? '',
      successHandoffs,
    ),
    oldestReviewQueuedMs: inspection.remaining
      .filter((task) => task.kind === 'review')
      .reduce<number | null>((oldest, task) => {
        if (oldest === null || task.queuedMs > oldest) return task.queuedMs;
        return oldest;
      }, null),
  };
  const initialAction = decideCivilianDeliveryAction(decisionInput);
  const shouldCaptureCandidate = !teamQuestion.applicable && mission.intentContract?.lane !== 'consult' && (
    initialAction === 'complete' || initialAction === 'spawn-review' ||
    (initialAction === 'refuse-empty' && inspection.hasSuccessHandoff)
  );
  const stateBeforeReview = completionState(stores, missionId, panes);
  const reviewBaseSha = shouldCaptureCandidate && !deps.captureCandidate
    ? missionExecutionBaseSha(scope, mission) ?? await context.wait(resolveAutoReviewBaseSha(new AsyncProcessGitRunner(), missionExecutionScope(scope, mission).rootRealPath, mission.createdAt)) ?? undefined
    : undefined;
  const candidateBefore = shouldCaptureCandidate
    ? await context.wait(captureCompletionCandidate(missionExecutionScope(scope, mission), deps, reviewBaseSha)) : null;
  const deletedCount = candidateBefore?.complete ? candidateBefore.deletedPaths?.length ?? 0 : 0;
  const action = deletedCount > 0
    ? decideCivilianDeliveryAction({ ...decisionInput, hasExpectedDelivery: true, productFileCount: productFiles.length + deletedCount })
    : initialAction;

  const path: CivilianCompletionPath =
    action !== 'complete'
      ? null
      : inspection.boardAllDone
        ? 'board'
        : evidence.expected && inspection.hasRealWorkerDelivery
          ? 'evidence'
          : 'handoff';

  if (action === 'refuse-empty' || action === 'wait' || action === 'refuse-fail-closed') {
    return {
      action,
      completed: false,
      path: null,
      spawnedReviewers: [],
      markedDoneTaskIds,
      productFiles,
    };
  }

  if (action === 'reroute') {
    const pendingTitles = tasks
      .filter((task) => task.status === 'pending' || task.status === 'running')
      .map((task) => task.title);
    try {
      context.assertCurrent();
      await context.wait(Promise.resolve(deps.rerouteUnassigned?.(pendingTitles)));
    } catch (error) {
      context.assertCurrent();
      console.warn(
        '[civilian-delivery] reroute de stories sem assento falhou:',
        error instanceof Error ? error.message : error,
      );
    }
    return {
      action: 'reroute',
      completed: false,
      path: null,
      spawnedReviewers: [],
      markedDoneTaskIds,
      productFiles,
    };
  }

  if (action === 'spawn-review') {
    const roster = mission.squadId
      ? ((deps.getSquad ?? getSquad)(mission.squadId)?.agents ?? [])
      : [];
    const pendingReviewNames = new Set(
      inspection.remaining
        .filter((task) => task.kind === 'review')
        .map((task) => paneAgentKey(task.agentName)),
    );
    const liveReview = new Set(
      panes
        .filter(
          (pane) =>
            pane.missionId === mission.id &&
            pane.role === 'worker' &&
            ['busy', 'idle', 'spawning'].includes(pane.state ?? ''),
        )
        .map((pane) => paneAgentKey(pane.agentName)),
    );
    const toSpawn = roster.filter(
      (agent) =>
        isReviewCategory(agent.category) &&
        pendingReviewNames.has(paneAgentKey(agent.agentName)) &&
        !liveReview.has(paneAgentKey(agent.agentName)),
    );
    let spawnedReviewers: readonly string[] = [];
    try {
      context.assertCurrent();
      spawnedReviewers = await context.wait(Promise.resolve(deps.spawnReviewers?.(scope, mission, toSpawn) ??
        defaultSpawnReviewers(scope, mission, toSpawn, stores, context)));
    } catch (error) {
      context.assertCurrent();
      console.warn(
        '[civilian-delivery] spawn de review falhou; missão civil segue:',
        error instanceof Error ? error.message : error,
      );
    }
    if (spawnedReviewers.length > 0) {
      return {
        action: 'spawn-review',
        completed: false,
        path: null,
        spawnedReviewers,
        markedDoneTaskIds,
        productFiles,
      };
    }
    if (inspection.holdForReview) {
      return {
        action: 'wait',
        completed: false,
        path: null,
        spawnedReviewers: [],
        markedDoneTaskIds,
        productFiles,
      };
    }
  }

  const autoReview = await civilianAutoReviewGate(
    scope,
    stores,
    mission,
    productFiles,
    panes,
    provenOrchestratorSessionId,
    deps,
    context,
  );
  if (autoReview.action === 'wait') {
    return {
      action: inspection.holdForReview ? 'spawn-review' : 'wait',
      completed: false,
      path: null,
      spawnedReviewers: autoReview.spawnedReviewers,
      markedDoneTaskIds,
      productFiles,
    };
  }
  const candidateAfter = shouldCaptureCandidate
    ? await context.wait(captureCompletionCandidate(missionExecutionScope(scope, mission), deps, reviewBaseSha)) : null;
  const currentPanes = deps.listPanes?.() ??
    (typeof listPaneSnapshots === 'function' ? listPaneSnapshots() : []);
  if (
    completionState(stores, missionId, currentPanes) !== stateBeforeReview ||
    (candidateBefore && candidateAfter && candidateBefore.fingerprint !== candidateAfter.fingerprint)
  ) {
    return { ...emptyResult(), productFiles, markedDoneTaskIds, reason: 'review-candidate-changed' };
  }
  if (autoReview.action === 'block') {
    const engine = deps.missionEngine ?? missionEngineForScope(scope);
    try {
      engine.blockUser(scope, {
        missionId: mission.id,
        expectedStatus: 'running',
        expectedIntentState: mission.intentState ?? 'legacy',
        expectedUpdatedAt: mission.updatedAt,
        expectedIntentVersion: mission.intentVersion ?? 0,
        description: autoReview.description,
      });
    } catch (error) {
      console.warn(
        '[civilian-delivery] bloqueio por revisão automática falhou:',
        error instanceof Error ? error.message : error,
      );
    }
    return {
      action: 'refuse-fail-closed',
      completed: false,
      path: null,
      spawnedReviewers: [],
      markedDoneTaskIds,
      productFiles,
    };
  }

  const engine = deps.missionEngine ?? missionEngineForScope(scope);
  let completed = false;
  let refusalSpawned: readonly string[] = [];
  try {
    context.assertCurrent();
    const limitation = shouldCaptureCandidate && (!candidateBefore?.complete || !candidateAfter?.complete)
      ? 'A checagem de mudanças durante a revisão foi parcial ou indisponível.' : '';
    const extras = {
      ...autoReview.extras,
      note: [autoReview.extras?.note, limitation].filter(Boolean).join('\n'),
    };
    const complete = () => {
      // ORC-02: a prova de conclusão só assenta com os efeitos assentados
      // (checkpoint.capture / handoff.deliver). Estado durável, não memória.
      assertCompletionEffectsSettled(
        requireProjectDomainStoreRegistry().runtimeManager(),
        scope,
        mission.id,
        { excludeSessionId: provenOrchestratorSessionId },
      );
      return completeMission(
        scope,
        stores,
        mission,
        productFiles,
        inspection.remaining,
        engine,
        path ?? 'evidence',
        teamQuestion.applicable ? teamQuestion.responses.map(({ handoff }) => handoff) : handoffs,
        extras,
        teamQuestion.applicable ? teamQuestionResponseSummary(teamQuestion) : undefined,
      );
    };
    completed = autoReview.proof
      ? withAutomaticCompletionProof(scope, mission, {
          ...autoReview.proof,
          ...(!autoReview.proof.codeCompletion && candidateBefore?.complete && candidateAfter?.complete
            ? { candidateFingerprint: candidateAfter.fingerprint, deletedArtifactPaths: candidateAfter.deletedPaths } : {}),
        }, complete)
      : complete();
  } catch (error) {
    context.assertCurrent();
    const message = error instanceof Error ? error.message : String(error);
    if (!isCivilianReviewRefusal(message)) {
      if (shouldLogCivilianRefusal(mission.id, message)) {
        console.warn(
          `[civilian-delivery] completeVerified recusou (mission=${mission.id}):`,
          message,
        );
      }
    } else if (noteCivilianReviewRefusal(mission.id)) {
      // Primeira recusa da janela: em vez de re-tentar em loop, abre o
      // revisor do roster que ainda não tem pane vivo — é ele quem destrava.
      console.warn(
        '[civilian-delivery] review pendente — abrindo revisor do roster:',
        message,
      );
      const roster = mission.squadId
        ? ((deps.getSquad ?? getSquad)(mission.squadId)?.agents ?? [])
        : [];
      const liveNames = new Set(
        panes
          .filter(
            (pane) =>
              pane.missionId === mission.id &&
              pane.role === 'worker' &&
              ['busy', 'idle', 'spawning'].includes(pane.state ?? ''),
          )
          .map((pane) => paneAgentKey(pane.agentName)),
      );
      const toSpawn = roster
        .filter(
          (agent) =>
            isReviewCategory(agent.category) &&
            !liveNames.has(paneAgentKey(agent.agentName)),
        )
        .map((agent) => remintReviewerForSeat(agent));
      if (toSpawn.length > 0 && !takeReviewerRespawnBudget(mission.id)) {
        if (
          shouldLogCivilianRefusal(mission.id, 'reviewer_respawn_exhausted')
        ) {
          console.error(
            `[civilian-delivery] disjuntor: revisor do roster morreu no spawn ` +
              `repetidas vezes (mission=${mission.id}); parei de reabrir. ` +
              `Troque o revisor do squad para uma CLI saudável ou conclua ` +
              `pela via de evidência.`,
          );
        }
        return {
          action,
          completed: false,
          path: null,
          spawnedReviewers: [],
          markedDoneTaskIds,
          productFiles,
        };
      }
      try {
        context.assertCurrent();
        refusalSpawned = await context.wait(Promise.resolve(deps.spawnReviewers?.(scope, mission, toSpawn) ??
          defaultSpawnReviewers(scope, mission, toSpawn, stores, context)));
        if (refusalSpawned.length > 0) {
          console.info(
            `[civilian-delivery] revisor aberto pós-recusa: ${refusalSpawned.join(', ')}`,
          );
        }
      } catch (spawnError) {
        context.assertCurrent();
        console.warn(
          '[civilian-delivery] spawn de revisor pós-recusa falhou:',
          spawnError instanceof Error ? spawnError.message : spawnError,
        );
      }
    }
  }
  if (completed) clearCivilianReviewRefusal(mission.id);

  return {
    action: completed ? 'complete' : action,
    completed,
    path: completed ? (path ?? 'evidence') : null,
    spawnedReviewers: refusalSpawned,
    markedDoneTaskIds,
    productFiles,
  };
}

/** @deprecated use maybeCompleteFastLaneOnDelivery */
export const reconcileCivilianDelivery = maybeCompleteFastLaneOnDelivery;
