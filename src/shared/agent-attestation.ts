/**
 * Owner attestation for agent identities.
 *
 * Protocol distilled from block/buzz NIP-OA (Apache-2.0), curve adapted to
 * ed25519. Sources: docs/nips/NIP-OA.md and crates/buzz-sdk/src/nip_oa.rs of
 * github.com/block/buzz. License text: third_party/licenses/buzz-APACHE-2.0.txt;
 * attribution entry in THIRD_PARTY_NOTICES.md.
 *
 * DELIBERATE ADAPTATION — buzz signs with Schnorr BIP-340 over secp256k1;
 * Nexus signs with ed25519 through node:crypto (`generateKeyPairSync`,
 * `sign`, `verify`) so this module carries ZERO new dependencies (the shared
 * node_modules snapshot forbids installs). What is distilled is the PROTOCOL,
 * not the curve:
 *
 *   credential = ["auth", owner_pubkey_hex, conditions, sig_hex]
 *   preimage   = "nexus:agent-auth:" || agent_pubkey_hex || ":" || conditions
 *   message    = SHA256(preimage)          (32 bytes)
 *   sig        = ed25519(message, owner_secret_key)
 *
 * Both encodings keep the spec's wire widths: ed25519 raw public keys are 32
 * bytes (64 lowercase hex, same as BIP-340 x-only keys) and ed25519 signatures
 * are 64 bytes (128 lowercase hex, same as Schnorr). Ed25519 is deterministic
 * (RFC 8032), so a given (owner, agent, conditions) always yields the same
 * credential — which makes credentials content-addressable.
 *
 * Spec rules preserved verbatim:
 * - Conditions grammar: zero or more clauses joined by `&`; each clause is
 *   `kind=<0..65535>`, `created_at<<0..4294967295>` or
 *   `created_at><0..4294967295>`; canonical base-10 (no leading zeros except
 *   `0`); no whitespace anywhere; empty clause (leading/trailing/double `&`)
 *   rejected; unknown clause rejected; clause names case-sensitive.
 * - STRICT parsing: no normalization, no reordering, no deduplication — the
 *   exact conditions string from the credential is what gets hashed.
 * - Self-attestation (owner pubkey == agent pubkey) rejected at creation and
 *   at verification.
 * - Verifiers evaluate EVERY clause; a clause that cannot be evaluated
 *   (missing context) rejects — it is never skipped.
 * - A valid credential is a reusable capability, not an identity override:
 *   the agent key remains the author; the credential only proves the owner
 *   authorized it under the stated conditions.
 * - `created_at` clauses constrain a caller-supplied timestamp, never the
 *   verifier's wall clock (spec: verification MUST NOT depend on local time).
 *
 * Pure module: no I/O, no clock, no persistence. Key generation is stateless
 * CSPRNG; everything else is deterministic computation.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as ed25519Sign,
  verify as ed25519Verify,
  type KeyObject,
} from 'node:crypto';

/** Domain separator — the nexus analogue of buzz's `nostr:agent-auth:`. */
export const AGENT_AUTH_DOMAIN = 'nexus:agent-auth:';

/** Compact credential: `["auth", owner_pubkey_hex, conditions, sig_hex]`. */
export type AgentAttestation = readonly [
  tag: 'auth',
  ownerPubkey: string,
  conditions: string,
  sig: string,
];

/** What the verifier knows about the action being authorized. */
export interface AttestationContext {
  /** Analogue of `event.kind` — the action category being performed. */
  readonly kind?: number;
  /** Analogue of `event.created_at` — caller-supplied, never the wall clock. */
  readonly at?: number;
}

export type AttestationRejectionReason =
  | 'malformed-credential'
  | 'invalid-agent-pubkey'
  | 'invalid-owner-pubkey'
  | 'invalid-conditions'
  | 'self-attestation'
  | 'invalid-signature'
  | 'kind-mismatch'
  | 'expired'
  | 'not-yet-active'
  | 'missing-context';

export type AttestationVerification =
  | { readonly accepted: true; readonly ownerPubkey: string }
  | {
      readonly accepted: false;
      readonly reason: AttestationRejectionReason;
      readonly detail: string;
    };

export type AttestationClause =
  | { readonly type: 'kind'; readonly value: number }
  | { readonly type: 'created-before'; readonly value: number }
  | { readonly type: 'created-after'; readonly value: number };

export type ConditionsParse =
  | { readonly ok: true; readonly clauses: readonly AttestationClause[] }
  | { readonly ok: false; readonly detail: string };

