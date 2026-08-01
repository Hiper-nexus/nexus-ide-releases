/**
 * Per-mission agent keyring — cryptographic agent identity (NIP-OA / NIP-AA).
 *
 * Protocol distilled from block/buzz NIP-OA (Apache-2.0), curve adapted to
 * ed25519; revocation semantics distilled from NIP-AA of the same repo: an
 * attestation is not revoked individually — the OWNER is removed, and every
 * attestation that owner ever issued falls with them, atomically.
 *
 * In-memory ring + hydrate/restore hooks for the persistence layer
 * (`agent-keyring-persistence.ts`). This module never touches the filesystem
 * or SQLite itself; private keys stay inside node:crypto KeyObjects here and
 * are serialized only by the persistence layer into the encrypted vault.
 *
 * Trust layers on verification, outermost first:
 *   1. liveness  — was this credential issued by this ring, and is its owner
 *                  still present? (revoked / unknown-attestation / unknown-agent)
 *   2. protocol  — the pure `verifyAttestation` check: structure, strict
 *                  conditions grammar, self-auth rejection, ed25519 signature,
 *                  clause evaluation against the caller-supplied context.
 *
 * Credentials are content-addressed: ed25519 is deterministic, so the same
 * (owner, agent, conditions) triple always yields the same credential, which
 * is what makes the issued-set membership check sound.
 */
import {
  createAttestation,
  generateEd25519Keypair,
  verifyAttestation,
  type AgentAttestation,
  type AttestationContext,
  type AttestationRejectionReason,
  type Ed25519Keypair,
} from '../../shared/agent-attestation';

/** A credential the ring issued, with the identities it binds. */
export interface IssuedAttestation {
  readonly credential: AgentAttestation;
  readonly ownerId: string;
  readonly ownerPubkey: string;
  readonly agentId: string;
  readonly agentPubkey: string;
  readonly conditions: string;
}

export type KeyringRejectionReason =
  | AttestationRejectionReason
  | 'revoked'
  | 'unknown-attestation'
  | 'unknown-agent';

export type KeyringAttestationVerification =
  | { readonly accepted: true; readonly ownerPubkey: string }
  | {
      readonly accepted: false;
      readonly reason: KeyringRejectionReason;
      readonly detail: string;
    };

function credentialKey(credential: AgentAttestation): string {
  return JSON.stringify(credential);
}

/** Keys and attestations for one mission. Construct via the registry. */
export class MissionAgentKeyring {
  readonly missionId: string;

  /** Owner and agent namespaces are disjoint: the same id never shares keys. */
  private readonly ownerKeys = new Map<string, Ed25519Keypair>();
  private readonly agentKeys = new Map<string, Ed25519Keypair>();
  /** ownerPubkey -> credentialKey -> issued record. */
  private readonly issuedByOwner = new Map<string, Map<string, IssuedAttestation>>();
  /** Tombstones: pubkeys of removed owners. Distinguishes revoked from never-issued. */
  private readonly revokedOwnerPubkeys = new Set<string>();
  /** Tombstones by id: a revoked owner id cannot silently mint a fresh keypair. */
  private readonly revokedOwnerIds = new Set<string>();

  constructor(missionId: string) {
    if (missionId.length === 0) {
      throw new Error('mission keyring requires a missionId');
    }
    this.missionId = missionId;
  }

  /** Generate (once) and return the owner's public key hex. */
  ensureOwner(ownerId: string): string {
    return this.ensureKeypair(this.ownerKeys, ownerId, 'owner').publicKeyHex;
  }

  /** Generate (once) and return the agent's public key hex. */
  ensureAgent(agentId: string): string {
    return this.ensureKeypair(this.agentKeys, agentId, 'agent').publicKeyHex;
  }

  /** Public key hex for a known agent, or undefined. */
  agentPubkey(agentId: string): string | undefined {
    return this.agentKeys.get(agentId)?.publicKeyHex;
  }

  /** Public key hex for a known (non-revoked) owner, or undefined. */
  ownerPubkey(ownerId: string): string | undefined {
    return this.ownerKeys.get(ownerId)?.publicKeyHex;
  }

