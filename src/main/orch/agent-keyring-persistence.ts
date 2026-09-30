/**
 * Persistent agent keyring — increment 2 of cryptographic agent identity.
 *
 * Private keys live ONLY in the encrypted secrets vault
 * (`secrets-store` / `~/.nexus/secrets.enc`). Public keys, issued
 * attestations and revocation tombstones live in the project SQLite
 * (migration 030). Restart hydrates the in-memory MissionAgentKeyring from
 * both stores. Fail-closed: if the vault cannot store/load a private key,
 * issuance refuses rather than inventing an ephemeral identity that would
 * silently break verification after restart.
 */
import type { Database } from 'better-sqlite3';

import {
  exportEd25519PrivateKeyPkcs8Hex,
  importEd25519PrivateKeyPkcs8Hex,
  NEXUS_ATTESTATION_KIND,
  type AgentAttestation,
  type Ed25519Keypair,
} from '../../shared/agent-attestation';
import {
  deleteInternalSecret,
  getSecret,
  setInternalSecret,
  type SecretWriteResult,
} from '../persistence/secrets-store';
import {
  AgentKeyringRegistry,
  MissionAgentKeyring,
  type IssuedAttestation,
} from './agent-keyring';

export type SecretVault = {
  getSecret(key: string): string | null;
  setSecret(key: string, value: string): SecretWriteResult;
  deleteSecret(key: string): SecretWriteResult;
};

const defaultVault: SecretVault = {
  getSecret,
  setSecret: setInternalSecret,
  deleteSecret: deleteInternalSecret,
};

let vault: SecretVault = defaultVault;

/** Test seam — swap the vault for an in-memory map. */
export function setAgentKeyringVaultForTests(next: SecretVault | null): void {
  vault = next ?? defaultVault;
}

export function agentPrivateSecretKey(
  missionId: string,
  role: 'owner' | 'agent',
  identityId: string,
): string {
  return `agentkey:v1:${missionId}:${role}:${identityId}`;
}

export interface IdentityRow {
  readonly missionId: string;
  readonly role: 'owner' | 'agent';
  readonly identityId: string;
  readonly publicKeyHex: string;
  readonly createdAt: number;
  readonly revokedAt: number | null;
}

export interface AttestationRow {
  readonly missionId: string;
  readonly ownerId: string;
  readonly agentId: string;
  readonly ownerPubkey: string;
  readonly agentPubkey: string;
  readonly conditions: string;
  readonly credential: AgentAttestation;
  readonly issuedAt: number;
}

export interface RevocationRow {
  readonly missionId: string;
  readonly ownerId: string;
  readonly ownerPubkey: string;
  readonly revokedAt: number;
}

