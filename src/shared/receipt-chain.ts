/**
 * Hash chain for mission handoff receipts.
 *
 * Derived from block/buzz crates/buzz-audit/src/hash.rs, Apache-2.0
 * (github.com/block/buzz @ 8e81afa431deecd172f1ad6aab6f022f31cd812c; the
 * append/verify discipline follows service.rs and entry.rs of the same crate).
 * License text: third_party/licenses/buzz-APACHE-2.0.txt; attribution entry in
 * THIRD_PARTY_NOTICES.md.
 *
 * Nexus already persists isolated SHA-256 receipts per physical handoff
 * (`handoff_mcp_receipts`). This module links them into one verifiable chain
 * per mission: receipt N's hash covers receipt N-1's hash, genesis covers a
 * 32-zero-byte sentinel, so the whole mission trail is checked with a single
 * `verifyChain` instead of trusting each receipt in isolation.
 *
 * Preimage schema (field order is frozen — changing it invalidates every
 * existing chain; the golden-vector test pins it):
 *
 *   chainHash = SHA-256(
 *     u32be(len) || utf8(missionId)         -- tenant binding leads the hash:
 *                                              an entry cannot be lifted out of
 *                                              one mission's chain and
 *                                              re-verified inside another
 *     || u64be(seq)                         -- trap (d): big-endian, 1-based,
 *                                              monotonic within the mission
 *     || u64be(toStoragePrecision(issuedAt))-- trap (a): truncated to the
 *                                              precision the store round-trips
 *     || u32be(len) || utf8(receiptId)
 *     || u32be(len) || utf8(toolName)
 *     || u32be(len) || utf8(authoritySha256)
 *     || presence(workerIncarnationId)      -- trap (c): 0x01 || u32be(len) ||
 *                                              utf8(value), or a single 0x00 —
 *                                              present-empty never collides
 *                                              with absent
 *     || presence(worktreeHeadSha)          -- trap (c)
 *     || u32be(len) || utf8(canonicalJson(detail)) -- trap (b): sorted keys
 *     || prevHashBytes                      -- raw 32 bytes; the genesis
 *                                              sentinel (all zeros) when the
 *                                              stored prev_receipt_hash is NULL
 *   )
 *
 * The four documented buzz traps reproduced here:
 * (a) `issuedAt` is normalized through `toStoragePrecision` at the single
 *     point that consumes it. The receipt row stores INTEGER milliseconds; a
 *     fractional in-memory timestamp would be written with one preimage and
 *     verified against another, making every entry fail verification.
 *     Truncation is idempotent, so already-stored values are unaffected.
 * (b) `detail` is serialized with sorted object keys so the hash is stable
 *     across machines and insertion orders. A serialization failure is a hard
 *     error, never silently hashed as an empty value.
 * (c) Optional fields carry a presence tag (byte 0x01/0x00) so a present but
 *     empty value never collides with an absent one.
 * (d) `seq` enters the preimage as an unsigned 64-bit big-endian integer.
 *
 * Pure module: no I/O, no clock, no database. The single writer
 * (`src/main/orch/handoff-store.ts`) computes the link inside the same
 * transaction that inserts the receipt row; verification recomputes from the
 * stored rows alone.
 */
import { createHash } from "node:crypto";

/** JSON value accepted in `detail`. `undefined` is deliberately absent. */
export type ReceiptChainDetailValue =
  | null
  | boolean
  | number
  | string
  | readonly ReceiptChainDetailValue[]
  | { readonly [key: string]: ReceiptChainDetailValue };

/**
 * One link's hashed identity. Everything here must be reconstructible from the
 * persisted receipt row, byte-identical, or the chain can never re-verify.
 */
export interface ReceiptChainEntry {
  /** Mission that owns the chain. Leads the hash (tenant binding). */
  readonly missionId: string;
  /** 1-based position in this mission's chain, monotonic. */
  readonly seq: number;
  /** Epoch milliseconds. Hashed at storage precision (integer ms). */
  readonly issuedAt: number;
  readonly receiptId: string;
  readonly toolName: string;
  /** SHA-256 fingerprint of the bearer authority that emitted the receipt. */
  readonly authoritySha256: string;
  /** Optional: present-empty and absent hash differently (presence tag). */
  readonly workerIncarnationId?: string;
  /** Optional: present-empty and absent hash differently (presence tag). */
  readonly worktreeHeadSha?: string;
  /** Arbitrary JSON context, hashed as canonical (sorted-key) JSON. */
  readonly detail: ReceiptChainDetailValue;
}

/** A stored link: the entry plus the persisted chain columns. */
export interface ChainedReceiptEntry extends ReceiptChainEntry {
  /** 64-hex SHA-256 of this entry's preimage (column `chain_hash`). */
  readonly chainHash: string;
  /** 64-hex hash of the previous link, or null for genesis (`prev_receipt_hash`). */
  readonly prevReceiptHash: string | null;
}

/**
 * Raw material of one physical handoff receipt row. Null mirrors SQL NULL;
 * the mapping to presence-tagged/absent fields lives in exactly one place
 * (`handoffReceiptChainEntry`) so writer and verifier can never diverge.
 */
