import { z } from 'zod';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';

/**
 * Explicit autonomy profiles — fail-closed decision gate.
 */

export const AUTONOMY_PROFILES = [
  'Inspect',
  'Edit',
  'Autonomous',
  'Custom',
] as const;

export type AutonomyProfile = (typeof AUTONOMY_PROFILES)[number];

export const autonomyProfileSchema = z.enum(AUTONOMY_PROFILES);

export const autonomyDecisionSchema = z
  .object({
    action: z.string().min(1).max(128),
    reason: z.string().max(1024),
    tool: z.string().max(128).optional(),
    scope: z.string().max(512),
    missionId: z.string().max(128).optional(),
    profile: autonomyProfileSchema,
    result: z.enum(['allow', 'deny', 'confirm']),
    effectMayHaveCommitted: z.boolean().default(false),
  })
  .strict();

export type AutonomyDecision = z.infer<typeof autonomyDecisionSchema>;

const WRITE_TOOLS = new Set([
  'file_write',
  'terminal_run',
  'git_commit',
  'git_push',
  'worktree_create',
]);

export function decideAutonomy(input: {
  profile: AutonomyProfile;
  tool: string;
  action: string;
  scope: string;
  missionId?: string;
  reason?: string;
  inIsolatedWorktree?: boolean;
}): AutonomyDecision {
  if (!getFeatureFlagRegistry().isEnabled(FEATURE_FLAG_IDS.autonomyProfiles)) {
    return autonomyDecisionSchema.parse({
      action: input.action,
      reason: 'autonomy profiles disabled — fail closed',
      tool: input.tool,
      scope: input.scope,
      missionId: input.missionId,
      profile: input.profile,
      result: 'deny',
      effectMayHaveCommitted: false,
    });
  }

  const effectful = WRITE_TOOLS.has(input.tool) || input.action.includes('write');
  let result: AutonomyDecision['result'] = 'allow';

  switch (input.profile) {
    case 'Inspect':
      result = effectful ? 'deny' : 'allow';
      break;
    case 'Edit':
      result = effectful ? 'confirm' : 'allow';
      break;
    case 'Autonomous':
      result = input.inIsolatedWorktree || !effectful ? 'allow' : 'deny';
      break;
    case 'Custom':
      result = 'confirm';
      break;
  }

  return autonomyDecisionSchema.parse({
    action: input.action,
    reason:
      input.reason ??
      (result === 'deny'
        ? `profile ${input.profile} blocks ${input.tool}`
        : result === 'confirm'
          ? `profile ${input.profile} requires confirmation`
          : `profile ${input.profile} allows ${input.tool}`),
    tool: input.tool,
    scope: input.scope,
    missionId: input.missionId,
    profile: input.profile,
    result,
    effectMayHaveCommitted: false,
  });
}
