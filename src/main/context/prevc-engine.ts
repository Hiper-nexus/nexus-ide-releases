import type { MissionRisk, WorkflowStage } from './contract-compiler';
import { missionRiskSchema, routeForRisk, workflowStageSchema } from './contract-compiler';
import { z } from 'zod';

export interface EvidenceBinding {
  readonly projectId: string;
  readonly checkoutId: string;
  readonly missionId: string;
  readonly contractHash: string;
  readonly contextHash: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly diffHash: string;
}

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface WorkflowEvidence {
  readonly binding: EvidenceBinding;
  readonly blockingConflictIds: readonly string[];
  readonly openFindingSeverities: readonly FindingSeverity[];
  /** Sensor IDs issued by the Nexus Sensor Broker, never by an agent handoff. */
  readonly trustedSensorIds: readonly string[];
  readonly requiredSensorIds: readonly string[];
  /** Nexus-persisted artifact IDs scoped to this mission. */
  readonly trustedArtifactIds: readonly string[];
  readonly requiredArtifactIds: readonly string[];
  readonly authorId: string;
  readonly reviewerId?: string;
  readonly authorProvider: string;
  readonly reviewerProvider?: string;
  readonly worktreeId?: string;
  readonly integratedHeadSha?: string;
  readonly integratedDiffHash?: string;
}

export interface WorkflowReviewer {
  readonly id: string;
  readonly provider: string;
}

export interface WorkflowState {
  readonly risk: MissionRisk;
  readonly binding: EvidenceBinding;
  readonly route: readonly WorkflowStage[];
  readonly stage: WorkflowStage;
  readonly completedStages: readonly WorkflowStage[];
  readonly reviewers: readonly WorkflowReviewer[];
  readonly revision: number;
}