/** An ed25519 keypair. The private key never leaves the KeyObject here. */
export interface Ed25519Keypair {
  /** 64-char lowercase hex of the raw 32-byte public key. */
  readonly publicKeyHex: string;
  readonly privateKey: KeyObject;
}

const KIND_MAX = 65535;
const CREATED_AT_MAX = 4294967295;
const PUBKEY_HEX_PATTERN = /^[0-9a-f]{64}$/;
const SIG_HEX_PATTERN = /^[0-9a-f]{128}$/;
const CANONICAL_DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;

/** DER prefixes for wrapping raw ed25519 key material for node:crypto. */
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const PKCS8_ED25519_PREFIX = Buffer.from(
  '302e020100300506032b657004220420',
  'hex',
);

/** Generate a fresh ed25519 keypair (stateless; CSPRNG only). */
export function generateEd25519Keypair(): Ed25519Keypair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { publicKeyHex: rawPublicKeyHex(publicKey), privateKey };
}

/**
 * Deterministic keypair from a 32-byte seed (RFC 8032). Test fixtures only —
 * production keys must come from {@link generateEd25519Keypair}.
 */
export function ed25519KeypairFromSeed(seed: Uint8Array): Ed25519Keypair {
  if (seed.length !== 32) {
    throw new Error('ed25519 seed must be exactly 32 bytes');
  }
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed)]),
    format: 'der',
    type: 'pkcs8',
  });
  return {
    publicKeyHex: rawPublicKeyHex(derivePublicKey(privateKey)),
    privateKey,
  };
}

/**
 * Export a private KeyObject as PKCS8 DER hex for the encrypted vault.
 * Never log, JSON-stringify into receipts, or send this to the renderer.
 */
export function exportEd25519PrivateKeyPkcs8Hex(privateKey: KeyObject): string {
  if (privateKey.asymmetricKeyType !== 'ed25519' || privateKey.type !== 'private') {
    throw new Error('exportEd25519PrivateKeyPkcs8Hex requires an ed25519 private KeyObject');
  }
  return Buffer.from(privateKey.export({ format: 'der', type: 'pkcs8' })).toString(
    'hex',
  );
}

/**
 * Rehydrate an ed25519 keypair from vault-stored PKCS8 DER hex.
 * Fail-closed on malformed material — never invent a replacement key here.
 */
