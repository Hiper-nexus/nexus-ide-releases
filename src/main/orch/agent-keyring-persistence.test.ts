import Database from 'better-sqlite3';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { NEXUS_ATTESTATION_KIND } from '../../shared/agent-attestation';
import {
  agentKeyringRegistry,
  ensurePersistentAgentIdentity,
  hydrateMissionKeyring,
  missionHasIdentityMaterial,
  revokePersistentOwner,
  setAgentKeyringVaultForTests,
} from './agent-keyring-persistence';
import {
  assertStoredHandoffAgentAttestation,
  ensureRerouteTargetAgentIdentity,
  gateHandoffAttestation,
} from './agent-attestation-gate';
import { replaceOrchSettings } from '../persistence/settings-store';

const IDENTITY_SCHEMA = `
CREATE TABLE mission_agent_identity (
  mission_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'agent')),
  identity_id TEXT NOT NULL,
  public_key_hex TEXT NOT NULL CHECK (length(public_key_hex) = 64),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= 0),
  PRIMARY KEY (mission_id, role, identity_id)
);
CREATE TABLE mission_agent_attestations (
  mission_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  owner_pubkey TEXT NOT NULL CHECK (length(owner_pubkey) = 64),
  agent_pubkey TEXT NOT NULL CHECK (length(agent_pubkey) = 64),
  conditions TEXT NOT NULL,
  credential_json TEXT NOT NULL,
  issued_at INTEGER NOT NULL CHECK (issued_at >= 0),
  PRIMARY KEY (mission_id, owner_pubkey, credential_json)
);
CREATE TABLE mission_agent_revocations (
  mission_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  owner_pubkey TEXT NOT NULL CHECK (length(owner_pubkey) = 64),
  revoked_at INTEGER NOT NULL CHECK (revoked_at >= 0),
  PRIMARY KEY (mission_id, owner_id)
);
`;

describe('agent-keyring-persistence', () => {
  let db: Database.Database;
  const vault = new Map<string, string>();

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(IDENTITY_SCHEMA);
    agentKeyringRegistry.dropMission('mission-a');
    setAgentKeyringVaultForTests({
      getSecret: (key) => vault.get(key) ?? null,
      setSecret: (key, value) => {
        vault.set(key, value);
        return { ok: true };
      },
      deleteSecret: (key) => {
        vault.delete(key);
        return { ok: true };
      },
    });
    replaceOrchSettings({ agentAttestationGate: 'required' });
  });

  afterEach(() => {
    db.close();
    vault.clear();
    setAgentKeyringVaultForTests(null);
  });

  it('persists keys and rehydrates after registry drop', () => {
    const now = Math.floor(Date.now() / 1000);
    const issued = ensurePersistentAgentIdentity(db, agentKeyringRegistry, {
      missionId: 'mission-a',
      ownerId: 'owner-1',
      agentId: 'worker-1',
      kind: NEXUS_ATTESTATION_KIND.handoff,
      createdAt: now - 1,
      expiresAt: now + 3600,
    });
    expect(missionHasIdentityMaterial(db, 'mission-a')).toBe(true);
    agentKeyringRegistry.dropMission('mission-a');
    const ring = hydrateMissionKeyring(db, agentKeyringRegistry, 'mission-a');
    const verified = ring.verifyIssuedAttestation(issued.credential, 'worker-1', {
      kind: NEXUS_ATTESTATION_KIND.handoff,
      at: now,
    });
    expect(verified.accepted).toBe(true);
  });

  it('revocation fails closed at the gate', () => {
    const now = Math.floor(Date.now() / 1000);
    const issued = ensurePersistentAgentIdentity(db, agentKeyringRegistry, {
      missionId: 'mission-a',
      ownerId: 'owner-1',
      agentId: 'worker-1',
      kind: NEXUS_ATTESTATION_KIND.handoff,
      createdAt: now - 1,
      expiresAt: now + 3600,
    });
    revokePersistentOwner(db, agentKeyringRegistry, 'mission-a', 'owner-1', now);
    const gate = gateHandoffAttestation(db, 'mission-a', {
      agentId: 'worker-1',
      credential: issued.credential,
      at: now,
      kind: NEXUS_ATTESTATION_KIND.handoff,
    });
    expect(gate.required).toBe(true);
    if (gate.required) expect(gate.accepted).toBe(false);
  });

  it('rejects tampered credential at gate', () => {
    const now = Math.floor(Date.now() / 1000);
    const issued = ensurePersistentAgentIdentity(db, agentKeyringRegistry, {
      missionId: 'mission-a',
      ownerId: 'owner-1',
      agentId: 'worker-1',
      kind: NEXUS_ATTESTATION_KIND.handoff,
      createdAt: now - 1,
      expiresAt: now + 3600,
    });
    const tampered = [
      issued.credential[0],
      issued.credential[1],
      issued.credential[2],
      `${issued.credential[3].slice(0, -2)}ff`,
    ] as typeof issued.credential;
    const gate = gateHandoffAttestation(db, 'mission-a', {
      agentId: 'worker-1',
      credential: tampered,
      at: now,
    });
    expect(gate.required).toBe(true);
    if (gate.required) expect(gate.accepted).toBe(false);
  });

  it('prepares a reroute target in Main and accepts only the persisted receipt binding', () => {
    const now = Math.floor(Date.now() / 1000);
    const issued = ensurePersistentAgentIdentity(db, agentKeyringRegistry, {
      missionId: 'mission-a',
      ownerId: 'owner-1',
      agentId: 'worker-1',
      kind: NEXUS_ATTESTATION_KIND.handoff,
      createdAt: now - 1,
      expiresAt: now + 3600,
    });

    ensureRerouteTargetAgentIdentity(db, 'mission-a', 'worker-2', now);
    expect(
      db
        .prepare(
          `SELECT identity_id FROM mission_agent_identity
           WHERE mission_id = ? AND role = 'agent' AND identity_id = ?`,
        )
        .get('mission-a', 'worker-2'),
    ).toEqual({ identity_id: 'worker-2' });

    expect(() =>
      assertStoredHandoffAgentAttestation(db, 'mission-a', 'worker-1', {
        agentPubkey: issued.agentPubkey,
        ownerPubkey: issued.ownerPubkey,
        attestationJson: JSON.stringify(issued.credential),
      }),
    ).not.toThrow();
    expect(() =>
      assertStoredHandoffAgentAttestation(db, 'mission-a', 'worker-1', {
        agentPubkey: issued.agentPubkey,
        ownerPubkey: issued.ownerPubkey,
        attestationJson: JSON.stringify([
          issued.credential[0],
          issued.credential[1],
          issued.credential[2],
          `${issued.credential[3].slice(0, -2)}ff`,
        ]),
      }),
    ).toThrow(/attestation|atestação/i);
  });
});
