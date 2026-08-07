import { z } from 'zod';

const commandSchema = z.string().min(1).max(16_384);
const idSchema = z.string().min(1).max(128);
const pathSchema = z.string().min(1).max(4096);

export const commandSuggestionScopeSchema = z.enum([
  'cwd',
  'project',
  'global',
]);

export type CommandSuggestionScope = z.infer<
  typeof commandSuggestionScopeSchema
>;

export const commandSuggestionSchema = z
  .object({
    command: commandSchema,
    cwd: pathSchema,
    projectRoot: pathSchema.optional(),
    lastBranch: z.string().max(512).optional(),
    totalCount: z.number().int().nonnegative(),
    successCount: z.number().int().nonnegative(),
    successRate: z.number().min(0).max(1),
    distinctDays: z.number().int().nonnegative(),
    dismissedCount: z.number().int().nonnegative(),
    lastUsed: z.number().int().nonnegative(),
    score: z.number().finite(),
    scope: commandSuggestionScopeSchema,
  })
  .strict();

export type CommandSuggestion = z.infer<typeof commandSuggestionSchema>;

export const commandRefinerySuggestRequestSchema = z
  .object({
    sessionId: idSchema,
    paneId: idSchema,
    prefix: z.string().max(512).optional(),
    limit: z.number().int().min(1).max(20).optional(),
  })
  .strict();

export type CommandRefinerySuggestRequest = z.infer<
  typeof commandRefinerySuggestRequestSchema
>;

export const commandRefineryCommandRequestSchema = z
  .object({
    sessionId: idSchema,
    paneId: idSchema,
    command: commandSchema,
    cwd: pathSchema,
  })
  .strict();

export type CommandRefineryCommandRequest = z.infer<
  typeof commandRefineryCommandRequestSchema
>;

export interface CommandRefinerySuggestResult {
  readonly suggestions: CommandSuggestion[];
  readonly error?: string;
}

export interface CommandRefineryMutationResult {
  readonly ok: boolean;
  readonly error?: string;
}