  /**
   * Owner signs an attestation over the agent's public key under strict
   * conditions. Throws on malformed conditions (grammar is enforced at the
   * source, mirroring `compute_auth_tag`) and on issuance attempts by a
   * revoked owner identity — revocation is not survivable by reuse of the id.
   */
  issueAttestation(
    ownerId: string,
    agentId: string,
    conditions: string,
  ): IssuedAttestation {
    const existing = this.ownerKeys.get(ownerId);
    if (existing === undefined && this.revokedOwnerIds.has(ownerId)) {
      throw new Error(
        `owner ${JSON.stringify(ownerId)} was revoked; a fresh identity is required`,
      );
    }
    const owner = existing ?? this.ensureKeypair(this.ownerKeys, ownerId, 'owner');
    const agent = this.ensureKeypair(this.agentKeys, agentId, 'agent');
    const credential = createAttestation(
      owner.privateKey,
      agent.publicKeyHex,
      conditions,
    );
    const issued: IssuedAttestation = Object.freeze({
      credential,
      ownerId,
      ownerPubkey: owner.publicKeyHex,
      agentId,
      agentPubkey: agent.publicKeyHex,
      conditions,
    });
    const forOwner =
      this.issuedByOwner.get(owner.publicKeyHex) ??
      new Map<string, IssuedAttestation>();
    forOwner.set(credentialKey(credential), issued);
    this.issuedByOwner.set(owner.publicKeyHex, forOwner);
    return issued;
  }

  /**
   * Liveness check (revoked / unknown) then full protocol verification via
   * the pure shared module. Never throws for untrusted input — every failure
   * is a typed rejection.
   */
  verifyIssuedAttestation(
    credential: unknown,
    agentId: string,
    context?: AttestationContext,
  ): KeyringAttestationVerification {
    const agent = this.agentKeys.get(agentId);
    if (agent === undefined) {
      return {
        accepted: false,
        reason: 'unknown-agent',
        detail: `no keypair for agent ${JSON.stringify(agentId)} in mission ${this.missionId}`,
      };
    }
    if (
      Array.isArray(credential) &&
      credential.length === 4 &&
      credential.every((element) => typeof element === 'string')
    ) {
      const tuple = credential as unknown as AgentAttestation;
      const ownerPubkey = tuple[1];
      if (this.revokedOwnerPubkeys.has(ownerPubkey)) {
        return {
          accepted: false,
          reason: 'revoked',
          detail: `owner ${ownerPubkey} was removed; all their attestations fell with them`,
        };
      }
      if (!this.issuedByOwner.get(ownerPubkey)?.has(credentialKey(tuple))) {
        return {
          accepted: false,
          reason: 'unknown-attestation',
          detail: 'credential was never issued by this mission keyring',
        };
      }
    }
    // Structure, grammar, self-auth, signature and clause evaluation all
    // belong to the pure protocol layer (including the malformed case above
    // falling through to a typed 'malformed-credential').
    return verifyAttestation(credential, agent.publicKeyHex, context);
  }

  /**
   * NIP-AA distilled: revoke by REMOVING the owner. The owner keypair is
   * dropped, the pubkey is tombstoned, and every attestation that owner
   * issued falls in the same synchronous step. Returns how many fell.
   * Unknown owner is a no-op reporting zero.
   */
  revokeOwner(ownerId: string): number {
    const owner = this.ownerKeys.get(ownerId);
    if (owner === undefined) return 0;
    this.ownerKeys.delete(ownerId);
    this.revokedOwnerIds.add(ownerId);
    this.revokedOwnerPubkeys.add(owner.publicKeyHex);
    const dropped = this.issuedByOwner.get(owner.publicKeyHex)?.size ?? 0;
    this.issuedByOwner.delete(owner.publicKeyHex);
    return dropped;
  }

