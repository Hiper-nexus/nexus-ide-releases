import { execFile } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { AgentCategory, Handoff, Mission, SquadAgent } from '../../shared/orch-types';
import { missionResultSchema } from '../../shared/mission-engine-contract';
import type { ProjectExecutionScope } from '../../shared/types';
import { listPaneSnapshots, requestPaneSpawn } from './pane-registry';
import {
  getProjectDomainStores,
  type ProjectDomainStoreSuite,
} from './project-domain-store-registry';
import { missionEngineForScope } from './mission-engine-registry';
import { getSquad } from './squad-store';
import { classifySeatAuth } from '../adapters/seat-auth-readiness';
import { detectSubscriptionAuthReadiness } from '../adapters/subscription-auth';
import {
  hasRuntimeKey,
  providerAuthStrategy,
} from '../persistence/provider-config-store';
import { firstSeatableCli } from '../../shared/seat-chains';
import type { MissionEngine } from './mission-engine';
import {
  advanceSealedTasksFromFilesOnDisk,
  storyConfirmationScript,
} from './mission-story-plan';
import type { ScopedTaskRecord } from './task-store';

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

const FAIL_CLOSED_TOKEN =
  /session_authority_revoked|orchestrator_spawn_forbidden|sandbox_denied|sandbox_forbidden|process sandbox recusou/iu;

const REVIEW_HOLD_TASK =
  /regression|quality-gate|independent-review|guided-regression|guided-quality/iu;

const KICKOFF_FILE =
  /(?:^|[^\w./-])((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z][A-Za-z0-9]{0,7})/gu;

const MAX_WALK_FILES = 400;
const MAX_WALK_VISITS = 2_000;
const MAX_WALK_DEPTH = 6;

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
  readonly remainingKinds: readonly CivilianRemainderKind[];
  readonly oldestReviewQueuedMs: number | null;
}

export interface CivilianDeliveryResult {
  readonly action: CivilianDeliveryAction;
  readonly completed: boolean;
  readonly path: CivilianCompletionPath;
  readonly spawnedReviewers: readonly string[];
  readonly markedDoneTaskIds: readonly string[];
  readonly productFiles: readonly string[];
}

export type CivilianRemainderTask = {
  readonly id: string;
  readonly kind: CivilianRemainderKind;
  readonly status: string;
  readonly agentName: string;
  readonly queuedMs: number;
};

type LivePane = {
  readonly missionId?: string | null;
  readonly agentName?: string | null;
  readonly role?: 'orchestrator' | 'worker' | string;
  readonly state?: string | null;
};

