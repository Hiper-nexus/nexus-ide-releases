import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  projectExecutionScopeSchema,
  type ProjectExecutionScope,
} from '../../shared/types';
import { canonicalJson } from './canonical-json';

export const missionRiskSchema = z.enum(['low', 'medium', 'high', 'critical']);
export type MissionRisk = z.infer<typeof missionRiskSchema>;

export const workflowStageSchema = z.enum([
  'planning',
  'review-primary',
  'review-secondary',
  'execution',
  'validation-primary',
  'validation-secondary',
  'confirmation',
  'complete',
]);
export type WorkflowStage = z.infer<typeof workflowStageSchema>;

const boundedIdentifier = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const acceptanceCriterionSchema = z
  .object({
    id: boundedIdentifier,
    statement: z.string().trim().min(1).max(4_096),
    requiredSensorIds: z.array(boundedIdentifier).max(64).default([]),
    invariantRefs: z.array(boundedIdentifier).max(64).default([]),
    requiredArtifactIds: z.array(boundedIdentifier).max(64).default([]),
  })
  .strict();
export interface AcceptanceCriterion {
  readonly id: string;
  readonly statement: string;
  readonly requiredSensorIds: readonly string[];
  readonly invariantRefs: readonly string[];
  readonly requiredArtifactIds: readonly string[];
}

const proposalSchema = z
  .object({
    schemaVersion: z.literal(1),
    scope: projectExecutionScopeSchema,
    missionId: boundedIdentifier,
    baseCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i),
    contextRevision: z.string().trim().min(1).max(256),
    goal: z.string().trim().min(1).max(16_384),
    nonGoals: z.array(z.string().trim().min(1).max(4_096)).max(256).default([]),
    acceptanceCriteria: z.array(acceptanceCriterionSchema).min(1).max(256),
    businessInvariantRefs: z.array(boundedIdentifier).max(256).default([]),
    impactedDomains: z.array(boundedIdentifier).max(256).default([]),
    impactedSymbols: z.array(z.string().trim().min(1).max(512)).max(1_024).default([]),
    requestedSensors: z.array(boundedIdentifier).max(256).default([]),
    requiredArtifacts: z.array(boundedIdentifier).max(256).default([]),
    riskHints: z.array(z.string().trim().min(1).max(256)).max(256).default([]),
  })
  .strict();

export type MissionContractProposal = z.input<typeof proposalSchema>;

export interface ContractCompilationContext {
  readonly invariantRefs: ReadonlySet<string>;
  readonly availableSensorIds: ReadonlySet<string>;
  readonly blockingConflictIds: readonly string[];
}

export interface ReviewerPolicy {
  readonly minimumReviewers: number;
  readonly requireIndependentAuthor: true;
  readonly requireDifferentProvider: boolean;
  readonly blockingSeverities: readonly ['critical', 'high'];
}

export interface MissionContract {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly checkoutId: string;
  readonly missionId: string;
  readonly baseCommit: string;
  readonly contextRevision: string;
  readonly goal: string;
  readonly nonGoals: readonly string[];
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
  readonly businessInvariantRefs: readonly string[];
  readonly impactedDomains: readonly string[];
  readonly impactedSymbols: readonly string[];
  readonly requiredSensors: readonly string[];
  readonly requiredArtifacts: readonly string[];
  readonly reviewerPolicy: ReviewerPolicy;
  readonly risk: MissionRisk;
  readonly phase: WorkflowStage;
  readonly route: readonly WorkflowStage[];
  readonly contractHash: string;
}

const reviewerPolicySchema = z
  .object({
    minimumReviewers: z.number().int().min(0).max(16),
    requireIndependentAuthor: z.literal(true),
    requireDifferentProvider: z.boolean(),
    blockingSeverities: z.tuple([z.literal('critical'), z.literal('high')]),
  })
  .strict();

const storedMissionContractSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId: boundedIdentifier,
    checkoutId: boundedIdentifier,
    missionId: boundedIdentifier,
    baseCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    contextRevision: z.string().trim().min(1).max(256),
    goal: z.string().trim().min(1).max(16_384),
    nonGoals: z.array(z.string().trim().min(1).max(4_096)).max(256),
    acceptanceCriteria: z.array(acceptanceCriterionSchema).min(1).max(256),
    businessInvariantRefs: z.array(boundedIdentifier).max(256),
    impactedDomains: z.array(boundedIdentifier).max(256),
    impactedSymbols: z.array(z.string().trim().min(1).max(512)).max(1_024),
    requiredSensors: z.array(boundedIdentifier).max(256),
    requiredArtifacts: z.array(boundedIdentifier).max(256),
    reviewerPolicy: reviewerPolicySchema,
    risk: missionRiskSchema,
    phase: workflowStageSchema,
    route: z.array(workflowStageSchema).min(2).max(8),
    contractHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export class ContractCompilationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`mission contract rejected: ${issues.join('; ')}`);
    this.name = 'ContractCompilationError';
    this.issues = Object.freeze([...issues]);
  }
}

