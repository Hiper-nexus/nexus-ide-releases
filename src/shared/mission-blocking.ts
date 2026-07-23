import { z } from 'zod';
import type { MissionIntentState } from './mission-intent';

/** Why a mission is blocked: human input is required, or Nexus may recover it. */
export const missionBlockKindSchema = z.enum(['user', 'technical']);
export type MissionBlockKind = z.infer<typeof missionBlockKindSchema>;

export const missionBlockingIntentStateSchema = z.enum([
  'blocked_user',
  'blocked_technical',
]);
export type MissionBlockingIntentState = z.infer<
  typeof missionBlockingIntentStateSchema
>;

export interface MissionBlockPatch {
  readonly status: 'blocked';
  readonly intentState: MissionBlockingIntentState;
}

/** Keep mission status and its blocking classification as one typed patch. */
export function missionBlockPatch(kind: MissionBlockKind): MissionBlockPatch {
  return {
    status: 'blocked',
    intentState:
      missionBlockKindSchema.parse(kind) === 'technical'
        ? 'blocked_technical'
        : 'blocked_user',
  };
}

/** Resolve the canonical blocking projection for persisted and legacy rows. */
export function resolveMissionBlockingIntentState(input: {
  readonly status: string;
  readonly intentState?: MissionIntentState | null;
}): MissionBlockingIntentState | null {
  if (input.status === 'failed') return 'blocked_technical';
  if (input.status !== 'blocked') return null;
  if (input.intentState === 'blocked_technical') return 'blocked_technical';
  if (input.intentState === 'blocked_user') return 'blocked_user';
  return 'blocked_user';
}
