/**
 * Fail-closed attestation gate for physical handoff / reroute acceptance.
 *
 * Verifies signature, scope (kind), expiry (created_at clauses), revocation
 * and issued-set membership via MissionAgentKeyring. Does NOT accept a bare
 * hash or pubkey without a verifying credential.
 */
import type { Database } from 'better-sqlite3';

import {
  NEXUS_ATTESTATION_KIND,
  type AgentAttestation,
} from '../../shared/agent-attestation';
import { getOrchSettings } from '../persistence/settings-store';
import {
  agentKeyringRegistry,
  defaultHandoffAttestationWindow,
  ensurePersistentAgentIdentity,
  hydrateMissionKeyring,
  missionHasIdentityMaterial,
} from './agent-keyring-persistence';
import type { KeyringAttestationVerification } from './agent-keyring';

export interface AgentAttestationProof {
  readonly agentId: string;
  readonly credential: AgentAttestation;
  /** Caller-supplied timestamp for created_at clause evaluation (unix seconds). */
  readonly at: number;
  readonly kind?: number;
}

export type AttestationGateResult =
  | {
      readonly required: false;
    }
  | {
      readonly required: true;
      readonly accepted: true;
      readonly ownerPubkey: string;
      readonly agentPubkey: string;
      readonly credential: AgentAttestation;
      readonly agentId: string;
    }
  | {
      readonly required: true;
      readonly accepted: false;
      readonly reason: string;
      readonly detail: string;
    };

function isAttestationTuple(value: unknown): value is AgentAttestation {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value[0] === 'auth' &&
    typeof value[1] === 'string' &&
    typeof value[2] === 'string' &&
    typeof value[3] === 'string'
  );
}

/**
 * Parse untrusted MCP/IPC proof. Malformed input becomes a typed rejection
 * at the gate — never a throw that looks like a programmer error.
 */
export function parseAgentAttestationProof(
  raw: unknown,
):
  | { ok: true; proof: AgentAttestationProof }
  | { ok: false; detail: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, detail: 'agentAttestation must be an object' };
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.agentId !== 'string' || record.agentId.length === 0) {
    return { ok: false, detail: 'agentAttestation.agentId is required' };
  }
  if (!isAttestationTuple(record.credential)) {
    return {
      ok: false,
      detail: 'agentAttestation.credential must be ["auth", owner, conditions, sig]',
    };
  }
  if (
    typeof record.at !== 'number' ||
    !Number.isFinite(record.at) ||
    record.at < 0
  ) {
    return { ok: false, detail: 'agentAttestation.at must be a non-negative number' };
  }
  const kind =
    record.kind === undefined
      ? NEXUS_ATTESTATION_KIND.handoff
      : typeof record.kind === 'number'
        ? record.kind
        : NaN;
  if (!Number.isInteger(kind) || kind < 0 || kind > 65535) {
    return { ok: false, detail: 'agentAttestation.kind is out of range' };
  }
  return {
    ok: true,
    proof: {
      agentId: record.agentId,
      credential: record.credential,
      at: Math.trunc(record.at),
      kind,
    },
  };
}

/**
 * Gate a physical handoff submit. When the mission has identity material and
 * the orch setting is `required`, a verifying proof is mandatory.
 */
export function gateHandoffAttestation(
  db: Database,
  missionId: string,
  proof: AgentAttestationProof | null,
  options: { readonly kind?: number } = {},
): AttestationGateResult {
  const settings = getOrchSettings();
  if (settings.agentAttestationGate === 'off') {
    return { required: false };
  }
  if (!missionHasIdentityMaterial(db, missionId)) {
    // Legacy / pre-identity missions: gate not armed until keys are issued.
    return { required: false };
  }

  if (!proof) {
    return {
      required: true,
      accepted: false,
      reason: 'missing-attestation',
      detail:
        'missão exige atestação de agente; apresente agentAttestation no handoff',
    };
  }

  const kind = options.kind ?? proof.kind ?? NEXUS_ATTESTATION_KIND.handoff;
  let ring;
  try {
    ring = hydrateMissionKeyring(db, agentKeyringRegistry, missionId);
  } catch (error) {
    return {
      required: true,
      accepted: false,
      reason: 'keyring-unavailable',
      detail:
        error instanceof Error
          ? error.message
          : 'não foi possível carregar o keyring da missão',
    };
  }

  const expectedAgentPubkey = ring.agentPubkey(proof.agentId);
  if (!expectedAgentPubkey) {
    return {
      required: true,
      accepted: false,
      reason: 'unknown-agent',
      detail: `agente ${JSON.stringify(proof.agentId)} sem identidade na missão`,
    };
  }

  // Wrong agent pubkey in credential vs claimed agentId is caught by verify.
  const verified: KeyringAttestationVerification = ring.verifyIssuedAttestation(
    proof.credential,
    proof.agentId,
    { kind, at: proof.at },
  );
  if (!verified.accepted) {
    return {
      required: true,
      accepted: false,
      reason: verified.reason,
      detail: verified.detail,
    };
  }

  // Owner in credential must match the accepted ownerPubkey from verify.
  if (proof.credential[1] !== verified.ownerPubkey) {
    return {
      required: true,
      accepted: false,
      reason: 'owner-mismatch',
      detail: 'owner pubkey no credential diverge da verificação',
    };
  }

  return {
    required: true,
    accepted: true,
    ownerPubkey: verified.ownerPubkey,
    agentPubkey: expectedAgentPubkey,
    credential: proof.credential,
    agentId: proof.agentId,
  };
}

