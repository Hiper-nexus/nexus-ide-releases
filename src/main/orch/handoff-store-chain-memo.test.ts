import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectRuntimeManager } from "../runtime/project-runtime-manager";
import {
  computeChainHash,
  handoffReceiptChainEntry,
  verifyChain,
} from "../../shared/receipt-chain";
import { testProjectScope } from "./__tests__/scope-fixture";
import { createScopedHandoffStore } from "./handoff-store";
import { createScopedMissionStore } from "./mission-store";

vi.mock("../../shared/receipt-chain", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../shared/receipt-chain")>();
  return { ...original, verifyChain: vi.fn(original.verifyChain) };
});

const HANDOFFS = 6;
let baseDir = "";
let runtimeManager: ProjectRuntimeManager;

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-handoff-chain-memo-"));
  runtimeManager = new ProjectRuntimeManager({ baseDir, appVersion: "0.76.0-test" });
  vi.mocked(verifyChain).mockClear();
});

afterEach(() => {
  runtimeManager.closeAll();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

/** A fully valid receipt chain for one mission, written straight to SQLite. */
function seed(options: { tamperSeq?: number } = {}) {
  const scope = testProjectScope();
  let next = 0;
  createScopedMissionStore(runtimeManager, scope, { idFactory: () => "mission-chain" }).create({
    title: "Chain memo",
  });
  const handoffs = createScopedHandoffStore(runtimeManager, scope, {
    now: () => 1_000 + next,
    idFactory: () => `handoff-${++next}`,
  });
  const db = runtimeManager.open(scope).db;
  const insert = db.prepare(
    `INSERT INTO handoff_mcp_receipts(
       receipt_id, handoff_id, tool_call_id, tool_name, source, mission_id,
       session_id, worker_incarnation_id, authority_sha256, worktree_head_sha,
       issued_at, raw_payload_sha256, logical_operation_key,
       chain_seq, prev_receipt_hash, chain_hash)
     VALUES (?, ?, ?, 'nexus_handoff_submit', 'http-mcp', 'mission-chain', ?, NULL,
             ?, NULL, ?, NULL, NULL, ?, ?, ?)`,
  );
  let previous: string | null = null;
  for (let seq = 1; seq <= HANDOFFS; seq += 1) {
    const submitted = handoffs.submit({
      missionId: "mission-chain",
      sessionId: `session-${seq}`,
      status: "success",
      summary: `handoff ${seq}`,
    });
    const entry = handoffReceiptChainEntry({
      missionId: "mission-chain",
      seq,
      issuedAt: 2_000 + seq,
      receiptId: `receipt-${seq}`,
      handoffId: submitted.id,
      toolCallId: `call-${seq}`,
      toolName: "nexus_handoff_submit",
      source: "http-mcp",
      sessionId: `session-${seq}`,
      workerIncarnationId: null,
      authoritySha256: "a".repeat(64),
      worktreeHeadSha: null,
      rawPayloadSha256: null,
      logicalOperationKey: null,
    });
    const hash = computeChainHash(entry, previous);
    insert.run(
      `receipt-${seq}`, submitted.id, `call-${seq}`, `session-${seq}`,
      "a".repeat(64), 2_000 + seq, seq, previous,
      options.tamperSeq === seq ? "b".repeat(64) : hash,
    );
    previous = hash;
  }
  vi.mocked(verifyChain).mockClear();
  return handoffs;
}

describe("handoff receipt chain verification per read", () => {
  it("verifies a mission chain once per list instead of once per handoff", () => {
    const handoffs = seed();

    const listed = handoffs.list({ includeDelivered: true });

    expect(listed).toHaveLength(HANDOFFS);
    expect(listed.every((handoff) => handoff.mcpProvenance !== undefined)).toBe(true);
    expect(vi.mocked(verifyChain)).toHaveBeenCalledTimes(1);
  });

  it("still refuses the whole read when one link of the chain is forged", () => {
    const handoffs = seed({ tamperSeq: 3 });

    expect(() => handoffs.list({ includeDelivered: true })).toThrow(/receipt chain/i);
  });

  it("never carries a verification across reads, so a later forgery cannot hide behind a stale memo", () => {
    const handoffs = seed();

    handoffs.list({ includeDelivered: true });
    handoffs.list({ includeDelivered: true });

    expect(vi.mocked(verifyChain)).toHaveBeenCalledTimes(2);
  });
});
