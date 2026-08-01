import { describe, expect, it } from 'vitest';
import {
  AGENT_AUTH_DOMAIN,
  attestationPreimage,
  createAttestation,
  ed25519KeypairFromSeed,
  generateEd25519Keypair,
  parseConditions,
  verifyAttestation,
  type AgentAttestation,
} from './agent-attestation';
import { createHash } from 'node:crypto';

/**
 * Fixtures ported from block/buzz docs/nips/NIP-OA.md (Test Vectors +
 * Invalid Test Vectors) and crates/buzz-sdk/src/nip_oa.rs test module,
 * adapted to ed25519 and the `nexus:agent-auth:` domain separator.
 *
 * The spec's secp256k1 vector cannot be reused byte-for-byte (different
 * curve), so the golden values below were generated once from the same
 * deterministic seed scheme the spec uses (owner seed ...01, agent seed
 * ...02) and pinned. Ed25519 signatures are deterministic (RFC 8032), so
 * the signature itself is a stable golden value.
 */

const ownerSeed = Buffer.alloc(32);
ownerSeed[31] = 1;
const agentSeed = Buffer.alloc(32);
agentSeed[31] = 2;

const OWNER_PUBKEY_HEX =
  '4cb5abf6ad79fbf5abbccafcc269d85cd2651ed4b885b5869f241aedf0a5ba29';
const AGENT_PUBKEY_HEX =
  '7422b9887598068e32c4448a949adb290d0f4e35b9e01b0ee5f1a1e600fe2674';
const CONDITIONS = 'kind=1&created_at<1713957000';
const GOLDEN_PREIMAGE = `nexus:agent-auth:${AGENT_PUBKEY_HEX}:${CONDITIONS}`;
const GOLDEN_SHA256 =
  '4028a7308d64d99109624f7a3d02f64b14a3508a6743de9ede323a458690255b';
const GOLDEN_SIG =
  '4b9e5efce1386e08dfcf92adac665469af3a640b2981f9ffc78b17b6577b58d6a536f5dc481b71d906ae7e03e1b553f7574b1406d4ae28b8a2c1a954dba87100';

function reasonOf(result: ReturnType<typeof verifyAttestation>): string {
  if (result.accepted) throw new Error('expected rejection, got acceptance');
  return result.reason;
}

describe('agent-attestation golden vectors (spec seeds, ed25519 adaptation)', () => {
  it('derives the pinned pubkeys from the spec seed scheme', () => {
    expect(ed25519KeypairFromSeed(ownerSeed).publicKeyHex).toBe(
      OWNER_PUBKEY_HEX,
    );
    expect(ed25519KeypairFromSeed(agentSeed).publicKeyHex).toBe(
      AGENT_PUBKEY_HEX,
    );
  });

  it('builds the exact spec preimage shape with the nexus domain separator', () => {
    expect(AGENT_AUTH_DOMAIN).toBe('nexus:agent-auth:');
    const preimage = attestationPreimage(AGENT_PUBKEY_HEX, CONDITIONS);
    expect(preimage).toBe(GOLDEN_PREIMAGE);
    expect(createHash('sha256').update(preimage, 'utf8').digest('hex')).toBe(
      GOLDEN_SHA256,
    );
  });

  it('produces the pinned deterministic signature and a spec-shaped credential', () => {
    const owner = ed25519KeypairFromSeed(ownerSeed);
    const credential = createAttestation(
      owner.privateKey,
      AGENT_PUBKEY_HEX,
      CONDITIONS,
    );
    expect(credential).toEqual([
      'auth',
      OWNER_PUBKEY_HEX,
      CONDITIONS,
      GOLDEN_SIG,
    ]);
  });

  it('verifies the pinned golden credential', () => {
    const credential: AgentAttestation = [
      'auth',
      OWNER_PUBKEY_HEX,
      CONDITIONS,
      GOLDEN_SIG,
    ];
    // Spec signed-event example: created_at 1713956400 < 1713957000, kind 1.
    const result = verifyAttestation(credential, AGENT_PUBKEY_HEX, {
      kind: 1,
      at: 1713956400,
    });
    expect(result).toEqual({ accepted: true, ownerPubkey: OWNER_PUBKEY_HEX });
  });
});