export function attestationGateErrorMessage(result: AttestationGateResult): string {
  if (result.required !== true || result.accepted !== false) {
    return 'attestation gate rejected';
  }
  return `atestação rejeitada (${result.reason}): ${result.detail}`;
}

/**
 * Prepare the next physical agent before a coordinator commits a reroute.
 *
 * The worker never receives the private key or the credential. Main owns both
 * the vault and the SQLite write, so a reroute can atomically create the
 * substitute's identity and then bind the new dispatch to that identity.
 * Legacy missions without identity rows intentionally remain on the legacy
 * path; once a mission has material, this helper is fail-closed.
 */
export function ensureRerouteTargetAgentIdentity(
  db: Database,
  missionId: string,
  agentId: string,
  nowSeconds: number,
): void {
  if (
    getOrchSettings().agentAttestationGate === 'off' ||
    !missionHasIdentityMaterial(db, missionId)
  ) {
    return;
  }
  const window = defaultHandoffAttestationWindow(nowSeconds);
  ensurePersistentAgentIdentity(db, agentKeyringRegistry, {
    missionId,
    ownerId: `mission:${missionId}`,
    agentId,
    kind: window.kind,
    createdAt: window.createdAt,
    expiresAt: window.expiresAt,
  });
  const ring = hydrateMissionKeyring(db, agentKeyringRegistry, missionId);
  if (!ring.agentPubkey(agentId)) {
    throw new Error(
      `identidade criptográfica do agente ${JSON.stringify(agentId)} ` +
        'não ficou disponível para o reroute',
    );
  }
}

/**
 * Re-verify the Main-held credential persisted in a physical receipt. Merge,
 * completion and recovery paths call this independently of the original MCP
 * request, which prevents a forged/edited receipt from becoming a delivery
 * authority after restart.
 */
export function assertStoredHandoffAgentAttestation(
  db: Database,
  missionId: string,
  agentId: string,
  stored: {
    readonly agentPubkey: string | null;
    readonly ownerPubkey: string | null;
    readonly attestationJson: string | null;
  },
): void {
  if (
    getOrchSettings().agentAttestationGate === 'off' ||
    !missionHasIdentityMaterial(db, missionId)
  ) {
    return;
  }
  if (
    stored.agentPubkey === null ||
    stored.ownerPubkey === null ||
    stored.attestationJson === null
  ) {
    throw new Error(
      'physical handoff receipt lacks the Main-held agent attestation',
    );
  }
  let credential: unknown;
  try {
    credential = JSON.parse(stored.attestationJson);
  } catch {
    throw new Error('physical handoff receipt contains invalid attestation JSON');
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  const parsed = parseAgentAttestationProof({
    agentId,
    credential,
    at: nowSeconds,
    kind: NEXUS_ATTESTATION_KIND.handoff,
  });
  if (!parsed.ok) {
    throw new Error(`physical handoff attestation malformed: ${parsed.detail}`);
  }
  const gate = gateHandoffAttestation(db, missionId, parsed.proof, {
    kind: NEXUS_ATTESTATION_KIND.handoff,
  });
  if (!gate.required) return;
  if (!gate.accepted) {
    throw new Error(attestationGateErrorMessage(gate));
  }
  if (
    gate.agentPubkey !== stored.agentPubkey ||
    gate.ownerPubkey !== stored.ownerPubkey
  ) {
    throw new Error(
      'physical handoff receipt attestation keys diverge from the verified keyring',
    );
  }
}
