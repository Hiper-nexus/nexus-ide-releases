import { z } from 'zod';
import {
  missionMilestoneSchema,
  squadAgentObjectSchema,
  strictSquadAgentSchema,
  type SquadAgent,
} from './orch-types';
import {
  MISSION_INTENT_GOAL_MAX_CHARS,
  missionAttachmentSnapshotSchema,
  missionIntentContractSchema,
  missionLaneSchema,
  missionProjectContextPathSchema,
  type MissionLane,
} from './mission-intent';
export const MISSION_PREPARE_TITLE_MAX_CHARS = 512;


const idSchema = z.string().trim().min(1).max(256);
const labelSchema = z.string().trim().min(1).max(1_024);
const detailSchema = z.string().trim().min(1).max(16_384);
const timestampSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const missionLifecycleStateSchema = z.enum([
  'draft',
  'review_ready',
  'starting',
  'running',
  'blocked_user',
  'blocked_technical',
  'recovering',
  'stopping',
  'failed',
  'completed',
]);
export type MissionLifecycleState = z.infer<
  typeof missionLifecycleStateSchema
>;

export const missionAllowedActionSchema = z.enum([
  'start',
  'retry-kickoff',
  'answer-question',
  'direct',
  'stop',
  'resume',
]);
export type MissionAllowedAction = z.infer<typeof missionAllowedActionSchema>;

export const missionAdvancedSchema = z
  .object({
    lane: missionLaneSchema.optional(),
    /** "Escolha livre de agentes" — opt-in por missão (ver mission-intent). */
    freeAgentChoice: z.boolean().optional(),
  })
  .strict();
export type MissionAdvanced = z.infer<typeof missionAdvancedSchema>;
export const missionPrepareProfileSchema = z
  .object({
    kind: z.literal('pet-studio'),
    referenceImagePath: z.string().trim().min(1).max(4_096),
  })
  .strict();
export type MissionPrepareProfile = z.infer<
  typeof missionPrepareProfileSchema
>;


export type MissionDeliveryRosterIssue =
  | 'executor-required'
  | 'reviewer-required';

export function missionDeliveryRosterIssue(
  roster: readonly Pick<SquadAgent, 'category'>[],
  lane: MissionLane,
): MissionDeliveryRosterIssue | null {
  if (lane !== 'standard' && lane !== 'ops') return null;
  if (!roster.some((agent) => agent.category === 'executor')) {
    return 'executor-required';
  }
  if (!roster.some((agent) => agent.category === 'reviewer')) {
    return 'reviewer-required';
  }
  return null;
}


export const missionPrepareRequestSchema = z
  .object({
    objective: z.string().trim().min(1).max(MISSION_INTENT_GOAL_MAX_CHARS),
    title: z
      .string()
      .trim()
      .min(1)
      .max(MISSION_PREPARE_TITLE_MAX_CHARS)
      .optional(),
    contextPaths: z.array(missionProjectContextPathSchema).max(64),
    acceptanceCriteria:
      missionIntentContractSchema.shape.acceptanceCriteria.optional(),
    roster: z.array(strictSquadAgentSchema).min(1).max(32),
    advanced: missionAdvancedSchema.optional(),
    profile: missionPrepareProfileSchema.optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.profile?.kind === 'pet-studio') return;
    const issue = missionDeliveryRosterIssue(
      request.roster,
      request.advanced?.lane ?? 'standard',
    );
    if (!issue) return;
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['roster'],
      message:
        issue === 'executor-required'
          ? 'standard delivery roster requires an executor'
          : 'standard delivery roster requires a reviewer',
    });
  });

export type MissionPrepareRequest = z.infer<
  typeof missionPrepareRequestSchema
>;

export const missionPermissionSchema = z
  .object({
    id: idSchema,
    label: labelSchema,
    detail: detailSchema.optional(),
  })
  .strict();
export type MissionPermission = z.infer<typeof missionPermissionSchema>;

export const missionReviewSchema = z
  .object({
    missionId: idSchema,
    title: labelSchema,
    objective: z.string().trim().min(1).max(65_536),
    workspaceLabel: z.string().trim().min(1).max(4_096),
    contextPaths: z.array(z.string().trim().min(1).max(4_096)).max(64),
    acceptanceCriteria:
      missionIntentContractSchema.shape.acceptanceCriteria.optional(),
    roster: z.array(strictSquadAgentSchema).min(1).max(32),
    attachments: z.array(missionAttachmentSnapshotSchema).max(6).optional(),
    permissions: z.array(missionPermissionSchema).max(64),
    warnings: z.array(detailSchema).max(64),
    reviewSha256: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: timestampSchema,
  })
  .strict();
export type MissionReview = z.infer<typeof missionReviewSchema>;

export const missionStateReasonSchema = z
  .object({
    code: idSchema,
    label: labelSchema,
    detail: detailSchema.optional(),
  })
  .strict();
export type MissionStateReason = z.infer<typeof missionStateReasonSchema>;

export const missionProgressSchema = z
  .object({
    completed: z.number().int().nonnegative().max(100_000),
    total: z.number().int().nonnegative().max(100_000),
  })
  .strict()
  .refine(({ completed, total }) => completed <= total, {
    message: 'completed cannot exceed total',
    path: ['completed'],
  });
export type MissionProgress = z.infer<typeof missionProgressSchema>;

export const missionAgentStateSchema = z.enum([
  'queued',
  'working',
  'waiting',
  'blocked',
  'done',
  'failed',
  'stopped',
]);
export type MissionAgentState = z.infer<typeof missionAgentStateSchema>;

export const missionAgentSchema = squadAgentObjectSchema
  .extend({
    state: missionAgentStateSchema,
    currentUnitId: idSchema.optional(),
    paneId: idSchema.optional(),
    detail: detailSchema.optional(),
  })
  .strict();