export function importEd25519PrivateKeyPkcs8Hex(pkcs8Hex: string): Ed25519Keypair {
  if (!/^[0-9a-f]+$/i.test(pkcs8Hex) || pkcs8Hex.length % 2 !== 0) {
    throw new Error('ed25519 PKCS8 hex is malformed');
  }
  try {
    const privateKey = createPrivateKey({
      key: Buffer.from(pkcs8Hex, 'hex'),
      format: 'der',
      type: 'pkcs8',
    });
    if (privateKey.asymmetricKeyType !== 'ed25519') {
      throw new Error('not ed25519');
    }
    return {
      publicKeyHex: rawPublicKeyHex(derivePublicKey(privateKey)),
      privateKey,
    };
  } catch (error) {
    throw new Error(
      `ed25519 PKCS8 import failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Attestation action kinds used by Nexus gates (NIP-OA `kind=` clauses). */
export const NEXUS_ATTESTATION_KIND = Object.freeze({
  handoff: 1,
  reroute: 2,
  spawn: 3,
} as const);

function rawPublicKeyHex(publicKey: KeyObject): string {
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return Buffer.from(spki.subarray(spki.length - 32)).toString('hex');
}

/**
 * node:crypto derives the public half from a private KeyObject at runtime;
 * the bundled @types/node predates that overload, hence the narrow cast.
 */
function derivePublicKey(privateKey: KeyObject): KeyObject {
  return createPublicKey(
    privateKey as unknown as Parameters<typeof createPublicKey>[0],
  );
}

function publicKeyFromHex(pubkeyHex: string): KeyObject {
  return createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(pubkeyHex, 'hex')]),
    format: 'der',
    type: 'spki',
  });
}

/**
 * The exact signing preimage. The conditions string travels verbatim —
 * reordering, deduplicating or normalizing it changes the message and is
 * forbidden by the spec.
 */
export function attestationPreimage(
  agentPubkeyHex: string,
  conditions: string,
): string {
  return `${AGENT_AUTH_DOMAIN}${agentPubkeyHex}:${conditions}`;
}

function attestationMessage(agentPubkeyHex: string, conditions: string): Buffer {
  return createHash('sha256')
    .update(attestationPreimage(agentPubkeyHex, conditions), 'utf8')
    .digest();
}

function parseCanonicalDecimal(
  raw: string,
  max: number,
  label: string,
): { ok: true; value: number } | { ok: false; detail: string } {
  if (raw.length === 0) {
    return { ok: false, detail: `${label} value must not be empty` };
  }
  if (!CANONICAL_DECIMAL_PATTERN.test(raw)) {
    return {
      ok: false,
      detail: `${label} value is not a canonical decimal: ${JSON.stringify(raw)}`,
    };
  }
  const value = Number(raw);
  if (value > max) {
    return { ok: false, detail: `${label} value ${raw} out of range [0, ${max}]` };
  }
  return { ok: true, value };
}

function parseClause(
  clause: string,
): { ok: true; clause: AttestationClause } | { ok: false; detail: string } {
  if (clause.startsWith('kind=')) {
    const parsed = parseCanonicalDecimal(clause.slice(5), KIND_MAX, 'kind');
    if (!parsed.ok) return parsed;
    return { ok: true, clause: { type: 'kind', value: parsed.value } };
  }
  if (clause.startsWith('created_at<')) {
    const parsed = parseCanonicalDecimal(
      clause.slice(11),
      CREATED_AT_MAX,
      'created_at<',
    );
    if (!parsed.ok) return parsed;
    return { ok: true, clause: { type: 'created-before', value: parsed.value } };
  }
  if (clause.startsWith('created_at>')) {
    const parsed = parseCanonicalDecimal(
      clause.slice(11),
      CREATED_AT_MAX,
      'created_at>',
    );
    if (!parsed.ok) return parsed;
    return { ok: true, clause: { type: 'created-after', value: parsed.value } };
  }
  return { ok: false, detail: `unsupported clause: ${JSON.stringify(clause)}` };
}

/**
 * STRICT conditions parsing per the spec: empty string is valid and imposes
 * nothing; otherwise `clause` or `clause&clause&...`; whitespace anywhere,
 * empty clauses (delimiter abuse), unknown clause names (case-sensitive),
 * non-canonical decimals and out-of-range values are all rejections. No
 * normalization of any kind.
 */
export function parseConditions(conditions: string): ConditionsParse {
  if (conditions.length === 0) return { ok: true, clauses: [] };
  if (/\s/u.test(conditions)) {
    return { ok: false, detail: 'conditions must not contain whitespace' };
  }
  const clauses: AttestationClause[] = [];
  for (const clause of conditions.split('&')) {
    if (clause.length === 0) {
      return {
        ok: false,
        detail: "empty clause in conditions (leading/trailing/double '&')",
      };
    }
    const parsed = parseClause(clause);
    if (!parsed.ok) return { ok: false, detail: parsed.detail };
    clauses.push(parsed.clause);
  }
  return { ok: true, clauses };
}

/**
 * Evaluate every clause against the context, in order. The first clause that
 * fails names the rejection. A clause whose context value is absent rejects
 * with `missing-context` — the spec forbids skipping clauses.
 */
function evaluateClauses(
  clauses: readonly AttestationClause[],
  context: AttestationContext,
):
  | { readonly satisfied: true }
  | {
      readonly satisfied: false;
      readonly reason: 'kind-mismatch' | 'expired' | 'not-yet-active' | 'missing-context';
      readonly detail: string;
    } {
  for (const clause of clauses) {
    switch (clause.type) {
      case 'kind': {
        if (context.kind === undefined) {
          return {
            satisfied: false,
            reason: 'missing-context',
            detail: `clause kind=${clause.value} requires context.kind`,
          };
        }
        if (context.kind !== clause.value) {
          return {
            satisfied: false,
            reason: 'kind-mismatch',
            detail: `clause kind=${clause.value} not satisfied by kind ${context.kind}`,
          };
        }
        break;
      }
      case 'created-before': {
        if (context.at === undefined) {
          return {
            satisfied: false,
            reason: 'missing-context',
            detail: `clause created_at<${clause.value} requires context.at`,
          };
        }
        if (!(context.at < clause.value)) {
          return {
            satisfied: false,
            reason: 'expired',
            detail: `clause created_at<${clause.value} not satisfied by at=${context.at}`,
          };
        }
        break;
      }
      case 'created-after': {
        if (context.at === undefined) {
          return {
            satisfied: false,
            reason: 'missing-context',
            detail: `clause created_at>${clause.value} requires context.at`,
          };
        }
        if (!(context.at > clause.value)) {
          return {
            satisfied: false,
            reason: 'not-yet-active',
            detail: `clause created_at>${clause.value} not satisfied by at=${context.at}`,
          };
        }
        break;
      }
    }
  }
  return { satisfied: true };
}

/**
 * Sign an attestation: the owner authorizes `agentPubkeyHex` under
 * `conditions`. Throws on invalid inputs (creation is a programming boundary;
 * verification is where typed rejection lives).
 */
export function createAttestation(
  ownerPrivKey: KeyObject,
  agentPubkeyHex: string,
  conditions: string,
): AgentAttestation {
  if (!PUBKEY_HEX_PATTERN.test(agentPubkeyHex)) {
    throw new Error(
      'agent pubkey must be 64 lowercase hex chars (raw ed25519 public key)',
    );
  }
  const parsed = parseConditions(conditions);
  if (!parsed.ok) {
    throw new Error(`invalid conditions: ${parsed.detail}`);
  }
  const ownerPubkeyHex = rawPublicKeyHex(derivePublicKey(ownerPrivKey));
  if (ownerPubkeyHex === agentPubkeyHex) {
    throw new Error(
      'owner and agent pubkeys must differ (self-attestation rejected)',
    );
  }
  const sig = ed25519Sign(
    null,
    attestationMessage(agentPubkeyHex, conditions),
    ownerPrivKey,
  );
  return ['auth', ownerPubkeyHex, conditions, sig.toString('hex')];
}

/**
 * Verify a credential against an agent public key and an optional context.
 *
 * Rejection precedence (structure before crypto before semantics):
 * malformed-credential → invalid-agent-pubkey → invalid-owner-pubkey →
 * invalid-conditions → self-attestation → invalid-signature → clause
 * evaluation (kind-mismatch / expired / not-yet-active / missing-context).
 *
 * The input is `unknown` on purpose — credentials arrive from persistence and
 * IPC boundaries and are never trusted structurally.
 */
export function verifyAttestation(
  credential: unknown,
  agentPubkeyHex: string,
  context: AttestationContext = {},
): AttestationVerification {
  if (
    !Array.isArray(credential) ||
    credential.length !== 4 ||
    !credential.every((element) => typeof element === 'string') ||
    credential[0] !== 'auth'
  ) {
    return {
      accepted: false,
      reason: 'malformed-credential',
      detail: 'credential must be ["auth", owner_pubkey, conditions, sig]',
    };
  }
  const [, ownerPubkeyHex, conditions, sigHex] = credential as unknown as readonly [
    string,
    string,
    string,
    string,
  ];

  if (!PUBKEY_HEX_PATTERN.test(agentPubkeyHex)) {
    return {
      accepted: false,
      reason: 'invalid-agent-pubkey',
      detail: 'agent pubkey must be 64 lowercase hex chars',
    };
  }
  if (!PUBKEY_HEX_PATTERN.test(ownerPubkeyHex)) {
    return {
      accepted: false,
      reason: 'invalid-owner-pubkey',
      detail: 'owner pubkey must be 64 lowercase hex chars',
    };
  }
  const parsed = parseConditions(conditions);
  if (!parsed.ok) {
    return { accepted: false, reason: 'invalid-conditions', detail: parsed.detail };
  }
  if (ownerPubkeyHex === agentPubkeyHex) {
    return {
      accepted: false,
      reason: 'self-attestation',
      detail: 'owner and agent pubkeys must differ',
    };
  }
  if (!SIG_HEX_PATTERN.test(sigHex)) {
    return {
      accepted: false,
      reason: 'invalid-signature',
      detail: 'signature must be 128 lowercase hex chars',
    };
  }

  let signatureValid = false;
  try {
    signatureValid = ed25519Verify(
      null,
      attestationMessage(agentPubkeyHex, conditions),
      publicKeyFromHex(ownerPubkeyHex),
      Buffer.from(sigHex, 'hex'),
    );
  } catch {
    // Structurally hex-valid key material that is not a usable ed25519 key.
    return {
      accepted: false,
      reason: 'invalid-owner-pubkey',
      detail: 'owner pubkey is not a usable ed25519 public key',
    };
  }
  if (!signatureValid) {
    return {
      accepted: false,
      reason: 'invalid-signature',
      detail: 'ed25519 signature verification failed',
    };
  }

  const evaluation = evaluateClauses(parsed.clauses, context);
  if (!evaluation.satisfied) {
    return {
      accepted: false,
      reason: evaluation.reason,
      detail: evaluation.detail,
    };
  }
  return { accepted: true, ownerPubkey: ownerPubkeyHex };
}