const RISK_ORDER: readonly MissionRisk[] = ['low', 'medium', 'high', 'critical'];
const CRITICAL_SIGNAL =
  /\b(payment|payments|billing|charge|refund|tenant[- ]?isolation|\brls\b|secret|credential|license|updater?|policy engine)\b/i;
const HIGH_SIGNAL =
  /\b(auth|oauth|session|permission|authorization|migration|schema|database|concurr|race|\bipc\b|network|webhook|queue|delete|remov|security|encryption|sandbox)\b/i;
const UI_SIGNAL =
  /\b(landing|website|frontend|interface|\bui\b|\bux\b|design|responsive|accessibility|acessibilidade|page|página|pagina|dashboard|mobile|desktop)\b/i;

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()))].sort((a, b) =>
    a.localeCompare(b),
  );
}

function maxRisk(left: MissionRisk, right: MissionRisk): MissionRisk {
  return RISK_ORDER[Math.max(RISK_ORDER.indexOf(left), RISK_ORDER.indexOf(right))];
}

export function classifyMissionRisk(input: {
  goal: string;
  riskHints: readonly string[];
  impactedDomains: readonly string[];
  acceptanceCriteria: readonly AcceptanceCriterion[];
}): MissionRisk {
  const corpus = [
    input.goal,
    ...input.riskHints,
    ...input.impactedDomains,
    ...input.acceptanceCriteria.map((criterion) => criterion.statement),
  ].join('\n');
  let risk: MissionRisk = 'medium';
  if (input.impactedDomains.length === 0 && input.acceptanceCriteria.length === 1) {
    risk = 'low';
  }
  if (HIGH_SIGNAL.test(corpus)) risk = maxRisk(risk, 'high');
  if (CRITICAL_SIGNAL.test(corpus)) risk = 'critical';
  return risk;
}

export function routeForRisk(risk: MissionRisk): readonly WorkflowStage[] {
  const routes: Record<MissionRisk, readonly WorkflowStage[]> = {
    low: ['execution', 'validation-primary'],
    medium: ['planning', 'execution', 'validation-primary'],
    high: [
      'planning',
      'review-primary',
      'execution',
      'validation-primary',
      'confirmation',
    ],
    critical: [
      'planning',
      'review-primary',
      'review-secondary',
      'execution',
      'validation-primary',
      'validation-secondary',
      'confirmation',
    ],
  };
  return Object.freeze([...routes[risk]]);
}

function freezeContract(contract: Omit<MissionContract, 'contractHash'>): MissionContract {
  const hash = createHash('sha256').update(canonicalJson(contract)).digest('hex');
  return Object.freeze({
    ...contract,
    nonGoals: Object.freeze([...contract.nonGoals]),
    acceptanceCriteria: Object.freeze(
      contract.acceptanceCriteria.map((criterion) =>
        Object.freeze({
          ...criterion,
          requiredSensorIds: Object.freeze([...criterion.requiredSensorIds]),
          invariantRefs: Object.freeze([...criterion.invariantRefs]),
          requiredArtifactIds: Object.freeze([...criterion.requiredArtifactIds]),
        }),
      ),
    ),
    businessInvariantRefs: Object.freeze([...contract.businessInvariantRefs]),
    impactedDomains: Object.freeze([...contract.impactedDomains]),
    impactedSymbols: Object.freeze([...contract.impactedSymbols]),
    requiredSensors: Object.freeze([...contract.requiredSensors]),
    requiredArtifacts: Object.freeze([...contract.requiredArtifacts]),
    reviewerPolicy: Object.freeze({
      ...contract.reviewerPolicy,
      blockingSeverities: Object.freeze(['critical', 'high'] as const),
    }),
    route: Object.freeze([...contract.route]),
    contractHash: hash,
  });
}

