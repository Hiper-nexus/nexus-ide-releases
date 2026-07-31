import { execFile } from "node:child_process";
import type { AgentGateContext } from "./gate";
import { parseGuidedTaskKind } from "./guided-task-kind";
import type { TaskDispatchRecord } from "./task-dispatch-codec";

const GIT_COMMIT_SHA = /^[a-f0-9]{40,64}$/u;

function gitOutput(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...args],
      {
        encoding: "utf8",
        timeout: 15_000,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * Capture the exact committed worker HEAD at the physical handoff boundary.
 * HTTP MCP and PTY-stream transports intentionally share this implementation.
 */
export async function committedPhysicalWorkerHead(
  ctx: AgentGateContext,
  requirePhysicalWorktree: boolean,
): Promise<string | undefined> {
  if (!requirePhysicalWorktree) return undefined;
  const worktree = ctx.executionScope?.rootRealPath;
  if (!worktree) {
    throw new Error(
      "handoff_provenance: worker execution worktree is unavailable",
    );
  }
  let head: string;
  try {
    head = (
      await gitOutput([
        "-C",
        worktree,
        "rev-parse",
        "--verify",
        "HEAD^{commit}",
      ])
    ).trim();
  } catch (error) {
    throw new Error(
      "handoff_provenance: committed worker HEAD is unavailable",
      { cause: error },
    );
  }
  if (!GIT_COMMIT_SHA.test(head)) {
    throw new Error("handoff_provenance: committed worker HEAD is invalid");
  }
  return head;
}

/**
 * Stable log/test marker for the stale-observation rejection. The worker did
 * nothing wrong: its session was bound before the executor integrated and its
 * honestly-observed tree went stale between bind and handoff. Sealing that
 * HEAD now would mint a receipt the completion chronology invariant
 * (chainHeadIsExact) must reject — initial head with a post-integration
 * issuedAt is causal nonsense. Re-anchoring before sealing would be worse:
 * the receipt would claim the worker read a tree it never saw. The only
 * honest outcome is to refuse this handoff (nothing is persisted), let the
 * existing turn-end/stall recovery requeue the task, and let the scheduler
 * re-dispatch — the rebind re-anchors the worktree to the integrated HEAD
 * and the next review seals the final SHA it genuinely observed.
 */
export const STALE_READ_ONLY_OBSERVATION_REASON =
  "stale_read_only_observation";

const STALE_READ_ONLY_OBSERVATION_MESSAGE =
  `${STALE_READ_ONLY_OBSERVATION_REASON}: este handoff NÃO foi aceito ` +
  "porque a árvore revisada ficou desatualizada — o executor integrou " +
  "novas mudanças depois que esta sessão começou, e selar agora " +
  "registraria uma versão que você não leu. Isto não é uma falha do seu " +
  "trabalho e nenhuma correção é esperada de você. Encerre o turno " +
  "normalmente: o Nexus retoma a tarefa automaticamente já sobre a árvore " +
  "integrada final, para uma nova revisão honesta.";

export class StaleReadOnlyObservationError extends Error {
  constructor() {
    super(STALE_READ_ONLY_OBSERVATION_MESSAGE);
    this.name = "StaleReadOnlyObservationError";
  }
}

function guidedReadOnlyLaneKind(
  dispatch: TaskDispatchRecord,
): ReturnType<typeof parseGuidedTaskKind> {
  try {
    return parseGuidedTaskKind({
      agentCategory: dispatch.agentCategory,
      executionMode:
        dispatch.executionMode === "same_checkout"
          ? undefined
          : dispatch.executionMode,
      domains: dispatch.ownership.domains,
      label: dispatch.taskId,
    });
  } catch {
    // A malformed projection never earns the fence — nor any authority.
    return null;
  }
}

/**
 * Stale-observation fence for the physical handoff boundary, shared by the
 * HTTP MCP and PTY-stream transports. Fires only when ALL of these hold:
 *
 *  - the lane is a Guided read_only advisory/reviewer lane (advisory,
 *    independent-review or read_only quality-gate) — never an
 *    implementation/same_checkout lane, never a non-Guided lane;
 *  - the lane's durable dispatch binds no handoff/receipt/completion yet
 *    (same eligibility shape as the rebind re-anchor gate, so a replay of an
 *    already-accepted handoff is untouched);
 *  - the mission's executor integration receipt (worktree_integrated)
 *    already exists — pre-integration handoffs are unaffected;
 *  - the HEAD the worker just read from its worktree is not the integrated
 *    HEAD.
 *
 * The rejection throws before any store mutation, so no half-written
 * receipt state can exist; it is retryable by construction (the dispatch
 * row keeps its running lease and the ordinary recovery requeues the task
 * within the existing attempt budgets), never a terminal worker contract
 * failure and never a fake success.
 */
export function assertReadOnlyLaneObservationCurrent(input: {
  readonly lane: TaskDispatchRecord;
  readonly missionDispatches: readonly TaskDispatchRecord[];
  readonly worktreeHeadSha: string;
}): void {
  const { lane } = input;
  if (lane.executionMode !== "read_only") return;
  const kind = guidedReadOnlyLaneKind(lane);
  if (
    kind !== "advisory" &&
    kind !== "independent-review" &&
    kind !== "quality-gate"
  ) {
    return;
  }
  if (
    lane.handoffId !== undefined ||
    lane.handoffAcceptedAt !== undefined ||
    lane.integrationReceipt !== undefined ||
    lane.completedAt !== undefined
  ) {
    return;
  }
  let integratedHeadSha: string | undefined;
  let integratedAt = -1;
  for (const candidate of input.missionDispatches) {
    if (
      candidate.missionId !== lane.missionId ||
      candidate.taskId === lane.taskId
    ) {
      continue;
    }
    const receipt = candidate.integrationReceipt;
    if (receipt?.kind !== "worktree_integrated") continue;
    if (receipt.completedAt >= integratedAt) {
      integratedAt = receipt.completedAt;
      integratedHeadSha = receipt.reference;
    }
  }
  if (!integratedHeadSha) return;
  if (input.worktreeHeadSha === integratedHeadSha) return;
  throw new StaleReadOnlyObservationError();
}
