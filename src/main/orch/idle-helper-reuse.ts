import { decisionResultUsage } from '../decision-models/decision-usage';
/**
 * Reuso de helper ocioso (lote 0.76.135, superfície Jev `helperReuse`).
 * Em vez de pagar spawn + contexto novo, o nexus_pane_spawn pode devolver a
 * tarefa a um pane VIVO e parado do mesmo dono: filho da mão do operador sem
 * missão, ou worker da missão da aba. O filtro mecânico roda local (mesma
 * CLI, mesmo modo leitura/escrita, parentesco, ≥20s parado, sem fechamento
 * armado); o Jev só decide QUAL candidato tem contexto relacionado — ou
 * `none`. Fail-open em tudo: superfície desligada, sem credencial, erro,
 * timeout ou `none` devolvem null e o spawn normal segue.
 */
import type { PaneSnapshot } from '../../shared/orch-types';
import type { ProjectExecutionScope } from '../../shared/types';
import type { PaneRuntimeAuthority } from './pane-registry';
import {
  getPaneRuntimeAuthorityBySession,
  listPaneSnapshots,
} from './pane-registry';
import { isSessionStdinWritable } from '../pty/pty-manager';
import {
  getAgentSemanticStatusBySession,
  type AgentSemanticStatusEntry,
} from './agent-status';
import { armedAutoClosePaneId, reuseHoldRemainingMs } from './pane-close-scopes';
import { requireWorktreeRuntimeRegistry } from '../runtime/worktree-runtime-registry';
import { getProjectDomainStores } from './project-domain-store-registry';
import { readSessionOutput, stripAnsi } from './pane-session-output';
import {
  capText,
  judge,
  type JevQuestion,
} from '../jev/jev-client';
import { isJevSurfaceEnabled } from '../jev/jev-autopilot';
import { hasDecisionCredential } from '../decision-models/decision-availability';
import {
  jevAnswerConfidences,
  jevAnswerProbabilities,
  recordJevDecision,
  recordJevSkip,
} from '../jev/jev-decision-log';

export const HELPER_REUSE_MIN_IDLE_MS = 20_000;
export const HELPER_REUSE_MAX_CANDIDATES = 5;
export const HELPER_REUSE_MIN_CONFIDENCE = 0.7;
const HELPER_REUSE_TIMEOUT_MS = 4_000;
/**
 * F-197: helper whose reuse window (`HELPER_REUSE_HOLD_MS`) ends sooner than
 * this is left out, so the Jev consultation (≤ 4 s) plus the prompt delivery
 * never race the close of the pane that would receive the task.
 */
export const HELPER_REUSE_CLAIM_MARGIN_MS = 30_000;

/**
 * Why a scan found no candidate. Categories only — never ids, titles or text —
 * so the decision journal can show why `helperReuse` does not fire.
 */
export type HelperReuseRejection =
  | 'no-helper'
  | 'not-idle'
  | 'one-shot'
  | 'other-cli'
  | 'other-mode'
  | 'review-task'
  | 'closing'
  | 'armed'
  | 'isolated-writer'
  | 'no-hook'
  | 'too-recent';

export interface IdleHelperScan {
  candidates: IdleHelperCandidate[];
  /** `null` when there is a candidate; otherwise the most frequent rejection among the owner's helpers. */
  noCandidateReason: HelperReuseRejection | null;
}
const HELPER_REUSE_TASK_CHARS = 1_500;
const HELPER_REUSE_HANDOFF_CHARS = 400;
const HELPER_REUSE_TAIL_CHARS = 600;

const REVIEW_TASK_RE = /revis|review|audit/i;

export interface IdleHelperCandidate {
  paneId: string;
  sessionId: string;
  title: string;
  idleForMs: number;
}

export interface IdleHelperReuseDeps {
  listPaneSnapshots?: () => PaneSnapshot[];
  getAuthority?: (sessionId: string) => PaneRuntimeAuthority | null;
  getSemanticStatus?: (sessionId: string) => AgentSemanticStatusEntry | null;
  /** Sessão fisicamente viva e stdin escrevível — falso durante o close. */
  stdinWritable?: (sessionId: string) => boolean;
  armedAutoClose?: (sessionId: string, paneId?: string | null) => string | null;
  /** F-197: ms left in the pane's reuse window, `null` outside one. */
  reuseHoldRemaining?: (sessionId: string, paneId: string) => number | null;
  isIsolatedWriter?: (
    scope: ProjectExecutionScope,
    sessionId: string,
    paneId: string,
  ) => boolean;
  lastHandoffSummary?: (
    scope: ProjectExecutionScope,
    missionId: string | null,
    sessionId: string,
  ) => string | null;
  outputTail?: (sessionId: string) => string;
  judge?: typeof judge;
  surfaceEnabled?: () => boolean;
  hasKey?: () => boolean;
  now?: () => number;
}

