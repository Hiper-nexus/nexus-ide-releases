import { execFileSync, spawnSync } from "node:child_process";

const GIT_SHA = /^[a-f0-9]{40,64}$/;

function assertSha(value: string, label: string): string {
  if (!GIT_SHA.test(value)) throw new Error(`invalid ${label}`);
  return value;
}

function resolveCommit(rootRealPath: string, value: string, label: string) {
  const expected = assertSha(value, label);
  let actual: string;
  try {
    actual = execFileSync(
      "git",
      [
        "-C",
        rootRealPath,
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${expected}^{commit}`,
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15_000,
      },
    ).trim();
  } catch (error) {
    throw new Error(`physical Git ${label} is unavailable`, { cause: error });
  }
  if (actual !== expected) {
    throw new Error(`physical Git ${label} diverged from its exact commit`);
  }
  return actual;
}

function currentHead(rootRealPath: string): string {
  let value: string;
  try {
    value = execFileSync(
      "git",
      ["-C", rootRealPath, "rev-parse", "--verify", "HEAD^{commit}"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15_000,
      },
    ).trim();
  } catch (error) {
    throw new Error("physical Git integration HEAD is unavailable", {
      cause: error,
    });
  }
  return assertSha(value, "integration HEAD");
}

function assertAncestor(
  rootRealPath: string,
  ancestor: string,
  descendant: string,
): void {
  const result = spawnSync(
    "git",
    ["-C", rootRealPath, "merge-base", "--is-ancestor", ancestor, descendant],
    {
      encoding: "utf8",
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 15_000,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      "physical worker HEAD is not an ancestor of the integrated Git receipt",
      result.error ? { cause: result.error } : undefined,
    );
  }
}

/**
 * Bind a worktree integration receipt to both physical Git identities: the
 * MCP-observed worker HEAD must be an ancestor of the exact checkout HEAD
 * committed by the coordinator.
 */
export function assertIntegratedPhysicalGitAuthority(input: {
  readonly rootRealPath: string;
  readonly workerHeadSha: string | undefined;
  readonly integratedHeadSha: string;
  readonly checkoutMayHaveAdvanced?: boolean;
}): void {
  if (!input.workerHeadSha) {
    throw new Error("worktree integration requires a physical worker HEAD");
  }
  const workerHead = resolveCommit(
    input.rootRealPath,
    input.workerHeadSha,
    "worker HEAD",
  );
  const integratedHead = resolveCommit(
    input.rootRealPath,
    input.integratedHeadSha,
    "integrated HEAD",
  );
  const checkoutHead = currentHead(input.rootRealPath);
  if (input.checkoutMayHaveAdvanced) {
    assertAncestor(input.rootRealPath, integratedHead, checkoutHead);
  } else if (checkoutHead !== integratedHead) {
    throw new Error(
      "worktree integration receipt does not match the physical checkout HEAD",
    );
  }
  assertAncestor(input.rootRealPath, workerHead, integratedHead);
}

/** Exact no-change proof: worker, receipt and checkout must share one HEAD. */
export function assertNoChangePhysicalGitAuthority(input: {
  readonly rootRealPath: string;
  readonly workerHeadSha: string | undefined;
  readonly expectedHeadSha: string;
  readonly checkoutMayHaveAdvanced?: boolean;
}): void {
  if (!input.workerHeadSha) {
    throw new Error("no-change completion requires a physical worker HEAD");
  }
  const expectedHead = resolveCommit(
    input.rootRealPath,
    input.expectedHeadSha,
    "no-change HEAD",
  );
  const checkoutHead = currentHead(input.rootRealPath);
  if (input.workerHeadSha !== expectedHead) {
    throw new Error(
      "no-change receipt diverges from the physical worker/integration HEAD",
    );
  }
  if (input.checkoutMayHaveAdvanced) {
    assertAncestor(input.rootRealPath, expectedHead, checkoutHead);
  } else if (checkoutHead !== expectedHead) {
    throw new Error(
      "no-change receipt diverges from the physical worker/integration HEAD",
    );
  }
}

/**
 * A mechanically read-only worker runs in the integration checkout. Its
 * captured HEAD may be older only when later main-owned integrations descend
 * from it; rewrites and unrelated histories fail closed.
 */
export function assertReadOnlyPhysicalGitAuthority(input: {
  readonly rootRealPath: string;
  readonly workerHeadSha: string | undefined;
}): string {
  if (!input.workerHeadSha) {
    throw new Error("read-only completion requires a physical worker HEAD");
  }
  const workerHead = resolveCommit(
    input.rootRealPath,
    input.workerHeadSha,
    "read-only worker HEAD",
  );
  const head = currentHead(input.rootRealPath);
  assertAncestor(input.rootRealPath, workerHead, head);
  return head;
}
