// Policy adapted from Orca worker-report-settlement.ts (MIT): a real late
// report can supersede an inferred failure before duplicate settlement checks.
// Upstream: src/main/runtime/orchestration/db/dispatch-context/worker-report-settlement.ts
// Pin: 2f4f4578c828370f6413dc48f438a6b189f6190d
// Copyright (c) 2026 Lovecast Inc. License: third_party/licenses/orca-MIT.txt
import type { Handoff } from "../../shared/orch-types";

export const PROVISIONAL_WORKER_HANDOFF_AUTHORS = [
  "nexus-watchdog",
  "nexus-handoff-enforcement",
] as const;

/** A diagnostic is not a worker report or an operator-confirmed outcome. */
export function isProvisionalWorkerHandoff(handoff: Handoff): boolean {
  return (
    PROVISIONAL_WORKER_HANDOFF_AUTHORS.some(
      (author) => author === handoff.fromAgent,
    ) &&
    (handoff.status === "blocked" || handoff.status === "failed") &&
    handoff.authorityOrigin !== "operator-confirmed" &&
    !handoff.mcpProvenance
  );
}