const evidenceBindingSchema = z
  .object({
    projectId: z.string().min(1).max(256),
    checkoutId: z.string().min(1).max(256),
    missionId: z.string().min(1).max(256),
    contractHash: z.string().regex(/^[a-f0-9]{64}$/),
    contextHash: z.string().regex(/^[a-f0-9]{64}$/),
    baseSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    headSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    diffHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const workflowStateSchema = z
  .object({
    risk: missionRiskSchema,
    binding: evidenceBindingSchema,
    route: z.array(workflowStageSchema).min(2).max(8),
    stage: workflowStageSchema,
    completedStages: z.array(workflowStageSchema).max(8),
    reviewers: z
      .array(
        z
          .object({ id: z.string().min(1).max(256), provider: z.string().min(1).max(256) })
          .strict(),
      )
      .max(16),
    revision: z.number().int().positive(),
  })
  .strict();

export class WorkflowGateError extends Error {
  readonly code:
    | 'invalid-transition'
    | 'binding-mismatch'
    | 'context-blocked'
    | 'review-invalid'
    | 'finding-blocked'
    | 'worktree-required'
    | 'sensor-missing'
    | 'artifact-missing'
    | 'integration-mismatch';

  constructor(code: WorkflowGateError['code'], message: string) {
    super(message);
    this.name = 'WorkflowGateError';
    this.code = code;
  }
}

const BINDING_KEYS: readonly (keyof EvidenceBinding)[] = [
  'projectId',
  'checkoutId',
  'missionId',
  'contractHash',
  'contextHash',
  'baseSha',
  'headSha',
  'diffHash',
];
const EXECUTION_STABLE_BINDING_KEYS: readonly (keyof EvidenceBinding)[] = [
  'projectId',
  'checkoutId',
  'missionId',
  'contractHash',
  'contextHash',
  'baseSha',
];

function freezeBinding(binding: EvidenceBinding): EvidenceBinding {
  return Object.freeze({ ...binding });
}

function assertBindingKeys(
  expected: EvidenceBinding,
  actual: EvidenceBinding,
  keys: readonly (keyof EvidenceBinding)[],
): void {
  const mismatch = keys.find((key) => expected[key] !== actual[key]);
  if (mismatch) {
    throw new WorkflowGateError(
      'binding-mismatch',
      `evidence binding mismatch for ${mismatch}`,
    );
  }
}

function assertBinding(expected: EvidenceBinding, actual: EvidenceBinding): void {
  assertBindingKeys(expected, actual, BINDING_KEYS);
}

function assertNoContextBlockers(evidence: WorkflowEvidence): void {
  if (evidence.blockingConflictIds.length > 0) {
    throw new WorkflowGateError(
      'context-blocked',
      `blocking context conflict: ${evidence.blockingConflictIds.join(', ')}`,
    );
  }
}

function assertNoBlockingFindings(evidence: WorkflowEvidence): void {
  const blocker = evidence.openFindingSeverities.find(
    (severity) => severity === 'critical' || severity === 'high',
  );
  if (blocker) {
    throw new WorkflowGateError('finding-blocked', `open blocking finding: ${blocker}`);
  }
}

function assertReview(
  state: WorkflowState,
  evidence: WorkflowEvidence,
): WorkflowReviewer {
  if (!evidence.reviewerId || !evidence.reviewerProvider) {
    throw new WorkflowGateError('review-invalid', 'reviewer identity is required');
  }
  if (evidence.reviewerId === evidence.authorId) {
    throw new WorkflowGateError('review-invalid', 'author cannot review their own work');
  }
  if (
    (state.risk === 'high' || state.risk === 'critical') &&
    evidence.reviewerProvider === evidence.authorProvider
  ) {
    throw new WorkflowGateError(
      'review-invalid',
      'high-risk review requires a different provider',
    );
  }
  if (state.reviewers.some((reviewer) => reviewer.id === evidence.reviewerId)) {
    throw new WorkflowGateError(
      'review-invalid',
      'critical review stages require independent reviewers',
    );
  }
  assertNoBlockingFindings(evidence);
  return Object.freeze({
    id: evidence.reviewerId,
    provider: evidence.reviewerProvider,
  });
}

function assertTrustedSensors(evidence: WorkflowEvidence): void {
  const trusted = new Set(evidence.trustedSensorIds);
  const missing = [...new Set(evidence.requiredSensorIds)].filter(
    (sensorId) => !trusted.has(sensorId),
  );
  if (missing.length > 0) {
    throw new WorkflowGateError(
      'sensor-missing',
      `required sensor evidence missing: ${missing.join(', ')}`,
    );
  }
}

function assertTrustedArtifacts(evidence: WorkflowEvidence): void {
  const trusted = new Set(evidence.trustedArtifactIds);
  const missing = [...new Set(evidence.requiredArtifactIds)].filter(
    (artifactId) => !trusted.has(artifactId),
  );
  if (missing.length > 0) {
    throw new WorkflowGateError(
      'artifact-missing',
      `required Nexus artifact missing: ${missing.join(', ')}`,
    );
  }
}

function assertIntegratedDiff(evidence: WorkflowEvidence): void {
  if (evidence.integratedHeadSha !== evidence.binding.headSha) {
    throw new WorkflowGateError(
      'integration-mismatch',
      'integrated HEAD is not the validated HEAD',
    );
  }
  if (evidence.integratedDiffHash !== evidence.binding.diffHash) {
    throw new WorkflowGateError(
      'integration-mismatch',
      'integrated diff is not the validated diff',
    );
  }
}

export function createWorkflowState(
  risk: MissionRisk,
  binding: EvidenceBinding,
): WorkflowState {
  const route = routeForRisk(risk);
  return Object.freeze({
    risk,
    binding: freezeBinding(binding),
    route,
    stage: route[0],
    completedStages: Object.freeze([]),
    reviewers: Object.freeze([]),
    revision: 1,
  });
}

/** Rehydrate durable workflow state without trusting arbitrary JSON. */
export function parseWorkflowState(raw: unknown): WorkflowState {
  const parsed = workflowStateSchema.parse(raw);
  const expectedRoute = routeForRisk(parsed.risk);
  if (JSON.stringify(parsed.route) !== JSON.stringify(expectedRoute)) {
    throw new Error('persisted workflow route mismatch');
  }
  const expectedCompleted = expectedRoute.slice(0, parsed.completedStages.length);
  if (JSON.stringify(parsed.completedStages) !== JSON.stringify(expectedCompleted)) {
    throw new Error('persisted workflow completed stages are not a route prefix');
  }
  const expectedStage = expectedRoute[parsed.completedStages.length] ?? 'complete';
  if (parsed.stage !== expectedStage || parsed.revision !== parsed.completedStages.length + 1) {
    throw new Error('persisted workflow stage or revision mismatch');
  }
  if (new Set(parsed.reviewers.map((reviewer) => reviewer.id)).size !== parsed.reviewers.length) {
    throw new Error('persisted workflow contains duplicate reviewers');
  }
  return Object.freeze({
    ...parsed,
    binding: freezeBinding(parsed.binding),
    route: Object.freeze([...parsed.route]),
    completedStages: Object.freeze([...parsed.completedStages]),
    reviewers: Object.freeze(parsed.reviewers.map((reviewer) => Object.freeze({ ...reviewer }))),
  });
}

function expectedNext(state: WorkflowState): WorkflowStage {
  if (state.stage === 'complete') return 'complete';
  const currentIndex = state.route.indexOf(state.stage);
  if (currentIndex < 0) {
    throw new WorkflowGateError('invalid-transition', 'workflow stage is outside its route');
  }
  return state.route[currentIndex + 1] ?? 'complete';
}

/**
 * The caller never sets mission status directly. It asks for the next stage;
 * Nexus verifies evidence for the stage being left and computes the result.
 */
export function advanceWorkflow(
  state: WorkflowState,
  evidence: WorkflowEvidence,
  requestedNext: WorkflowStage,
): WorkflowState {
  const next = expectedNext(state);
  if (state.stage === 'complete' || requestedNext !== next) {
    throw new WorkflowGateError(
      'invalid-transition',
      `next required stage is ${next}, not ${requestedNext}`,
    );
  }
  if (state.stage === 'execution') {
    // Execution is the single point where a frozen base legitimately becomes
    // a concrete HEAD/diff. Every other identity remains immutable, and all
    // later review/sensor evidence must match the produced diff exactly.
    assertBindingKeys(
      state.binding,
      evidence.binding,
      EXECUTION_STABLE_BINDING_KEYS,
    );
  } else {
    assertBinding(state.binding, evidence.binding);
  }
  assertNoContextBlockers(evidence);

  let reviewers = state.reviewers;
  if (state.stage === 'review-primary' || state.stage === 'review-secondary') {
    const reviewer = assertReview(state, evidence);
    reviewers = Object.freeze([...state.reviewers, reviewer]);
  }
  if (state.stage === 'execution' && !evidence.worktreeId) {
    throw new WorkflowGateError(
      'worktree-required',
      'execution requires an isolated worktree',
    );
  }
  if (
    state.stage === 'validation-primary' ||
    state.stage === 'validation-secondary' ||
    state.stage === 'confirmation'
  ) {
    assertTrustedSensors(evidence);
    assertTrustedArtifacts(evidence);
    assertNoBlockingFindings(evidence);
    assertIntegratedDiff(evidence);
  }

  return Object.freeze({
    ...state,
    binding:
      state.stage === 'execution'
        ? freezeBinding(evidence.binding)
        : state.binding,
    stage: next,
    completedStages: Object.freeze([...state.completedStages, state.stage]),
    reviewers,
    revision: state.revision + 1,
  });
}