function assertDb(db: Database): void {
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM sqlite_master
       WHERE type = 'table' AND name = 'mission_agent_identity'`,
    )
    .get() as { ok: number } | undefined;
  if (!row) {
    throw new Error(
      'mission agent identity schema missing — apply migration 030-agent-identity',
    );
  }
}

export function persistIdentityPublic(
  db: Database,
  row: IdentityRow,
): void {
  assertDb(db);
  db.prepare(
    `INSERT INTO mission_agent_identity
       (mission_id, role, identity_id, public_key_hex, created_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(mission_id, role, identity_id) DO UPDATE SET
       public_key_hex = excluded.public_key_hex,
       revoked_at = excluded.revoked_at`,
  ).run(
    row.missionId,
    row.role,
    row.identityId,
    row.publicKeyHex,
    row.createdAt,
    row.revokedAt,
  );
}

export function persistAttestation(db: Database, row: AttestationRow): void {
  assertDb(db);
  db.prepare(
    `INSERT INTO mission_agent_attestations
       (mission_id, owner_id, agent_id, owner_pubkey, agent_pubkey,
        conditions, credential_json, issued_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(mission_id, owner_pubkey, credential_json) DO NOTHING`,
  ).run(
    row.missionId,
    row.ownerId,
    row.agentId,
    row.ownerPubkey,
    row.agentPubkey,
    row.conditions,
    JSON.stringify(row.credential),
    row.issuedAt,
  );
}

export function persistRevocation(db: Database, row: RevocationRow): void {
  assertDb(db);
  db.prepare(
    `INSERT INTO mission_agent_revocations
       (mission_id, owner_id, owner_pubkey, revoked_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(mission_id, owner_id) DO UPDATE SET
       owner_pubkey = excluded.owner_pubkey,
       revoked_at = excluded.revoked_at`,
  ).run(row.missionId, row.ownerId, row.ownerPubkey, row.revokedAt);
  db.prepare(
    `UPDATE mission_agent_identity
     SET revoked_at = ?
     WHERE mission_id = ? AND role = 'owner' AND identity_id = ?`,
  ).run(row.revokedAt, row.missionId, row.ownerId);
  db.prepare(
    `DELETE FROM mission_agent_attestations
     WHERE mission_id = ? AND owner_id = ?`,
  ).run(row.missionId, row.ownerId);
}

function storePrivateKey(
  missionId: string,
  role: 'owner' | 'agent',
  identityId: string,
  keypair: Ed25519Keypair,
): void {
  const key = agentPrivateSecretKey(missionId, role, identityId);
  const result = vault.setSecret(
    key,
    exportEd25519PrivateKeyPkcs8Hex(keypair.privateKey),
  );
  if (!result.ok) {
    throw new Error(
      `fail-closed: cannot persist ${role} private key (${result.error})`,
    );
  }
}

function loadPrivateKey(
  missionId: string,
  role: 'owner' | 'agent',
  identityId: string,
  expectedPubkey: string,
): Ed25519Keypair {
  const key = agentPrivateSecretKey(missionId, role, identityId);
  const hex = vault.getSecret(key);
  if (!hex) {
    throw new Error(
      `fail-closed: missing vault private key for ${role} ${identityId}`,
    );
  }
  const keypair = importEd25519PrivateKeyPkcs8Hex(hex);
  if (keypair.publicKeyHex !== expectedPubkey) {
    throw new Error(
      `fail-closed: vault private key for ${role} ${identityId} does not match persisted public key`,
    );
  }
  return keypair;
}

/**
 * Hydrate (or create) the in-memory ring from SQLite + vault. Public rows
 * without a matching vault private key fail closed.
 */
export function hydrateMissionKeyring(
  db: Database,
  registry: AgentKeyringRegistry,
  missionId: string,
): MissionAgentKeyring {
  assertDb(db);
  registry.dropMission(missionId);
  const ring = registry.forMission(missionId);

  const identities = db
    .prepare(
      `SELECT role, identity_id, public_key_hex, revoked_at
       FROM mission_agent_identity
       WHERE mission_id = ?`,
    )
    .all(missionId) as Array<{
    role: 'owner' | 'agent';
    identity_id: string;
    public_key_hex: string;
    revoked_at: number | null;
  }>;

  for (const row of identities) {
    if (row.role === 'owner' && row.revoked_at !== null) {
      continue;
    }
    const keypair = loadPrivateKey(
      missionId,
      row.role,
      row.identity_id,
      row.public_key_hex,
    );
    ring.restoreKeypair(row.role, row.identity_id, keypair);
  }

  const revocations = db
    .prepare(
      `SELECT owner_id, owner_pubkey
       FROM mission_agent_revocations
       WHERE mission_id = ?`,
    )
    .all(missionId) as Array<{ owner_id: string; owner_pubkey: string }>;
  for (const row of revocations) {
    ring.restoreOwnerTombstone(row.owner_id, row.owner_pubkey);
  }

  const attestations = db
    .prepare(
      `SELECT owner_id, agent_id, owner_pubkey, agent_pubkey,
              conditions, credential_json
       FROM mission_agent_attestations
       WHERE mission_id = ?`,
    )
    .all(missionId) as Array<{
    owner_id: string;
    agent_id: string;
    owner_pubkey: string;
    agent_pubkey: string;
    conditions: string;
    credential_json: string;
  }>;
  for (const row of attestations) {
    const credential = JSON.parse(row.credential_json) as AgentAttestation;
    ring.restoreIssuedAttestation({
      credential,
      ownerId: row.owner_id,
      ownerPubkey: row.owner_pubkey,
      agentId: row.agent_id,
      agentPubkey: row.agent_pubkey,
      conditions: row.conditions,
    });
  }

  return ring;
}

/**
 * Ensure owner/agent keys exist, persist them, and issue a scoped attestation.
 * Used at mission spawn / kickoff.
 */
export function ensurePersistentAgentIdentity(
  db: Database,
  registry: AgentKeyringRegistry,
  input: {
    readonly missionId: string;
    readonly ownerId: string;
    readonly agentId: string;
    readonly kind: number;
    readonly createdAt: number;
    readonly expiresAt: number;
  },
): IssuedAttestation {
  assertDb(db);
  const ring = registry.forMission(input.missionId);

  ensureAndPersistKey(
    db,
    ring,
    input.missionId,
    'owner',
    input.ownerId,
    input.createdAt,
  );
  ensureAndPersistKey(
    db,
    ring,
    input.missionId,
    'agent',
    input.agentId,
    input.createdAt,
  );

  const conditions =
    `kind=${input.kind}` +
    `&created_at>${input.createdAt}` +
    `&created_at<${input.expiresAt}`;
  const issued = ring.issueAttestation(
    input.ownerId,
    input.agentId,
    conditions,
  );
  persistAttestation(db, {
    missionId: input.missionId,
    ownerId: issued.ownerId,
    agentId: issued.agentId,
    ownerPubkey: issued.ownerPubkey,
    agentPubkey: issued.agentPubkey,
    conditions: issued.conditions,
    credential: issued.credential,
    issuedAt: input.createdAt,
  });
  return issued;
}

function materializeKeypair(
  ring: MissionAgentKeyring,
  role: 'owner' | 'agent',
  identityId: string,
): Ed25519Keypair {
  if (role === 'owner') {
    ring.ensureOwner(identityId);
  } else {
    ring.ensureAgent(identityId);
  }
  // Re-export via vault path: issueAttestation already has the KeyObject;
  // we need the private half for vault write. Generate was just done — pull
  // by exporting through a one-shot attestation of empty conditions is wrong.
  // Instead: ensure* returns pubkey; we re-derive by restore cycle:
  // Call ensure, then the ring holds the key. Expose peek via list + we need
  // private. Add getKeypairForPersistence on the ring.
  const peeked = ring.peekKeypairForPersistence(role, identityId);
  if (!peeked) {
    throw new Error(`failed to materialize ${role} keypair`);
  }
  return peeked;
}

function ensureAndPersistKey(
  db: Database,
  ring: MissionAgentKeyring,
  missionId: string,
  role: 'owner' | 'agent',
  identityId: string,
  createdAt: number,
): string {
  const existingPub =
    role === 'owner'
      ? ring.ownerPubkey(identityId)
      : ring.agentPubkey(identityId);
  if (existingPub) {
    // Ensure vault copy exists (idempotent re-persist for safety).
    const peeked = ring.peekKeypairForPersistence(role, identityId);
    if (peeked) storePrivateKey(missionId, role, identityId, peeked);
    return existingPub;
  }

  const row = db
    .prepare(
      `SELECT public_key_hex, revoked_at FROM mission_agent_identity
       WHERE mission_id = ? AND role = ? AND identity_id = ?`,
    )
    .get(missionId, role, identityId) as
    | { public_key_hex: string; revoked_at: number | null }
    | undefined;
  if (row) {
    if (row.revoked_at !== null) {
      throw new Error(
        `${role} ${identityId} was revoked; a fresh identity is required`,
      );
    }
    const keypair = loadPrivateKey(
      missionId,
      role,
      identityId,
      row.public_key_hex,
    );
    ring.restoreKeypair(role, identityId, keypair);
    return keypair.publicKeyHex;
  }

  const keypair = materializeKeypair(ring, role, identityId);
  storePrivateKey(missionId, role, identityId, keypair);
  persistIdentityPublic(db, {
    missionId,
    role,
    identityId,
    publicKeyHex: keypair.publicKeyHex,
    createdAt,
    revokedAt: null,
  });
  return keypair.publicKeyHex;
}

export function revokePersistentOwner(
  db: Database,
  registry: AgentKeyringRegistry,
  missionId: string,
  ownerId: string,
  revokedAt: number,
): number {
  assertDb(db);
  const ring = registry.forMission(missionId);
  const ownerPub = ring.ownerPubkey(ownerId);
  const dropped = ring.revokeOwner(ownerId);
  if (ownerPub) {
    persistRevocation(db, {
      missionId,
      ownerId,
      ownerPubkey: ownerPub,
      revokedAt,
    });
    vault.deleteSecret(agentPrivateSecretKey(missionId, 'owner', ownerId));
  }
  return dropped;
}

export function missionHasIdentityMaterial(
  db: Database,
  missionId: string,
): boolean {
  try {
    assertDb(db);
  } catch {
    return false;
  }
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM mission_agent_identity
       WHERE mission_id = ? AND revoked_at IS NULL LIMIT 1`,
    )
    .get(missionId) as { ok: number } | undefined;
  return Boolean(row);
}

export function defaultHandoffAttestationWindow(nowSeconds: number): {
  createdAt: number;
  expiresAt: number;
  kind: number;
} {
  return {
    kind: NEXUS_ATTESTATION_KIND.handoff,
    createdAt: Math.max(0, nowSeconds - 1),
    expiresAt: nowSeconds + 30 * 24 * 60 * 60,
  };
}

/** Process-wide registry used by production gates. */
export const agentKeyringRegistry = new AgentKeyringRegistry();