export type MissionAgentSnapshot = z.infer<typeof missionAgentSchema>;
export type MissionAgent = MissionAgentSnapshot;

export const missionEdgeKindSchema = z.enum([
  'delegation',
  'handoff',
  'dependency',
  'review',
]);
export type MissionEdgeKind = z.infer<typeof missionEdgeKindSchema>;

export const missionEdgeSchema = z
  .object({
    id: idSchema,
    sourceAgentId: idSchema,
    targetAgentId: idSchema,
    kind: missionEdgeKindSchema,
    label: labelSchema.optional(),
  })
  .strict();
export type MissionEdge = z.infer<typeof missionEdgeSchema>;

export const missionUnitStatusSchema = z.enum([
  'pending',
  'running',
  'blocked',
  'done',
  'failed',
]);
export type MissionUnitStatus = z.infer<typeof missionUnitStatusSchema>;

export const missionUnitSchema = z
  .object({
    id: idSchema,
    title: labelSchema,
    status: missionUnitStatusSchema,
    agentId: idSchema.optional(),
    dependsOn: z.array(idSchema).max(256),
    evidenceIds: missionMilestoneSchema.shape.evidenceIds,
  })
  .strict();
export type MissionUnit = z.infer<typeof missionUnitSchema>;

export const missionQuestionOptionSchema = z
  .object({
    id: idSchema,
    label: labelSchema,
    description: detailSchema.optional(),
  })
  .strict();
export type MissionQuestionOption = z.infer<
  typeof missionQuestionOptionSchema
>;

export const missionQuestionSchema = z
  .object({
    id: idSchema,
    prompt: detailSchema,
    detail: detailSchema.optional(),
    targetAgentId: idSchema.optional(),
    options: z.array(missionQuestionOptionSchema).max(16),
    allowFreeText: z.boolean(),
  })
  .strict()
  .refine(({ allowFreeText, options }) => allowFreeText || options.length > 0, {
    message: 'a question requires an option or free-text answers',
    path: ['options'],
  });
export type MissionQuestion = z.infer<typeof missionQuestionSchema>;

export const missionResultOutcomeSchema = z.enum([
  'success',
  'partial',
  'failed',
]);
export type MissionResultOutcome = z.infer<
  typeof missionResultOutcomeSchema
>;

export const missionResultSchema = z
  .object({
    outcome: missionResultOutcomeSchema,
    summary: z.string().trim().min(1).max(65_536),
    evidenceIds: z.array(idSchema).max(64),
    artifactRefs: z.array(idSchema).max(64),
  })
  .strict();
export type MissionResult = z.infer<typeof missionResultSchema>;

/**
 * Worktree de missão como o rail o mostra: branch (sem `refs/heads/`), caminho
 * e estado. Opcional em ambos os snapshots para o contrato `.strict()` continuar
 * aceitando payloads antigos.
 */
export const missionWorktreeSchema = z
  .object({
    branch: z.string().trim().min(1).max(512),
    path: z.string().min(1).max(4096).optional(),
    status: z.enum([
      'reserved',
      'ready',
      'queued',
      'integrated',
      'failed',
      'abandoned',
    ]),
  })
  .strict();
export type MissionWorktree = z.infer<typeof missionWorktreeSchema>;

export const missionSnapshotSchema = z
  .object({
    id: idSchema,
    title: labelSchema,
    objective: z.string().trim().min(1).max(65_536),
    workspaceLabel: labelSchema,
    state: missionLifecycleStateSchema,
    stateReason: missionStateReasonSchema.optional(),
    progress: missionProgressSchema,
    agents: z.array(missionAgentSchema).max(64),
    edges: z.array(missionEdgeSchema).max(256),
    units: z.array(missionUnitSchema).max(256),
    question: missionQuestionSchema.optional(),
    result: missionResultSchema.optional(),
    allowedActions: z.array(missionAllowedActionSchema).max(6),
    worktrees: z.array(missionWorktreeSchema).max(64).optional(),
    version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    updatedAt: timestampSchema,
  })
  .strict();
export type MissionSnapshot = z.infer<typeof missionSnapshotSchema>;

export const missionSummarySnapshotSchema = z
  .object({
    id: idSchema,
    title: labelSchema,
    state: missionLifecycleStateSchema,
    stateReason: missionStateReasonSchema.optional(),
    progress: missionProgressSchema,
    needsAttention: z.boolean(),
    worktrees: z.array(missionWorktreeSchema).max(64).optional(),
    updatedAt: timestampSchema,
  })
  .strict();
export type MissionSummarySnapshot = z.infer<
  typeof missionSummarySnapshotSchema
>;

const answerQuestionCommandSchema = z
  .object({
    kind: z.literal('answer-question'),
    missionId: idSchema,
    questionId: idSchema,
    optionId: idSchema.optional(),
    text: detailSchema.optional(),
  })
  .strict();

export const missionEngineCommandSchema = z
  .discriminatedUnion('kind', [
    z
      .object({ kind: z.literal('retry-kickoff'), missionId: idSchema })
      .strict(),
    z.object({ kind: z.literal('resume'), missionId: idSchema }).strict(),
    z.object({ kind: z.literal('stop'), missionId: idSchema }).strict(),
    z
      .object({
        kind: z.literal('direct'),
        missionId: idSchema,
        targetAgentId: idSchema.nullable(),
        text: detailSchema,
      })
      .strict(),
    answerQuestionCommandSchema,
  ])
  .refine(
    (command) =>
      command.kind !== 'answer-question' ||
      Boolean(command.optionId || command.text),
    {
      message: 'optionId or text is required',
      path: ['text'],
    },
  );
export type MissionEngineCommand = z.infer<
  typeof missionEngineCommandSchema
>;
