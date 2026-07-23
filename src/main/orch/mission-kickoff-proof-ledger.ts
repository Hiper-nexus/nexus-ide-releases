import { z } from 'zod';
import {
  missionIntentContractSchema,
  missionIntentStateSchema,
  missionStatusSchema,
  type MissionIntentContract,
} from '../../shared/orch-types';
import { hasCurrentDispatchAuthority } from '../../shared/mission-intent';
import {
  ScopedStoreBinding,
  ScopedStoreCorruptionError,
} from './scoped-store';

const entityIdSchema = z.string().min(1).max(256);
const sessionIdSchema = z.string().min(1).max(256);
const intentVersionSchema = z.number().int().nonnegative().max(1_000_000);
const promptHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

const acceptanceInputSchema = z
  .object({
    missionId: entityIdSchema,
    intentVersion: intentVersionSchema,
    orchestratorSessionId: sessionIdSchema,
    promptHash: promptHashSchema,
  })
  .strict();

const acceptanceRowSchema = z
  .object({
    mission_id: entityIdSchema,
    intent_version: intentVersionSchema,
    orchestrator_session_id: sessionIdSchema,
    prompt_hash: promptHashSchema,
    accepted_at: z.number().int().nonnegative(),
  })
  .strict();

const authorityRowSchema = z
  .object({
    status: missionStatusSchema,
    description: z.string().max(65_536),
    orch_session_id: sessionIdSchema.nullable(),
    intent_state: missionIntentStateSchema,
    intent_contract_json: z.string().nullable(),
    intent_version: intentVersionSchema,
  })
  .strict();

export interface MissionKickoffAcceptance {
  readonly missionId: string;
  readonly intentVersion: number;
  readonly orchestratorSessionId: string;
  readonly promptHash: string;
  readonly acceptedAt: number;
}

export interface RecordMissionKickoffAcceptance {
  readonly missionId: string;
  readonly intentVersion: number;
  readonly orchestratorSessionId: string;
  readonly promptHash: string;
}

function acceptanceFromRow(raw: unknown): MissionKickoffAcceptance {
  let row: z.infer<typeof acceptanceRowSchema>;
  try {
    row = acceptanceRowSchema.parse(raw);
  } catch (error) {
    throw new ScopedStoreCorruptionError('mission kickoff acceptance', {
      cause: error,
    });
  }
  return Object.freeze({
    missionId: row.mission_id,
    intentVersion: row.intent_version,
    orchestratorSessionId: row.orchestrator_session_id,
    promptHash: row.prompt_hash,
    acceptedAt: row.accepted_at,
  });
}

function parseAuthority(raw: unknown): {
  readonly status: z.infer<typeof missionStatusSchema>;
  readonly description: string;
  readonly orchestratorSessionId: string | null;
  readonly intentState: z.infer<typeof missionIntentStateSchema>;
  readonly intentContract?: MissionIntentContract;
  readonly intentVersion: number;
} {
  let row: z.infer<typeof authorityRowSchema>;
  try {
    row = authorityRowSchema.parse(raw);
    const intentContract = row.intent_contract_json === null
      ? undefined
      : missionIntentContractSchema.parse(JSON.parse(row.intent_contract_json));
    return {
      status: row.status,
      description: row.description,
      orchestratorSessionId: row.orch_session_id,
      intentState: row.intent_state,
      ...(intentContract ? { intentContract } : {}),
      intentVersion: row.intent_version,
    };
  } catch (error) {
    throw new ScopedStoreCorruptionError('mission kickoff authority', {
      cause: error,
    });
  }
}

function hasExactAuthority(
  authority: ReturnType<typeof parseAuthority>,
  expected?: z.infer<typeof acceptanceInputSchema>,
): boolean {
  return (
    authority.status === 'running' &&
    authority.orchestratorSessionId !== null &&
    (!expected ||
      (
        authority.orchestratorSessionId === expected.orchestratorSessionId &&
        authority.intentVersion === expected.intentVersion
      )) &&
    hasCurrentDispatchAuthority({
      status: authority.status,
      description: authority.description,
      intentState: authority.intentState,
      intentContract: authority.intentContract,
      intentVersion: authority.intentVersion,
    })
  );
}

/**
 * Durable receipt for the finite idle→busy kickoff acceptance. The composite
 * identity deliberately fences both intent revisions and physical
 * orchestrator sessions; a restart may reuse the receipt, a rebind may not.
 */