export interface HandoffReceiptChainMaterial {
  readonly missionId: string;
  readonly seq: number;
  readonly issuedAt: number;
  readonly receiptId: string;
  readonly handoffId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly source: string;
  readonly sessionId: string;
  readonly workerIncarnationId: string | null;
  readonly authoritySha256: string;
  readonly worktreeHeadSha: string | null;
  readonly rawPayloadSha256: string | null;
  readonly logicalOperationKey: string | null;
}

export type ReceiptChainVerification =
  | { readonly status: "valid"; readonly length: number }
  | { readonly status: "empty" }
  | { readonly status: "mission-mismatch"; readonly seq: number }
  | { readonly status: "chain-violation"; readonly seq: number }
  | { readonly status: "hash-mismatch"; readonly seq: number };

export interface VerifyChainOptions {
  /** Require the supplied segment to start at the mission's genesis link. */
  readonly requireGenesis?: boolean;
}

/**
 * The 32-byte sentinel hashed in place of `prevHash` for a mission's first
 * receipt, as lowercase hex. Stored as `prev_receipt_hash = NULL`; hashed as
 * all-zero bytes.
 */
export const GENESIS_PREV_HASH_HEX: string = "0".repeat(64);

const HASH_HEX_PATTERN = /^[a-f0-9]{64}$/;
const GENESIS_HASH_BYTES = Buffer.alloc(32);

/**
 * Reduce a timestamp to the precision the receipt store round-trips.
 *
 * `handoff_mcp_receipts.issued_at` is a SQLite INTEGER (epoch milliseconds).
 * A fractional in-memory timestamp hashes to a digest that can never be
 * recomputed from the stored row — the entry would be written with one
 * preimage and verified against another. Truncation is idempotent, so values
 * already at storage precision are unchanged.
 */
export function toStoragePrecision(issuedAtMs: number): number {
  if (!Number.isFinite(issuedAtMs) || issuedAtMs < 0) {
    throw new Error("receipt chain issuedAt must be a non-negative finite ms timestamp");
  }
  return Math.trunc(issuedAtMs);
}

function u32be(value: number): Buffer {
  const bytes = Buffer.allocUnsafe(4);
  bytes.writeUInt32BE(value, 0);
  return bytes;
}

function u64be(value: number): Buffer {
  const bytes = Buffer.allocUnsafe(8);
  bytes.writeBigUInt64BE(BigInt(value), 0);
  return bytes;
}

function lengthPrefixed(text: string): readonly Buffer[] {
  const bytes = Buffer.from(text, "utf8");
  return [u32be(bytes.length), bytes];
}

/** Presence tag: distinguishes a present-but-empty value from an absent one. */
function presenceTagged(value: string | undefined): readonly Buffer[] {
  if (value === undefined) return [Buffer.from([0])];
  return [Buffer.from([1]), ...lengthPrefixed(value)];
}

/**
 * Serialize a JSON value with sorted object keys for deterministic output.
 *
 * Propagates any serialization error rather than substituting a placeholder —
 * a hash must never silently stand in an empty value for a real payload.
 */
