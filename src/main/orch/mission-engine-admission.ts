import { z } from 'zod';

const missionAdmissionInputSchema = z
  .object({
    hasDispatchAuthority: z.boolean(),
    hasCurrentKickoffReceipt: z.boolean(),
    orchestratorLive: z.boolean(),
  })
  .strict();

export type MissionAdmissionInput = z.infer<
  typeof missionAdmissionInputSchema
>;

export type MissionAdmissionResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code:
        | 'authority-missing'
        | 'kickoff-receipt-missing'
        | 'orchestrator-not-live';
    };

export function evaluateMissionAdmission(
  input: MissionAdmissionInput,
): MissionAdmissionResult {
  const parsed = missionAdmissionInputSchema.parse(input);
  if (!parsed.hasDispatchAuthority) {
    return { ok: false, code: 'authority-missing' };
  }
  if (!parsed.hasCurrentKickoffReceipt) {
    return { ok: false, code: 'kickoff-receipt-missing' };
  }
  if (!parsed.orchestratorLive) {
    return { ok: false, code: 'orchestrator-not-live' };
  }
  return { ok: true };
}
