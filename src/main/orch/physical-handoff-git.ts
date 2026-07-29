import { execFile } from "node:child_process";
import type { AgentGateContext } from "./gate";

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