  /**
   * Restore a keypair from the encrypted vault after restart. Rejects if the
   * id is already live with a different pubkey (tamper / collision).
   */
  restoreKeypair(
    role: 'owner' | 'agent',
    identityId: string,
    keypair: Ed25519Keypair,
  ): void {
    if (identityId.length === 0) {
      throw new Error(`mission keyring requires a non-empty ${role} id`);
    }
    if (role === 'owner' && this.revokedOwnerIds.has(identityId)) {
      throw new Error(
        `owner ${JSON.stringify(identityId)} was revoked; cannot restore`,
      );
    }
    const store = role === 'owner' ? this.ownerKeys : this.agentKeys;
    const existing = store.get(identityId);
    if (
      existing !== undefined &&
      existing.publicKeyHex !== keypair.publicKeyHex
    ) {
      throw new Error(
        `${role} ${JSON.stringify(identityId)} already has a different keypair`,
      );
    }
    store.set(identityId, keypair);
  }

  /** Restore a revocation tombstone without a live owner keypair. */
  restoreOwnerTombstone(ownerId: string, ownerPubkey: string): void {
    if (ownerId.length === 0 || ownerPubkey.length === 0) {
      throw new Error('tombstone requires ownerId and ownerPubkey');
    }
    this.ownerKeys.delete(ownerId);
    this.revokedOwnerIds.add(ownerId);
    this.revokedOwnerPubkeys.add(ownerPubkey);
    this.issuedByOwner.delete(ownerPubkey);
  }

  /**
   * Re-index an attestation that was previously issued and persisted.
   * Does not re-sign — the credential must already be valid.
   */
  restoreIssuedAttestation(issued: IssuedAttestation): void {
    if (this.revokedOwnerPubkeys.has(issued.ownerPubkey)) {
      throw new Error('cannot restore attestation from a revoked owner');
    }
    const forOwner =
      this.issuedByOwner.get(issued.ownerPubkey) ??
      new Map<string, IssuedAttestation>();
    forOwner.set(credentialKey(issued.credential), Object.freeze({ ...issued }));
    this.issuedByOwner.set(issued.ownerPubkey, forOwner);
  }

  /** Snapshot of live (non-revoked) owner/agent public keys — never private. */
  listPublicIdentities(): ReadonlyArray<{
    readonly role: 'owner' | 'agent';
    readonly identityId: string;
    readonly publicKeyHex: string;
  }> {
    const out: Array<{
      role: 'owner' | 'agent';
      identityId: string;
      publicKeyHex: string;
    }> = [];
    for (const [identityId, key] of this.ownerKeys) {
      out.push({
        role: 'owner',
        identityId,
        publicKeyHex: key.publicKeyHex,
      });
    }
    for (const [identityId, key] of this.agentKeys) {
      out.push({
        role: 'agent',
        identityId,
        publicKeyHex: key.publicKeyHex,
      });
    }
    return out;
  }

  /**
   * Persistence-layer only: borrow the KeyObject so the vault can serialize
   * PKCS8. Callers must never log, IPC, or receipt this value.
   */
  peekKeypairForPersistence(
    role: 'owner' | 'agent',
    identityId: string,
  ): Ed25519Keypair | undefined {
    return (role === 'owner' ? this.ownerKeys : this.agentKeys).get(identityId);
  }

  private ensureKeypair(
    store: Map<string, Ed25519Keypair>,
    id: string,
    label: 'owner' | 'agent',
  ): Ed25519Keypair {
    if (id.length === 0) {
      throw new Error(`mission keyring requires a non-empty ${label} id`);
    }
    const existing = store.get(id);
    if (existing !== undefined) return existing;
    const keypair = generateEd25519Keypair();
    store.set(id, keypair);
    return keypair;
  }
}

/** Process-wide registry: one in-memory keyring per mission. */
export class AgentKeyringRegistry {
  private readonly missions = new Map<string, MissionAgentKeyring>();

  /** Get or create the mission's keyring. */
  forMission(missionId: string): MissionAgentKeyring {
    const existing = this.missions.get(missionId);
    if (existing !== undefined) return existing;
    const ring = new MissionAgentKeyring(missionId);
    this.missions.set(missionId, ring);
    return ring;
  }

  /** Forget a mission entirely: keys, attestations and tombstones. */
  dropMission(missionId: string): void {
    this.missions.delete(missionId);
  }
}