/** Tarefa de revisão/auditoria nunca reutiliza um writer (leitura própria). */
export function taskAsksForIndependentReview(task: string): boolean {
  return REVIEW_TASK_RE.test(task);
}

function paneIsIsolatedWriter(
  scope: ProjectExecutionScope,
  sessionId: string,
  paneId: string,
): boolean {
  try {
    const registry = requireWorktreeRuntimeRegistry();
    return Boolean(
      registry.findPaneWriter(scope, { sessionId }) ??
        registry.findPaneWriter(scope, { paneId }),
    );
  } catch {
    // Registry não inicializado = nenhum writer isolado existe.
    return false;
  }
}

function lastHandoffSummaryOf(
  scope: ProjectExecutionScope,
  missionId: string | null,
  sessionId: string,
): string | null {
  try {
    const rows = getProjectDomainStores(scope).handoffs.list({
      missionId,
      includeDelivered: true,
      sessionIds: [sessionId],
    });
    return rows.at(-1)?.summary ?? null;
  } catch {
    return null;
  }
}

export interface IdleHelperScanInput {
  mode: 'operator-hand' | 'tab-mission';
  callerSessionId: string;
  missionId?: string;
  adapterId: string;
  readOnly: boolean;
  newTask: string;
  scope: ProjectExecutionScope;
}

/**
 * Filtra os helpers reutilizáveis (máx. 5, mais recentemente ocioso primeiro).
 * `mode: 'operator-hand'` = filhos do pane do operador (sem missão);
 * `mode: 'tab-mission'` = workers da missão da aba indicada.
 */
export function listIdleHelperCandidates(
  input: IdleHelperScanInput,
  deps: IdleHelperReuseDeps = {},
): IdleHelperCandidate[] {
  return scanIdleHelperCandidates(input, deps).candidates;
}

/**
 * Same filter as `listIdleHelperCandidates`, plus WHY nothing qualified: the
 * superfície `helperReuse` passou 4 semanas sem disparar e o diário não dizia
 * se faltava helper, se todos estavam armados para fechar ou ainda trabalhando.
 * Only the owner's own helpers count towards the reason.
 */
export function scanIdleHelperCandidates(
  input: IdleHelperScanInput,
  deps: IdleHelperReuseDeps = {},
): IdleHelperScan {
  const snapshots = (deps.listPaneSnapshots ?? listPaneSnapshots)();
  const authorityOf = deps.getAuthority ?? getPaneRuntimeAuthorityBySession;
  const semanticOf = deps.getSemanticStatus ?? getAgentSemanticStatusBySession;
  const writable = deps.stdinWritable ?? isSessionStdinWritable;
  const armed = deps.armedAutoClose ?? armedAutoClosePaneId;
  const holdRemaining = deps.reuseHoldRemaining ?? reuseHoldRemainingMs;
  const isolated = deps.isIsolatedWriter ?? paneIsIsolatedWriter;
  const now = (deps.now ?? Date.now)();
  const reviewTask = taskAsksForIndependentReview(input.newTask);
  const candidates: IdleHelperCandidate[] = [];
  const rejected = new Map<HelperReuseRejection, number>();
  const reject = (reason: HelperReuseRejection): void => {
    rejected.set(reason, (rejected.get(reason) ?? 0) + 1);
  };
  /** First failed condition for one of the owner's helpers; `null` = candidate. */
  const rejectionOf = (pane: PaneSnapshot, sessionId: string): HelperReuseRejection | null => {
    if (pane.state !== 'idle') return 'not-idle';
    // F-1272: one-shot (agy --print / opencode run) com a raiz viva não lê o
    // terminal — injetar a tarefa nova a perderia (nexus_pane_ask já recusa).
    if (pane.oneShotAlive === true) return 'one-shot';
    if (pane.adapterId !== input.adapterId) return 'other-cli';
    if ((pane.readOnly === true) !== input.readOnly) return 'other-mode';
    if (reviewTask && !input.readOnly) return 'review-task';
    // "Não está fechando": stdin escrevível exclui o voo de término físico, e a
    // janela de reuso no fim (F-197) não recebe tarefa que ela vai cortar.
    if (!writable(sessionId)) return 'closing';
    const remaining = holdRemaining(sessionId, pane.paneId);
    if (remaining !== null && remaining < HELPER_REUSE_CLAIM_MARGIN_MS) return 'closing';
    if (armed(sessionId, pane.paneId) !== null) return 'armed';
    if (isolated(input.scope, sessionId, pane.paneId)) return 'isolated-writer';
    // Sem a marca semântica não há como medir os 20s — pane sem hook nunca é
    // candidato (conservador, nunca escreve a esmo).
    const semantic = semanticOf(sessionId);
    if (!semantic) return 'no-hook';
    if (semantic.status !== 'idle' && semantic.status !== 'completed') return 'not-idle';
    if (now - semantic.updatedAt < HELPER_REUSE_MIN_IDLE_MS) return 'too-recent';
    return null;
  };
  for (const pane of snapshots) {
    const sessionId = pane.sessionId;
    if (!sessionId || sessionId === input.callerSessionId) continue;
    if (pane.kind !== 'cli-agent') continue;
    // Só os helpers do MESMO dono contam (nem para o motivo do pulo).
    if (input.mode === 'operator-hand') {
      const authority = authorityOf(sessionId);
      if (authority?.operatorParentSessionId !== input.callerSessionId) {
        continue;
      }
    } else {
      if (pane.missionId !== input.missionId || pane.role !== 'worker') {
        continue;
      }
    }
    const rejection = rejectionOf(pane, sessionId);
    if (rejection) {
      reject(rejection);
      continue;
    }
    // Ocioso comprovado: `rejectionOf` já exigiu a marca semântica.
    const idleForMs = now - semanticOf(sessionId)!.updatedAt;
    candidates.push({
      paneId: pane.paneId,
      sessionId,
      title: pane.title,
      idleForMs,
    });
  }
  return {
    candidates: candidates
      .sort((a, b) => a.idleForMs - b.idleForMs)
      .slice(0, HELPER_REUSE_MAX_CANDIDATES),
    noCandidateReason: candidates.length > 0 ? null : mostFrequent(rejected) ?? 'no-helper',
  };
}