export class MissionKickoffProofLedger {
  readonly #binding: ScopedStoreBinding;

  constructor(binding: ScopedStoreBinding) {
    this.#binding = binding;
  }

  recordAcceptance(
    rawInput: RecordMissionKickoffAcceptance,
  ): MissionKickoffAcceptance {
    const input = acceptanceInputSchema.parse(rawInput);
    const acceptedAt = this.#binding.now();
    const db = this.#binding.writeDatabase();
    const result = db.transaction(() => {
      const authorityRaw = db.prepare(
        `SELECT status, description, orch_session_id, intent_state,
                intent_contract_json, intent_version
         FROM missions WHERE id = ?`,
      ).get(input.missionId);
      if (!authorityRaw || !hasExactAuthority(parseAuthority(authorityRaw), input)) {
        throw new Error(
          'autoridade do kickoff mudou: missão, revisão ou sessão não são mais atuais',
        );
      }

      const existingRaw = db.prepare(
        `SELECT mission_id, intent_version, orchestrator_session_id,
                prompt_hash, accepted_at
         FROM mission_kickoff_acceptances
         WHERE mission_id = ? AND intent_version = ?
           AND orchestrator_session_id = ?`,
      ).get(
        input.missionId,
        input.intentVersion,
        input.orchestratorSessionId,
      );
      if (existingRaw) {
        const existing = acceptanceFromRow(existingRaw);
        if (existing.promptHash !== input.promptHash) {
          throw new Error(
            'aceite de kickoff conflitante para a mesma missão, revisão e sessão',
          );
        }
        return { acceptance: existing, changed: false };
      }

      db.prepare(
        `INSERT INTO mission_kickoff_acceptances
           (mission_id, intent_version, orchestrator_session_id,
            prompt_hash, accepted_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        input.missionId,
        input.intentVersion,
        input.orchestratorSessionId,
        input.promptHash,
        acceptedAt,
      );
      const acceptance = acceptanceFromRow({
        mission_id: input.missionId,
        intent_version: input.intentVersion,
        orchestrator_session_id: input.orchestratorSessionId,
        prompt_hash: input.promptHash,
        accepted_at: acceptedAt,
      });
      return { acceptance, changed: true };
    }).immediate();
    if (result.changed) this.#binding.emitChange();
    return result.acceptance;
  }

  hasCurrentAcceptance(rawMissionId: string): boolean {
    const missionId = entityIdSchema.parse(rawMissionId);
    const db = this.#binding.readDatabase();
    const authorityRaw = db.prepare(
      `SELECT status, description, orch_session_id, intent_state,
              intent_contract_json, intent_version
       FROM missions WHERE id = ?`,
    ).get(missionId);
    if (!authorityRaw) return false;
    const authority = parseAuthority(authorityRaw);
    if (!hasExactAuthority(authority)) return false;

    const acceptanceRaw = db.prepare(
      `SELECT mission_id, intent_version, orchestrator_session_id,
              prompt_hash, accepted_at
       FROM mission_kickoff_acceptances
       WHERE mission_id = ? AND intent_version = ?
         AND orchestrator_session_id = ?`,
    ).get(
      missionId,
      authority.intentVersion,
      authority.orchestratorSessionId,
    );
    if (!acceptanceRaw) return false;
    acceptanceFromRow(acceptanceRaw);
    return true;
  }

  hasExactCurrentAcceptance(
    rawInput: RecordMissionKickoffAcceptance,
  ): boolean {
    const input = acceptanceInputSchema.parse(rawInput);
    const db = this.#binding.readDatabase();
    const authorityRaw = db.prepare(
      `SELECT status, description, orch_session_id, intent_state,
              intent_contract_json, intent_version
       FROM missions WHERE id = ?`,
    ).get(input.missionId);
    if (!authorityRaw || !hasExactAuthority(parseAuthority(authorityRaw), input)) {
      return false;
    }
    const acceptanceRaw = db.prepare(
      `SELECT mission_id, intent_version, orchestrator_session_id,
              prompt_hash, accepted_at
       FROM mission_kickoff_acceptances
       WHERE mission_id = ? AND intent_version = ?
         AND orchestrator_session_id = ?`,
    ).get(input.missionId, input.intentVersion, input.orchestratorSessionId);
    if (!acceptanceRaw) return false;
    return acceptanceFromRow(acceptanceRaw).promptHash === input.promptHash;
  }
}
