import { describe, expect, it } from 'vitest';
import { verifyAttestation } from '../../shared/agent-attestation';
import {
  AgentKeyringRegistry,
  MissionAgentKeyring,
} from './agent-keyring';

const HEX_64 = /^[0-9a-f]{64}$/;

function reasonOf(result: { accepted: boolean; reason?: string }): string {
  if (result.accepted) throw new Error('expected rejection, got acceptance');
  return result.reason as string;
}

describe('MissionAgentKeyring key material', () => {
  it('generates one stable keypair per agent id', () => {
    const ring = new MissionAgentKeyring('mission-1');
    const first = ring.ensureAgent('worker-a');
    const again = ring.ensureAgent('worker-a');
    expect(first).toMatch(HEX_64);
    expect(again).toBe(first);
  });

  it('distinct agents and distinct owners get distinct keys', () => {
    const ring = new MissionAgentKeyring('mission-1');
    const a = ring.ensureAgent('worker-a');
    const b = ring.ensureAgent('worker-b');
    const owner = ring.ensureOwner('mission-owner');
    expect(a).not.toBe(b);
    expect(owner).not.toBe(a);
    expect(owner).not.toBe(b);
  });

  it('the same id in owner and agent namespaces yields independent keypairs (no accidental self-auth)', () => {
    const ring = new MissionAgentKeyring('mission-1');
    const ownerPub = ring.ensureOwner('dual');
    const agentPub = ring.ensureAgent('dual');
    expect(ownerPub).not.toBe(agentPub);
    const issued = ring.issueAttestation('dual', 'dual', 'kind=1');
    expect(issued.ownerPubkey).toBe(ownerPub);
    expect(issued.agentPubkey).toBe(agentPub);
  });

  it('keyrings are per mission: same agent id, different missions, different keys', () => {
    const registry = new AgentKeyringRegistry();
    const one = registry.forMission('mission-1').ensureAgent('worker-a');
    const two = registry.forMission('mission-2').ensureAgent('worker-a');
    expect(one).not.toBe(two);
  });

  it('forMission returns the same live keyring per mission id', () => {
    const registry = new AgentKeyringRegistry();
    expect(registry.forMission('m')).toBe(registry.forMission('m'));
  });
});

describe('MissionAgentKeyring attestation lifecycle', () => {
  it('issues an attestation that verifies via the keyring and via the pure protocol module', () => {
    const ring = new MissionAgentKeyring('mission-1');
    const issued = ring.issueAttestation('owner', 'worker-a', 'kind=1');
    expect(issued.credential[0]).toBe('auth');
    expect(issued.credential[1]).toBe(issued.ownerPubkey);
    expect(issued.credential[2]).toBe('kind=1');

    const viaRing = ring.verifyIssuedAttestation(issued.credential, 'worker-a', {
      kind: 1,
    });
    expect(viaRing).toEqual({
      accepted: true,
      ownerPubkey: issued.ownerPubkey,
    });

    // The credential stands on its own: pure verification, no keyring state.
    const pure = verifyAttestation(issued.credential, issued.agentPubkey, {
      kind: 1,
    });
    expect(pure.accepted).toBe(true);
  });

  it('propagates typed protocol rejections through the keyring path', () => {
    const ring = new MissionAgentKeyring('mission-1');
    const issued = ring.issueAttestation(
      'owner',
      'worker-a',
      'created_at<1000',
    );
    const expired = ring.verifyIssuedAttestation(issued.credential, 'worker-a', {
      at: 2000,
    });
    expect(reasonOf(expired)).toBe('expired');
  });

  it('rejects a credential for an agent the ring does not know', () => {
    const ring = new MissionAgentKeyring('mission-1');
    const issued = ring.issueAttestation('owner', 'worker-a', 'kind=1');
    expect(
      reasonOf(ring.verifyIssuedAttestation(issued.credential, 'ghost')),
    ).toBe('unknown-agent');
  });

  it('rejects a credential this ring never issued, even if cryptographically plausible', () => {
    const ringA = new MissionAgentKeyring('mission-1');
    const ringB = new MissionAgentKeyring('mission-2');
    const foreign = ringA.issueAttestation('owner', 'worker-a', 'kind=1');
    ringB.ensureAgent('worker-a');
    expect(
      reasonOf(ringB.verifyIssuedAttestation(foreign.credential, 'worker-a')),
    ).toBe('unknown-attestation');
  });

  it('rejects issuing under a malformed conditions string (strict grammar, fail at the source)', () => {
    const ring = new MissionAgentKeyring('mission-1');
    expect(() => ring.issueAttestation('owner', 'worker-a', 'kind=01')).toThrow();
    expect(() =>
      ring.issueAttestation('owner', 'worker-a', 'kind=1 '),
    ).toThrow();
  });
});