function canonicalJson(value: ReceiptChainDetailValue): string {
  const seen = new Set<object>();

  function visit(input: ReceiptChainDetailValue): string {
    if (input === null || typeof input === "boolean") {
      return JSON.stringify(input);
    }
    if (typeof input === "string") return JSON.stringify(input);
    if (typeof input === "number") {
      if (!Number.isFinite(input)) {
        throw new Error("receipt chain detail rejects non-finite numbers");
      }
      return JSON.stringify(Object.is(input, -0) ? 0 : input);
    }
    if (typeof input !== "object") {
      throw new Error(`receipt chain detail rejects ${typeof input}`);
    }
    if (seen.has(input)) {
      throw new Error("receipt chain detail rejects cyclic values");
    }
    seen.add(input);
    try {
      if (Array.isArray(input)) {
        return `[${input.map((item) => visit(item as ReceiptChainDetailValue)).join(",")}]`;
      }
      const record = input as { readonly [key: string]: ReceiptChainDetailValue };
      const members = Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${visit(record[key])}`);
      return `{${members.join(",")}}`;
    } finally {
      seen.delete(input);
    }
  }

  return visit(value);
}

function assertChainEntry(entry: ReceiptChainEntry): void {
  if (entry.missionId.length === 0) {
    throw new Error("receipt chain entry requires a missionId");
  }
  if (!Number.isSafeInteger(entry.seq) || entry.seq < 1) {
    throw new Error("receipt chain seq must be a positive integer");
  }
  if (entry.receiptId.length === 0) {
    throw new Error("receipt chain entry requires a receiptId");
  }
  if (entry.toolName.length === 0) {
    throw new Error("receipt chain entry requires a toolName");
  }
  if (entry.authoritySha256.length === 0) {
    throw new Error("receipt chain entry requires an authoritySha256");
  }
}

function prevHashBytes(prevHash: string | null): Buffer {
  if (prevHash === null) return GENESIS_HASH_BYTES;
  if (!HASH_HEX_PATTERN.test(prevHash)) {
    throw new Error("receipt chain prevHash must be 64 lowercase hex chars");
  }
  return Buffer.from(prevHash, "hex");
}

/**
 * SHA-256 over the entry's identity, chain, and context fields.
 *
 * Field order is fixed — changing it invalidates all existing chains. The
 * `missionId` is hashed first so chain identity carries the tenant. `issuedAt`
 * is normalized through {@link toStoragePrecision} here rather than hashed as
 * given, so no caller can reintroduce the write/read preimage split by
 * forgetting to truncate. `prevHash === null` hashes the genesis sentinel.
 */
export function computeChainHash(
  entry: ReceiptChainEntry,
  prevHash: string | null,
): string {
  assertChainEntry(entry);
  const hasher = createHash("sha256");
  // Tenant binding: missionId leads the hash.
  for (const part of lengthPrefixed(entry.missionId)) hasher.update(part);
  hasher.update(u64be(entry.seq));
  hasher.update(u64be(toStoragePrecision(entry.issuedAt)));
  for (const part of lengthPrefixed(entry.receiptId)) hasher.update(part);
  for (const part of lengthPrefixed(entry.toolName)) hasher.update(part);
  for (const part of lengthPrefixed(entry.authoritySha256)) hasher.update(part);
  for (const part of presenceTagged(entry.workerIncarnationId)) {
    hasher.update(part);
  }
  for (const part of presenceTagged(entry.worktreeHeadSha)) hasher.update(part);
  for (const part of lengthPrefixed(canonicalJson(entry.detail))) {
    hasher.update(part);
  }
  hasher.update(prevHashBytes(prevHash));
  return hasher.digest("hex");
}

/**
 * Verify one mission's chain segment, ordered by `seq`.
 *
 * Mirrors buzz `AuditService::verify_chain`: an empty segment is not
 * verifiable; each link's `prevReceiptHash` must equal the previous link's
 * `chainHash`; each `chainHash` must recompute from the stored fields. The
 * first supplied link's `prevReceiptHash` is not compared against anything
 * outside the segment (mid-chain verification is allowed), but it is covered
 * by that link's own hash — a forged genesis fails as a hash mismatch.
 * Structurally broken links are reported, never thrown.
 */
export function verifyChain(
  entries: readonly ChainedReceiptEntry[],
  options: VerifyChainOptions = {},
): ReceiptChainVerification {
  if (entries.length === 0) return { status: "empty" };
  const missionId = entries[0].missionId;
  const first = entries[0];
  if (
    options.requireGenesis === true &&
    (first.seq !== 1 || first.prevReceiptHash !== null)
  ) {
    return { status: "chain-violation", seq: first.seq };
  }
  let expectedPrev: string | undefined;
  let expectedSeq = first.seq;
  for (const entry of entries) {
    if (entry.missionId !== missionId) {
      return { status: "mission-mismatch", seq: entry.seq };
    }
    if (entry.seq !== expectedSeq) {
      return { status: "chain-violation", seq: entry.seq };
    }
    if (
      entry.prevReceiptHash !== null &&
      !HASH_HEX_PATTERN.test(entry.prevReceiptHash)
    ) {
      return { status: "chain-violation", seq: entry.seq };
    }
    if (expectedPrev !== undefined && entry.prevReceiptHash !== expectedPrev) {
      return { status: "chain-violation", seq: entry.seq };
    }
    if (computeChainHash(entry, entry.prevReceiptHash) !== entry.chainHash) {
      return { status: "hash-mismatch", seq: entry.seq };
    }
    expectedPrev = entry.chainHash;
    expectedSeq += 1;
  }
  return { status: "valid", length: entries.length };
}

/**
 * Canonical mapping from a physical handoff receipt row to its chain entry.
 *
 * SQL NULL maps to an absent presence-tagged field for `workerIncarnationId`
 * and `worktreeHeadSha`; the remaining receipt columns travel inside `detail`
 * with NULL preserved as JSON null. Writer and verifier must both go through
 * this function so the preimage can never drift between them.
 */
export function handoffReceiptChainEntry(
  material: HandoffReceiptChainMaterial,
): ReceiptChainEntry {
  return Object.freeze({
    missionId: material.missionId,
    seq: material.seq,
    issuedAt: material.issuedAt,
    receiptId: material.receiptId,
    toolName: material.toolName,
    authoritySha256: material.authoritySha256,
    ...(material.workerIncarnationId !== null
      ? { workerIncarnationId: material.workerIncarnationId }
      : {}),
    ...(material.worktreeHeadSha !== null
      ? { worktreeHeadSha: material.worktreeHeadSha }
      : {}),
    detail: Object.freeze({
      handoffId: material.handoffId,
      toolCallId: material.toolCallId,
      source: material.source,
      sessionId: material.sessionId,
      rawPayloadSha256: material.rawPayloadSha256,
      logicalOperationKey: material.logicalOperationKey,
    }),
  });
}