/** Validate persisted contracts and verify their content-addressed identity. */
export function parseMissionContract(raw: unknown): MissionContract {
  const parsed = storedMissionContractSchema.parse(raw);
  const { contractHash, ...material } = parsed;
  const expectedHash = createHash('sha256')
    .update(canonicalJson(material))
    .digest('hex');
  if (contractHash !== expectedHash) {
    throw new Error('persisted mission contract hash mismatch');
  }
  const expectedRoute = routeForRisk(parsed.risk);
  if (canonicalJson(parsed.route) !== canonicalJson(expectedRoute)) {
    throw new Error('persisted mission contract route mismatch');
  }
  return freezeContract(material);
}

export function compileMissionContract(
  rawProposal: MissionContractProposal,
  context: ContractCompilationContext,
): MissionContract {
  const parsed = proposalSchema.safeParse(rawProposal);
  if (!parsed.success) {
    throw new ContractCompilationError(
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }
  const proposal = parsed.data;
  const criteriaIds = proposal.acceptanceCriteria.map((criterion) => criterion.id);
  const issues: string[] = [];
  if (new Set(criteriaIds).size !== criteriaIds.length) {
    issues.push('acceptance criterion IDs must be unique');
  }
  if (context.blockingConflictIds.length > 0) {
    issues.push(
      `blocking context conflict: ${sortedUnique(context.blockingConflictIds).join(', ')}`,
    );
  }
  const invariantRefs = sortedUnique([
    ...proposal.businessInvariantRefs,
    ...proposal.acceptanceCriteria.flatMap((criterion) => criterion.invariantRefs),
  ]);
  for (const ref of invariantRefs) {
    if (!context.invariantRefs.has(ref)) issues.push(`unknown business invariant: ${ref}`);
  }
  const uiCorpus = [
    proposal.goal,
    ...proposal.impactedDomains,
    ...proposal.acceptanceCriteria.map((criterion) => criterion.statement),
  ].join('\n');
  const requiredSensors = sortedUnique([
    ...proposal.requestedSensors,
    ...proposal.acceptanceCriteria.flatMap((criterion) => criterion.requiredSensorIds),
    ...(UI_SIGNAL.test(uiCorpus) ? ['design-system'] : []),
  ]);
  for (const sensorId of requiredSensors) {
    if (!context.availableSensorIds.has(sensorId)) issues.push(`unknown sensor: ${sensorId}`);
  }
  if (issues.length > 0) throw new ContractCompilationError(issues);

  const acceptanceCriteria = [...proposal.acceptanceCriteria]
    .map((criterion) => ({
      ...criterion,
      requiredSensorIds: sortedUnique(criterion.requiredSensorIds),
      invariantRefs: sortedUnique(criterion.invariantRefs),
      requiredArtifactIds: sortedUnique(criterion.requiredArtifactIds),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const impactedDomains = sortedUnique(proposal.impactedDomains);
  const risk = classifyMissionRisk({
    goal: proposal.goal,
    riskHints: proposal.riskHints,
    impactedDomains,
    acceptanceCriteria,
  });
  const route = routeForRisk(risk);
  const reviewerPolicy: ReviewerPolicy = {
    // Even low-risk AI-authored code receives an independent code review in
    // validation. Higher risk changes also get explicit pre-execution review
    // stages, while critical work requires two independent reviewers.
    minimumReviewers: risk === 'critical' ? 2 : 1,
    requireIndependentAuthor: true,
    // Codex is the only release-qualified worker provider. Reviewer
    // independence is enforced by immutable agent + physical session
    // identities, not by executable vendor labels.
    requireDifferentProvider: false,
    blockingSeverities: ['critical', 'high'],
  };

  return freezeContract({
    schemaVersion: 1,
    projectId: proposal.scope.projectId,
    checkoutId: proposal.scope.checkoutId,
    missionId: proposal.missionId,
    baseCommit: proposal.baseCommit.toLowerCase(),
    contextRevision: proposal.contextRevision,
    goal: proposal.goal,
    nonGoals: sortedUnique(proposal.nonGoals),
    acceptanceCriteria,
    businessInvariantRefs: invariantRefs,
    impactedDomains,
    impactedSymbols: sortedUnique(proposal.impactedSymbols),
    requiredSensors,
    requiredArtifacts: sortedUnique(proposal.requiredArtifacts),
    reviewerPolicy,
    risk,
    phase: route[0],
    route,
  });
}

export function scopeMatchesContract(
  scope: Pick<ProjectExecutionScope, 'projectId' | 'checkoutId'>,
  contract: Pick<MissionContract, 'projectId' | 'checkoutId'>,
): boolean {
  return (
    scope.projectId === contract.projectId && scope.checkoutId === contract.checkoutId
  );
}
