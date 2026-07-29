import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

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

/**
 * Recompute the exact PREVC candidate identity from physical Git.
 *
 * MergeQueue validates one synthetic candidate commit and then publishes that
 * exact commit as its integration receipt. Durable sensor/review rows are only
 * authoritative when their base, candidate and binary diff still resolve to
 * that physical commit.
 */
export function assertQualityCandidatePhysicalGitAuthority(input: {
  readonly rootRealPath: string;
  readonly baseSha: string;
  readonly candidateHeadSha: string;
  readonly diffHash: string;
  readonly integratedHeadSha: string;
}): void {
  const base = resolveCommit(input.rootRealPath, input.baseSha, "quality base");
  const candidate = resolveCommit(
    input.rootRealPath,
    input.candidateHeadSha,
    "quality candidate",
  );
  const integrated = resolveCommit(
    input.rootRealPath,
    input.integratedHeadSha,
    "quality integration",
  );
  if (candidate !== integrated) {
    throw new Error(
      "quality evidence candidate does not match the exact integrated Git receipt",
    );
  }
  assertAncestor(input.rootRealPath, base, candidate);
  let diff: string;
  try {
    diff = execFileSync(
      "git",
      [
        "-C",
        input.rootRealPath,
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--binary",
        "--full-index",
        base,
        candidate,
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15_000,
        maxBuffer: 32 * 1024 * 1024,
      },
    );
  } catch (error) {
    throw new Error("physical quality candidate diff is unavailable", {
      cause: error,
    });
  }
  const physicalDiffHash = createHash("sha256").update(diff).digest("hex");
  if (physicalDiffHash !== input.diffHash) {
    throw new Error(
      "quality evidence diff diverges from the physical integrated candidate",
    );
  }
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
