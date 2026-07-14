import { z } from 'zod';

/**
 * Semantic command block — lateral to the raw PTY stream (visual source of truth).
 * Immutable value object: create new instances via helpers, never mutate fields.
 *
 * Idempotency keys are computed in main (`command-block-id.ts`) so this module
 * stays free of Node builtins and safe for renderer import.
 */

export const COMMAND_BLOCK_STATUSES = [
  'running',
  'success',
  'failed',
  'cancelled',
  'unknown',
] as const;
export type CommandBlockStatus = (typeof COMMAND_BLOCK_STATUSES)[number];

export const commandBlockStatusSchema = z.enum(COMMAND_BLOCK_STATUSES);

export const commandOutputRangeSchema = z
  .object({
    /** Opaque stream sequence or byte offset start (inclusive). */
    startSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    /** Opaque stream sequence or byte offset end (exclusive); null while running. */
    endSeq: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .nullable(),
  })
  .strict();

export type CommandOutputRange = z.infer<typeof commandOutputRangeSchema>;

export const commandRedactionStateSchema = z
  .object({
    redacted: z.boolean(),
    /** True when denylist matched and command was stored as placeholder. */
    denylisted: z.boolean().default(false),
    /** Count of secret-like substrings replaced before persistence. */
    secretHits: z.number().int().nonnegative().max(10_000).default(0),
  })
  .strict();

export type CommandRedactionState = z.infer<typeof commandRedactionStateSchema>;

const idSchema = z.string().min(1).max(128);
const pathSchema = z.string().min(1).max(4096);
const optionalPathSchema = z.string().min(1).max(4096).optional();

export const commandBlockSchema = z
  .object({
    id: idSchema,
    sessionId: idSchema,
    paneId: idSchema,
    workspaceId: idSchema,
    missionId: idSchema.optional(),
    /** Command text after redaction (never raw secrets). */
    command: z.string().max(16_384),
    cwd: pathSchema,
    projectRoot: optionalPathSchema,
    shell: z.string().min(1).max(256),
    gitBranch: z.string().max(512).optional(),
    startedAt: z.number().int().nonnegative(),
    endedAt: z.number().int().nonnegative().optional(),
    durationMs: z.number().int().nonnegative().optional(),
    exitCode: z.number().int().min(-2_147_483_648).max(2_147_483_647).optional(),
    status: commandBlockStatusSchema,
    outputRange: commandOutputRangeSchema.optional(),
    redaction: commandRedactionStateSchema,
    /**
     * Stable hash for idempotent inserts (session + start + command digest).
     */
    idempotencyKey: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type CommandBlock = z.infer<typeof commandBlockSchema>;

export interface CreateCommandBlockInput {
  readonly id: string;
  readonly sessionId: string;
  readonly paneId: string;
  readonly workspaceId: string;
  readonly missionId?: string;
  readonly command: string;
  readonly cwd: string;
  readonly projectRoot?: string;
  readonly shell: string;
  readonly gitBranch?: string;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly durationMs?: number;
  readonly exitCode?: number;
  readonly status: CommandBlockStatus;
  readonly outputRange?: CommandOutputRange;
  readonly redaction: CommandRedactionState;
  /** Required: compute via main `computeCommandBlockIdempotencyKey`. */
  readonly idempotencyKey: string;
}

/** Build an immutable validated CommandBlock. */
export function createCommandBlock(
  input: CreateCommandBlockInput,
): CommandBlock {
  return commandBlockSchema.parse({ ...input });
}

/** Finish a running block without mutating the original. */
export function completeCommandBlock(
  block: CommandBlock,
  end: {
    readonly endedAt: number;
    readonly exitCode?: number;
    readonly status: Exclude<CommandBlockStatus, 'running'>;
    readonly endSeq?: number;
  },
): CommandBlock {
  if (block.status !== 'running') {
    throw new Error('only running command blocks can be completed');
  }
  const durationMs = Math.max(0, end.endedAt - block.startedAt);
  return createCommandBlock({
    ...block,
    endedAt: end.endedAt,
    durationMs,
    exitCode: end.exitCode,
    status: end.status,
    outputRange: block.outputRange
      ? {
          startSeq: block.outputRange.startSeq,
          endSeq: end.endSeq ?? block.outputRange.endSeq,
        }
      : undefined,
    redaction: { ...block.redaction },
    idempotencyKey: block.idempotencyKey,
  });
}