/** Most frequent rejection; ties keep the first one seen (check order). */
function mostFrequent(counts: ReadonlyMap<HelperReuseRejection, number>): HelperReuseRejection | null {
  let best: HelperReuseRejection | null = null;
  let bestCount = 0;
  for (const [reason, count] of counts) {
    if (count > bestCount) {
      best = reason;
      bestCount = count;
    }
  }
  return best;
}

/** O que o Jev vê do trabalho recente do helper: último handoff, senão o tail. */
function recentWorkOf(
  input: { scope: ProjectExecutionScope; missionId: string | null },
  candidate: IdleHelperCandidate,
  deps: IdleHelperReuseDeps,
): string {
  const summary = (
    deps.lastHandoffSummary ?? lastHandoffSummaryOf
  )(input.scope, input.missionId, candidate.sessionId);
  if (summary?.trim()) return capText(summary.trim(), HELPER_REUSE_HANDOFF_CHARS);
  const tail = (deps.outputTail ?? ((sessionId) => readSessionOutput(sessionId, 80)))(
    candidate.sessionId,
  );
  return stripAnsi(tail).slice(-HELPER_REUSE_TAIL_CHARS).trim();
}

export interface HelperReuseChoice {
  candidate: IdleHelperCandidate;
  confidence: number;
  reason: string;
}

function helperReuseQuestions(
  helpers: { id: string; title: string; recentWork: string }[],
): Record<string, JevQuestion> {
  const criteria: Record<string, string | null> = {};
  // O título do pane é texto não confiável: o critério aponta o caminho no
  // state (`helpers[i].title`) em vez de colar o texto dentro da pergunta.
  helpers.forEach((_helper, index) => {
    criteria[`h${index + 1}`] =
      `Helper \`helpers[${index}].title\`: its recent work is directly related to ` +
      'the new task (same feature, same files or a follow-up), so ' +
      'continuing in its context helps.';
  });
  criteria.none =
    "No helper's recent work is directly related, or the task asks for a " +
    'fresh or independent agent (for example an independent review of ' +
    "that helper's own work).";
  return {
    pick: {
      type: 'choice',
      instructions:
        'An idle helper agent can take a new task instead of starting a ' +
        'fresh agent, which saves time and cost. Pick the idle helper ' +
        'whose recent work makes it a good fit to continue with this new ' +
        'task, or none if the new task is unrelated to what every helper ' +
        'was doing, needs a clean context, or asks for an independent ' +
        "look at a helper's own work.",
      criteria,
    },
  };
}

/**
 * UMA consulta `judge()` escolhe o candidato — ou `none`. Só vence escolha
 * hN válida com confiança ≥ 0.7; a decisão vai ao diário na superfície
 * `helperReuse`.
 */
