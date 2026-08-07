import { z } from 'zod';
import {
  agentCategorySchema,
  missionMilestoneSchema,
  squadAgentSchema,
} from './orch-types';
import { missionLaneSchema } from './mission-intent';

const idSchema = z.string().trim().min(1).max(256);
const labelSchema = z.string().trim().min(1).max(1_024);
const detailSchema = z.string().trim().min(1).max(16_384);
const timestampSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const SQUAD_AGENT_KEYS: Record<string, true> = {
  id: true,
  agentName: true,
  category: true,
  cli: true,
  providerId: true,
  model: true,
  effort: true,
  ownsPlanDocs: true,
  allowedSkills: true,
  allowedTools: true,
  persona: true,
};

const strictSquadAgentSchema = z.preprocess((value) => {
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).some((key) => SQUAD_AGENT_KEYS[key] !== true)
  ) {
    return null;
  }
  return value;
}, squadAgentSchema);

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
  .object({ lane: missionLaneSchema.optional() })
  .strict();
export type MissionAdvanced = z.infer<typeof missionAdvancedSchema>;

export const missionPrepareRequestSchema = z
  .object({
    objective: z.string().trim().min(1).max(65_536),
    title: labelSchema.optional(),
    contextPaths: z.array(z.string().trim().min(1).max(4_096)).max(64),
    roster: z.array(strictSquadAgentSchema).min(1).max(32),
    advanced: missionAdvancedSchema.optional(),
  })
  .strict();
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
    workspaceLabel: labelSchema,
    contextPaths: z.array(z.string().trim().min(1).max(4_096)).max(64),
    roster: z.array(strictSquadAgentSchema).min(1).max(32),
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

export const missionAgentSchema = z
  .object({
    id: z.string().min(1).max(128),
    agentName: z.string().min(1).max(128),
    category: agentCategorySchema,
    cli: z.string().min(1).max(64),
    providerId: z.string().max(128).optional(),
    model: z.string().max(128).optional(),
    effort: z
      .string()
      .min(1)
      .max(32)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
    ownsPlanDocs: z.boolean().optional(),
    allowedSkills: z.array(z.string().max(128)).max(128).nullable().optional(),
    allowedTools: z.array(z.string().max(128)).max(128).nullable().optional(),
    persona: z.string().max(128).optional(),
    state: missionAgentStateSchema,
    currentUnitId: idSchema.optional(),
    paneId: idSchema.optional(),
    detail: detailSchema.optional(),
  })
  .strict();
export type MissionAgent = z.infer<typeof missionAgentSchema>;

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