export interface CivilianDeliveryDependencies {
  readonly getStores?: (scope: ProjectExecutionScope) => CivilianStores;
  readonly listPanes?: () => readonly LivePane[];
  readonly listProductFiles?: (
    root: string,
    handoffs: readonly Handoff[],
    kickoffText?: string,
  ) => readonly string[] | Promise<readonly string[]>;
  readonly now?: () => number;
  readonly spawnReviewers?: (
    scope: ProjectExecutionScope,
    mission: Mission,
    reviewers: readonly SquadAgent[],
  ) => Promise<readonly string[]>;
  readonly missionEngine?: Pick<MissionEngine, 'completeVerified'>;
  readonly getSquad?: (squadId: string) => { agents: readonly SquadAgent[] } | null;
  /** First-wave curto: senta stories seladas ainda pending/never-started. */
  readonly rerouteUnassigned?: (
    pendingTitles: readonly string[],
  ) => Promise<number | void> | number | void;
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
  readonly missionPanes?: Pick<ProjectDomainStoreSuite['missionPanes'], 'record'>;
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
const REVIEW_REFUSAL_COOLDOWN_MS = 1_000;
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
  mission: Pick<Mission, 'status' | 'intentState' | 'description' | 'learnings'>,
  handoffs: readonly Pick<Handoff, 'summary' | 'status'>[] = [],
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
  if (input.boardAllDone) return 'complete';
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

async function listGitProductFiles(root: string): Promise<string[]> {
  if (!existsSync(join(root, '.git'))) return [];
  const found = new Set<string>();
  for (const args of [
    ['diff', '--name-only', '--diff-filter=ACMR'],
    ['diff', '--cached', '--name-only', '--diff-filter=ACMR'],
    ['ls-files', '--others', '--exclude-standard'],
  ] as const) {
    try {
      const { stdout } = await execFileAsync('git', [...args], {
        cwd: root,
        timeout: 4_000,
      });
      for (const line of stdout.split('\n')) {
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

function walkWorkspaceFiles(root: string): string[] {
  if (!existsSync(root)) return [];
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
      if (entry.isFile() && isNonEmptyFile(absolute)) found.push(rel);
      if (found.length >= MAX_WALK_FILES) break;
    }
  }
  return found;
}

export async function listDeliveredProductFiles(
  root: string,
  handoffs: readonly Handoff[],
  kickoffText = '',
): Promise<string[]> {
  const found = new Set<string>([
    ...collectArtifactFiles(root, handoffs),
    ...(await listGitProductFiles(root)),
    ...walkWorkspaceFiles(root),
  ]);
  for (const requested of extractKickoffRequestedFiles(kickoffText)) {
    const absolute = resolveWorkspaceFile(root, requested);
    if (absolute && isNonEmptyFile(absolute)) found.add(relative(root, absolute));
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

function matchHandoffToAgent(
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
}): {
  readonly hasSuccessHandoff: boolean;
  readonly workersDelivered: boolean;
  readonly hasRealWorkerDelivery: boolean;
  readonly neverStartedDraft: boolean;
  readonly boardAllDone: boolean;
  readonly failClosed: boolean;
  readonly holdForReview: boolean;
  readonly activeWriterCount: number;
  readonly remaining: CivilianRemainderTask[];
  readonly deliveredWorkerTaskIds: string[];
} {
  const plannedById = new Map(input.planned.map((row) => [row.taskId, row]));
  const successHandoffs = input.handoffs.filter((handoff) => handoff.status === 'success');
  const missionPanes = input.panes.filter((pane) => pane.missionId === input.mission.id);
  const workerPanes = missionPanes.filter((pane) => pane.role !== 'orchestrator');
  const liveWorkerPanes = workerPanes.filter((pane) =>
    isLiveWriterPaneState(pane.state),
  );
  const satWorkerPanes = workerPanes.filter((pane) =>
    isSatOrTombstonedPaneState(pane.state),
  );
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
      (pane) => pane.role !== 'orchestrator' && isLiveWriterPaneState(pane.state),
    );
    const satOrTombstoned = panes.some(
      (pane) =>
        pane.role !== 'orchestrator' && isSatOrTombstonedPaneState(pane.state),
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

  return {
    hasSuccessHandoff: successHandoffs.length > 0,
    workersDelivered,
    hasRealWorkerDelivery,
    neverStartedDraft,
    boardAllDone,
    failClosed: isFailClosedCivilianMission(input.mission, input.handoffs),
    holdForReview: holdsReviewForLegacyOrRegression(
      input.mission,
      input.planned,
      remaining,
    ),
    activeWriterCount,
    remaining,
    deliveredWorkerTaskIds,
  };
}

function completionSummary(
  mission: Mission,
  files: readonly string[],
  remaining: readonly CivilianRemainderTask[],
  path: CivilianCompletionPath,
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
  const note =
    `Entrega civil da Via Rápida (${mission.title}): ${files.length} arquivo(s) no disco` +
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
): string[] {
  const marked: string[] = [];
  for (const taskId of taskIds) {
    try {
      const updated = stores.tasks.markLifecycleStatus(taskId, 'done');
      if (updated?.status === 'done') marked.push(taskId);
    } catch (error) {
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
): Promise<string[]> {
  const spawned: string[] = [];
  const sealedTasks = (() => {
    try {
      return stores.tasks.list(mission.id);
    } catch {
      return [] as readonly ScopedTaskRecord[];
    }
  })();
  for (const agent of reviewers) {
    const prompt = buildCivilianReviewerPrompt(mission, agent, sealedTasks);
    const spawn = await requestPaneSpawn({
      adapterId: agent.cli,
      model: agent.model || undefined,
      effort: agent.effort || undefined,
      cwd: scope.rootRealPath,
      title: agent.agentName,
      missionId: mission.id,
      agentName: agent.agentName,
      allowedTools: agent.allowedTools ? [...agent.allowedTools] : null,
      allowedSkills: agent.allowedSkills ? [...agent.allowedSkills] : [],
      role: 'worker',
      scope,
      executionScope: scope,
      executionMode: 'same_checkout',
      initialPrompt: prompt,
    });
    if (!spawn.ok || !spawn.paneId || !spawn.sessionId) continue;
    stores.missionPanes?.record({
      missionId: mission.id,
      paneId: spawn.paneId,
      adapterId: agent.cli,
      // Coerção obrigatória: o schema do record exige min(1) — '' derruba o
      // loop inteiro depois do pane já ter nascido (gate 0.62).
      model: agent.model || undefined,
      effort: agent.effort || undefined,
      cwd: scope.rootRealPath,
      title: agent.agentName,
      agentName: agent.agentName,
      role: 'worker',
      allowedTools: agent.allowedTools ? [...agent.allowedTools] : null,
      allowedSkills: agent.allowedSkills ? [...agent.allowedSkills] : [],
      readOnly: true,
      executionScope: scope,
    });
    spawned.push(agent.agentName);
  }
  return spawned;
}

function completeMission(
  scope: ProjectExecutionScope,
  stores: CivilianStores,
  mission: Mission,
  files: readonly string[],
  remaining: readonly CivilianRemainderTask[],
  engine: Pick<MissionEngine, 'completeVerified'>,
  path: CivilianCompletionPath,
): boolean {
  const summary = completionSummary(mission, files, remaining, path);
  const result = missionResultSchema.parse({
    outcome: 'success',
    summary,
    evidenceIds: [],
    artifactRefs: files
      .map((file) => file.split(sep).join('/').slice(0, 256))
      .filter((file) => file.length > 0)
      .slice(0, 64),
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
    learnings,
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
export async function maybeCompleteFastLaneOnDelivery(
  scope: ProjectExecutionScope,
  missionId: string | undefined,
  deps: CivilianDeliveryDependencies = {},
): Promise<CivilianDeliveryResult> {
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

  const now = deps.now?.() ?? Date.now();
  const panes =
    deps.listPanes?.() ??
    (typeof listPaneSnapshots === 'function' ? listPaneSnapshots() : []);
  let planned: ReturnType<CivilianStores['tasks']['listPlannedTasks']> = [];
  try {
    planned = stores.tasks.listPlannedTasks(
      missionId,
      mission.intentVersion ?? 0,
    );
  } catch {
    planned = [];
  }

  const rawFiles = [
    ...new Set(
      await (deps.listProductFiles?.(
        scope.rootRealPath,
        handoffs,
        mission.description ?? '',
      ) ??
        listDeliveredProductFiles(
          scope.rootRealPath,
          handoffs,
          mission.description ?? '',
        )),
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
    console.warn(
      '[civilian-delivery] pending-with-file falhou (fail-closed):',
      error instanceof Error ? error.message : error,
    );
  }

  const tasks = stores.tasks.list(missionId);
  const inspection = inspectCivilianDelivery({
    mission,
    tasks,
    planned,
    handoffs,
    panes,
    now,
  });

  const markedDoneTaskIds = [
    ...uniqueAdvanced,
    ...markTasksDone(stores, inspection.deliveredWorkerTaskIds),
  ];

  const action = decideCivilianDeliveryAction({
    failClosed: inspection.failClosed,
    boardAllDone: inspection.boardAllDone,
    hasExpectedDelivery: evidence.expected,
    designOnly: evidence.designOnly,
    neverStartedDraft: inspection.neverStartedDraft,
    hasSuccessHandoff: inspection.hasSuccessHandoff,
    hasRealWorkerDelivery: inspection.hasRealWorkerDelivery,
    holdForReview: inspection.holdForReview,
    productFileCount: productFiles.length,
    activeWriterCount: inspection.activeWriterCount,
    workersDelivered: inspection.workersDelivered,
    remainingKinds: inspection.remaining.map((task) => task.kind),
    oldestReviewQueuedMs: inspection.remaining
      .filter((task) => task.kind === 'review')
      .reduce<number | null>((oldest, task) => {
        if (oldest === null || task.queuedMs > oldest) return task.queuedMs;
        return oldest;
      }, null),
  });

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
      await deps.rerouteUnassigned?.(pendingTitles);
    } catch (error) {
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
      spawnedReviewers = await (deps.spawnReviewers?.(scope, mission, toSpawn) ??
        defaultSpawnReviewers(scope, mission, toSpawn, stores));
    } catch (error) {
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

  const engine = deps.missionEngine ?? missionEngineForScope(scope);
  let completed = false;
  let refusalSpawned: readonly string[] = [];
  try {
    completed = completeMission(
      scope,
      stores,
      mission,
      productFiles,
      inspection.remaining,
      engine,
      path ?? 'evidence',
    );
  } catch (error) {
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
      try {
        refusalSpawned = await (deps.spawnReviewers?.(scope, mission, toSpawn) ??
          defaultSpawnReviewers(scope, mission, toSpawn, stores));
        if (refusalSpawned.length > 0) {
          console.info(
            `[civilian-delivery] revisor aberto pós-recusa: ${refusalSpawned.join(', ')}`,
          );
        }
      } catch (spawnError) {
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
