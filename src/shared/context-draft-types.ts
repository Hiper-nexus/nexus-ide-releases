import { z } from 'zod';

/**
 * Human-in-the-loop context draft review. When no second CLI provider exists
 * (or autonomous review gave up), the local operator approves source-bound
 * context drafts in the UI — the human is independent of the agent author,
 * so the approval satisfies the same independent-review attestation contract.
 */

export const CONTEXT_DRAFT_CHANNELS = {
  listProposed: 'context-draft:list-proposed',
  approve: 'context-draft:approve',
} as const;

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ATTESTATION_ID_PATTERN = /^att-[a-f0-9]{40}$/;

export const pendingContextDraftSourceSchema = z
  .object({
    type: z.enum(['file', 'git', 'test', 'schema', 'connector', 'decision']),
    locator: z.string().min(1).max(4_096),
    sourceHash: z.string().regex(HASH_PATTERN),
  })
  .strict();

export const pendingContextDraftSchema = z
  .object({
    id: z.string().min(1).max(256),
    missionId: z.string().min(1).max(256).nullable(),
    targetPath: z.string().min(1).max(4_096),
    content: z.string().max(1024 * 1024),
    contentHash: z.string().regex(HASH_PATTERN),
    sources: z.array(pendingContextDraftSourceSchema).min(1).max(256),
    authorProvider: z.string().min(1).max(256),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();

export type PendingContextDraft = z.infer<typeof pendingContextDraftSchema>;

export const approveContextDraftInputSchema = z
  .object({
    draftId: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    rationale: z.string().trim().min(1).max(65_536).optional(),
  })
  .strict();

export type ApproveContextDraftInput = z.infer<
  typeof approveContextDraftInputSchema
>;

export const approveContextDraftResultSchema = z
  .object({
    draftId: z.string().min(1).max(256),
    targetPath: z.string().min(1).max(4_096),
    status: z.literal('applied'),
    attestationId: z.string().regex(ATTESTATION_ID_PATTERN).nullable(),
    attestationPath: z.string().min(1).max(4_096),
    reviewerProvider: z.literal('human'),
    readinessReady: z.boolean(),
    readinessBlockers: z.array(z.string()).max(256),
  })
  .strict();

export type ApproveContextDraftResult = z.infer<
  typeof approveContextDraftResultSchema
>;