describe('revocation by owner removal (NIP-AA semantics)', () => {
  it('revoking an owner drops every attestation that owner issued, atomically', () => {
    const ring = new MissionAgentKeyring('mission-1');
    const one = ring.issueAttestation('owner', 'worker-a', 'kind=1');
    const two = ring.issueAttestation('owner', 'worker-b', 'kind=2');
    const three = ring.issueAttestation('owner', 'worker-a', ''); // reissue, broader

    const dropped = ring.revokeOwner('owner');
    expect(dropped).toBe(3);

    for (const [issued, agentId, context] of [
      [one, 'worker-a', { kind: 1 }],
      [two, 'worker-b', { kind: 2 }],
      [three, 'worker-a', undefined],
    ] as const) {
      expect(
        reasonOf(ring.verifyIssuedAttestation(issued.credential, agentId, context)),
      ).toBe('revoked');
    }
  });

  it('revocation is scoped to the removed owner: other owners survive', () => {
    const ring = new MissionAgentKeyring('mission-1');
    const doomed = ring.issueAttestation('owner-a', 'worker-a', 'kind=1');
    const survivor = ring.issueAttestation('owner-b', 'worker-a', 'kind=1');

    ring.revokeOwner('owner-a');

    expect(
      reasonOf(ring.verifyIssuedAttestation(doomed.credential, 'worker-a', { kind: 1 })),
    ).toBe('revoked');
    expect(
      ring.verifyIssuedAttestation(survivor.credential, 'worker-a', { kind: 1 })
        .accepted,
    ).toBe(true);
  });

  it('a revoked owner cannot issue again without a fresh identity', () => {
    const ring = new MissionAgentKeyring('mission-1');
    ring.issueAttestation('owner', 'worker-a', 'kind=1');
    ring.revokeOwner('owner');
    expect(() => ring.issueAttestation('owner', 'worker-a', 'kind=1')).toThrow(
      /revoked/,
    );
  });

  it('revoking an unknown owner is a no-op reporting zero drops', () => {
    const ring = new MissionAgentKeyring('mission-1');
    expect(ring.revokeOwner('nobody')).toBe(0);
  });

  it('dropMission forgets keys and attestations for that mission only', () => {
    const registry = new AgentKeyringRegistry();
    const before = registry.forMission('m1');
    const keep = registry.forMission('m2');
    const issued = before.issueAttestation('owner', 'worker-a', 'kind=1');
    const kept = keep.issueAttestation('owner', 'worker-a', 'kind=1');

    registry.dropMission('m1');

    const fresh = registry.forMission('m1');
    expect(fresh).not.toBe(before);
    fresh.ensureAgent('worker-a');
    expect(
      reasonOf(fresh.verifyIssuedAttestation(issued.credential, 'worker-a', { kind: 1 })),
    ).toBe('unknown-attestation');
    expect(
      keep.verifyIssuedAttestation(kept.credential, 'worker-a', { kind: 1 })
        .accepted,
    ).toBe(true);
  });
});