describe('createAttestation / verifyAttestation round trips', () => {
  it('sign-then-verify round trip with generated keys (nip_oa.rs round-trip fixture)', () => {
    const owner = generateEd25519Keypair();
    const agent = generateEd25519Keypair();
    const credential = createAttestation(
      owner.privateKey,
      agent.publicKeyHex,
      'kind=9',
    );
    const result = verifyAttestation(credential, agent.publicKeyHex, {
      kind: 9,
    });
    expect(result).toEqual({
      accepted: true,
      ownerPubkey: owner.publicKeyHex,
    });
  });

  it('empty conditions are valid and impose no constraints (nip_oa.rs empty-conditions fixture)', () => {
    const owner = generateEd25519Keypair();
    const agent = generateEd25519Keypair();
    const credential = createAttestation(owner.privateKey, agent.publicKeyHex, '');
    // No context at all: nothing to evaluate.
    expect(verifyAttestation(credential, agent.publicKeyHex).accepted).toBe(
      true,
    );
  });

  it('an attestation is a reusable capability: verifies repeatedly while conditions hold', () => {
    const owner = generateEd25519Keypair();
    const agent = generateEd25519Keypair();
    const credential = createAttestation(
      owner.privateKey,
      agent.publicKeyHex,
      'created_at<100',
    );
    expect(
      verifyAttestation(credential, agent.publicKeyHex, { at: 10 }).accepted,
    ).toBe(true);
    expect(
      verifyAttestation(credential, agent.publicKeyHex, { at: 99 }).accepted,
    ).toBe(true);
  });
});

describe('condition evaluation rejections', () => {
  const owner = generateEd25519Keypair();
  const agent = generateEd25519Keypair();

  it('expired attestation (created_at< not satisfied) is rejected', () => {
    const credential = createAttestation(
      owner.privateKey,
      agent.publicKeyHex,
      'created_at<1713957000',
    );
    const atBoundary = verifyAttestation(credential, agent.publicKeyHex, {
      at: 1713957000, // spec: strict <, equality fails
    });
    expect(reasonOf(atBoundary)).toBe('expired');
    const after = verifyAttestation(credential, agent.publicKeyHex, {
      at: 1713957001,
    });
    expect(reasonOf(after)).toBe('expired');
  });

  it('not-yet-active attestation (created_at> not satisfied) is rejected', () => {
    const credential = createAttestation(
      owner.privateKey,
      agent.publicKeyHex,
      'created_at>1000',
    );
    const result = verifyAttestation(credential, agent.publicKeyHex, {
      at: 1000, // strict >, equality fails
    });
    expect(reasonOf(result)).toBe('not-yet-active');
  });

  it('wrong kind is rejected', () => {
    const credential = createAttestation(
      owner.privateKey,
      agent.publicKeyHex,
      'kind=1',
    );
    const result = verifyAttestation(credential, agent.publicKeyHex, {
      kind: 2,
    });
    expect(reasonOf(result)).toBe('kind-mismatch');
  });

  it('a clause that cannot be evaluated for lack of context is rejected, not skipped', () => {
    const credential = createAttestation(
      owner.privateKey,
      agent.publicKeyHex,
      'kind=1&created_at<100',
    );
    // Spec: verifiers MUST evaluate every clause.
    expect(reasonOf(verifyAttestation(credential, agent.publicKeyHex))).toBe(
      'missing-context',
    );
    expect(
      reasonOf(
        verifyAttestation(credential, agent.publicKeyHex, { kind: 1 }),
      ),
    ).toBe('missing-context');
  });

  it('clauses are evaluated in order: first failing clause names the reason', () => {
    const credential = createAttestation(
      owner.privateKey,
      agent.publicKeyHex,
      'kind=1&created_at<100',
    );
    const result = verifyAttestation(credential, agent.publicKeyHex, {
      kind: 2,
      at: 500,
    });
    expect(reasonOf(result)).toBe('kind-mismatch');
  });
});