export async function judgeIdleHelperReuse(
  input: {
    newTask: string;
    candidates: IdleHelperCandidate[];
    /** From `scanIdleHelperCandidates`: why the list is empty (category). */
    noCandidateReason?: HelperReuseRejection | null;
    scope: ProjectExecutionScope;
    missionId: string | null;
    callerSessionId?: string;
  },
  deps: IdleHelperReuseDeps = {},
): Promise<HelperReuseChoice | null> {
  const enabled = deps.surfaceEnabled ?? (() => isJevSurfaceEnabled('helperReuse'));
  const hasKey = deps.hasKey ?? (() => hasDecisionCredential('helperReuse'));
  if (!enabled() || !hasKey()) return null;
  if (input.candidates.length === 0) {
    // Elegível, mas nada a julgar: o pulo fica no diário com a categoria,
    // para o painel mostrar por que a superfície não dispara (zero requisição).
    recordJevSkip({
      surface: 'helperReuse',
      reason: `no-candidate:${input.noCandidateReason ?? 'no-helper'}`,
      ...(input.callerSessionId ? { sessionId: input.callerSessionId } : {}),
      ...(input.missionId ? { missionId: input.missionId } : {}),
    });
    return null;
  }
  const helpers = input.candidates.map((candidate, index) => ({
    id: `h${index + 1}`,
    title: candidate.title,
    recentWork: recentWorkOf(
      { scope: input.scope, missionId: input.missionId },
      candidate,
      deps,
    ),
  }));
  const questions = helperReuseQuestions(helpers);
  const judgeFn = deps.judge ?? judge;
  const result = await judgeFn({
    state: {
      newTask: capText(input.newTask, HELPER_REUSE_TASK_CHARS),
      helpers,
    },
    questions,
    timeoutMs: HELPER_REUSE_TIMEOUT_MS,
    // F-1626: escolha limítrofe na 1ª posição é reconferida com a ordem invertida.
    orderCheck: { minConfidence: HELPER_REUSE_MIN_CONFIDENCE },
    surface: 'helperReuse',
    ...(input.callerSessionId ? { sessionId: input.callerSessionId } : {}),
    ...(input.missionId ? { missionId: input.missionId } : {}),
    retryOnTimeout: false,
  });
  if (!result) return null;
  const answer = result.answers.pick;
  if (answer?.type !== 'choice' || answer.choice === 'none') {
    recordJevDecision({
      surface: 'helperReuse',
      model: result.model,
      questions: Object.keys(questions),
      probabilities: jevAnswerProbabilities(result.answers),
      confidence: jevAnswerConfidences(result.answers),
      decision:
        answer?.type !== 'choice'
          ? 'spawn:bad-kind'
          : 'spawn:none',
      ...decisionResultUsage(result),
      ...(input.callerSessionId ? { sessionId: input.callerSessionId } : {}),
      ...(input.missionId ? { missionId: input.missionId } : {}),
    });
    return null;
  }
  const match = /^h(\d+)$/.exec(answer.choice ?? '');
  const index = match ? Number(match[1]) - 1 : -1;
  const candidate = index >= 0 ? input.candidates[index] : undefined;
  const confidence = answer.confidence;
  if (!candidate) {
    recordJevDecision({
      surface: 'helperReuse',
      model: result.model,
      questions: Object.keys(questions),
      probabilities: jevAnswerProbabilities(result.answers),
      confidence: jevAnswerConfidences(result.answers),
      decision: 'spawn:invalid-choice',
      ...decisionResultUsage(result),
      ...(input.callerSessionId ? { sessionId: input.callerSessionId } : {}),
      ...(input.missionId ? { missionId: input.missionId } : {}),
    });
    return null;
  }
  if (confidence < HELPER_REUSE_MIN_CONFIDENCE) {
    recordJevDecision({
      surface: 'helperReuse',
      model: result.model,
      questions: Object.keys(questions),
      probabilities: jevAnswerProbabilities(result.answers),
      confidence: jevAnswerConfidences(result.answers),
      decision: 'spawn:low-confidence',
      ...decisionResultUsage(result),
      ...(input.callerSessionId ? { sessionId: input.callerSessionId } : {}),
      ...(input.missionId ? { missionId: input.missionId } : {}),
    });
    return null;
  }
  recordJevDecision({
    surface: 'helperReuse',
    model: result.model,
    questions: Object.keys(questions),
    probabilities: jevAnswerProbabilities(result.answers),
    confidence: jevAnswerConfidences(result.answers),
    decision: `reuse:${answer.choice}`,
    ...decisionResultUsage(result),
    ...(input.callerSessionId ? { sessionId: input.callerSessionId } : {}),
    ...(input.missionId ? { missionId: input.missionId } : {}),
  });
  return {
    candidate,
    confidence,
    reason: `helper ocioso com contexto relacionado (Jev ${confidence})`,
  };
}