describe('self-attestation rejection (spec invalid vector)', () => {
  it('createAttestation throws when owner == agent', () => {
    const keys = generateEd25519Keypair();
    expect(() =>
      createAttestation(keys.privateKey, keys.publicKeyHex, 'kind=9'),
    ).toThrow(/self-attestation/);
  });

  it('verifyAttestation rejects a crafted self-attesting credential', () => {
    const keys = generateEd25519Keypair();
    const credential: AgentAttestation = [
      'auth',
      keys.publicKeyHex,
      'kind=9',
      'a'.repeat(128),
    ];
    expect(reasonOf(verifyAttestation(credential, keys.publicKeyHex))).toBe(
      'self-attestation',
    );
  });
});

describe('signature rejections', () => {
  it("a signature from a different owner than the embedded pubkey is rejected", () => {
    const ownerA = generateEd25519Keypair();
    const ownerB = generateEd25519Keypair();
    const agent = generateEd25519Keypair();
    const signedByA = createAttestation(
      ownerA.privateKey,
      agent.publicKeyHex,
      'kind=9',
    );
    // Same sig, but claiming owner B issued it.
    const forged: AgentAttestation = [
      'auth',
      ownerB.publicKeyHex,
      signedByA[2],
      signedByA[3],
    ];
    const result = verifyAttestation(forged, agent.publicKeyHex, { kind: 9 });
    expect(reasonOf(result)).toBe('invalid-signature');
  });

  it('tampered conditions after signing are rejected', () => {
    const owner = generateEd25519Keypair();
    const agent = generateEd25519Keypair();
    const credential = createAttestation(
      owner.privateKey,
      agent.publicKeyHex,
      'kind=9',
    );
    const tampered: AgentAttestation = [
      'auth',
      credential[1],
      'kind=8',
      credential[3],
    ];
    expect(
      reasonOf(verifyAttestation(tampered, agent.publicKeyHex, { kind: 8 })),
    ).toBe('invalid-signature');
  });

  it('an attestation for one agent does not verify for another', () => {
    const owner = generateEd25519Keypair();
    const agentA = generateEd25519Keypair();
    const agentB = generateEd25519Keypair();
    const credential = createAttestation(
      owner.privateKey,
      agentA.publicKeyHex,
      'kind=9',
    );
    expect(
      reasonOf(verifyAttestation(credential, agentB.publicKeyHex, { kind: 9 })),
    ).toBe('invalid-signature');
  });
});

describe('structural rejections (spec invalid vectors)', () => {
  const owner = generateEd25519Keypair();
  const agent = generateEd25519Keypair();
  const valid = createAttestation(owner.privateKey, agent.publicKeyHex, 'kind=9');

  it('rejects non-array and wrong-arity credentials', () => {
    for (const malformed of [
      'not an array',
      null,
      undefined,
      42,
      { auth: 'x' },
      ['auth', valid[1], valid[2]], // 3 elements
      ['auth', valid[1], valid[2], valid[3], 'extra'], // 5 elements
      [],
    ]) {
      expect(reasonOf(verifyAttestation(malformed, agent.publicKeyHex))).toBe(
        'malformed-credential',
      );
    }
  });

  it('rejects a wrong tag and non-string elements', () => {
    expect(
      reasonOf(
        verifyAttestation(
          ['notauth', valid[1], valid[2], valid[3]],
          agent.publicKeyHex,
        ),
      ),
    ).toBe('malformed-credential');
    expect(
      reasonOf(
        verifyAttestation(['auth', 7, valid[2], valid[3]], agent.publicKeyHex),
      ),
    ).toBe('malformed-credential');
  });

  it('rejects malformed owner pubkeys (short, non-hex, uppercase — lowercase only)', () => {
    for (const badPk of [
      'abcd',
      'z'.repeat(64),
      valid[1].toUpperCase(),
      `A${valid[1].slice(1)}`,
    ]) {
      expect(
        reasonOf(
          verifyAttestation(
            ['auth', badPk, valid[2], valid[3]],
            agent.publicKeyHex,
          ),
        ),
      ).toBe('invalid-owner-pubkey');
    }
  });

  it('rejects malformed signatures (short, non-hex, uppercase)', () => {
    for (const badSig of ['abcd', 'z'.repeat(128), valid[3].toUpperCase()]) {
      expect(
        reasonOf(
          verifyAttestation(
            ['auth', valid[1], valid[2], badSig],
            agent.publicKeyHex,
          ),
        ),
      ).toBe('invalid-signature');
    }
  });

  it('rejects a malformed agent pubkey argument', () => {
    expect(reasonOf(verifyAttestation(valid, 'not-a-key'))).toBe(
      'invalid-agent-pubkey',
    );
    expect(
      reasonOf(verifyAttestation(valid, agent.publicKeyHex.toUpperCase())),
    ).toBe('invalid-agent-pubkey');
  });
});

describe('conditions grammar (ported from nip_oa.rs validate_conditions fixtures)', () => {
  it('accepts the valid set', () => {
    for (const conditions of [
      '',
      'kind=1',
      'kind=0',
      'kind=65535',
      'created_at<1713957000',
      'created_at>0',
      'created_at>4294967295',
      'kind=1&created_at<1713957000',
      'kind=9&created_at>100&created_at<200',
    ]) {
      expect(parseConditions(conditions).ok, conditions).toBe(true);
    }
  });

  it('rejects delimiter abuse: trailing, leading, double ampersand', () => {
    expect(parseConditions('kind=1&').ok).toBe(false);
    expect(parseConditions('&kind=1').ok).toBe(false);
    expect(parseConditions('kind=1&&created_at<100').ok).toBe(false);
  });

  it('rejects non-canonical decimals (leading zeros)', () => {
    expect(parseConditions('kind=01').ok).toBe(false);
    expect(parseConditions('created_at<01713957000').ok).toBe(false);
  });

  it('rejects any whitespace — no normalization, no tolerance', () => {
    for (const conditions of ['kind=1 ', ' kind=1', 'kind= 1', 'kind=1\t']) {
      expect(parseConditions(conditions).ok, JSON.stringify(conditions)).toBe(
        false,
      );
    }
  });

  it('rejects unknown clauses, case-sensitively', () => {
    for (const conditions of [
      'foo=1',
      'Kind=1',
      'CREATED_AT<100',
      'created_at=100',
    ]) {
      expect(parseConditions(conditions).ok, conditions).toBe(false);
    }
  });

  it('rejects out-of-range values', () => {
    expect(parseConditions('kind=65536').ok).toBe(false);
    expect(parseConditions('created_at<4294967296').ok).toBe(false);
  });

  it('rejects non-decimal and empty values', () => {
    for (const conditions of [
      'kind=abc',
      'kind=-1',
      'kind=1.0',
      'kind=',
      'created_at<',
      'created_at>',
    ]) {
      expect(parseConditions(conditions).ok, conditions).toBe(false);
    }
  });

  it('is wired into createAttestation (throws) and verifyAttestation (typed reason)', () => {
    const owner = generateEd25519Keypair();
    const agent = generateEd25519Keypair();
    expect(() =>
      createAttestation(owner.privateKey, agent.publicKeyHex, 'kind=01'),
    ).toThrow();
    const crafted: AgentAttestation = [
      'auth',
      owner.publicKeyHex,
      'kind=1&',
      'a'.repeat(128),
    ];
    expect(reasonOf(verifyAttestation(crafted, agent.publicKeyHex))).toBe(
      'invalid-conditions',
    );
  });
});
