import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  isPlanLaneWritablePath,
  type PromotedPlanSnapshot,
} from "../../shared/mission-intent";
import type { ProjectExecutionScope } from "../../shared/types";
import {
  ProcessGitRunner,
  assertSafeLocalGitConfig,
  createPrivateGitIndex,
  type GitRunner,
} from "../runtime/git-command";
import { assertSha } from "../runtime/worktree-contract";
import { readWorkspaceTextFile } from "./workspace-file";

const PLAN_COMMIT_ENV = Object.freeze({
  GIT_AUTHOR_NAME: "Nexus",
  GIT_AUTHOR_EMAIL: "nexus@localhost",
  GIT_COMMITTER_NAME: "Nexus",
  GIT_COMMITTER_EMAIL: "nexus@localhost",
});
const PLAN_COMMIT_MESSAGE_PREFIX = "docs: approve Nexus plan ";
const PLAN_TRANSACTION_REF_PREFIX =
  "refs/nexus/transactions/promoted-plan";

export interface PromotedPlanGitDeps {
  readonly gitRunner?: GitRunner;
}

export type PromotedPlanGitReceipt = Readonly<{
  headSha: string;
  paths: readonly string[];
  summarySha256: string;
  committed: boolean;
}>;

export type SanctionedPromotedPlanSource = Readonly<{
  path: "plan.md" | "docs/plan.md";
  content: string;
  sourceHash: string;
  headSha: string;
}>;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalRoot(scope: ProjectExecutionScope): string {
  const resolved = path.resolve(scope.rootRealPath);
  const real = fs.realpathSync(resolved);
  const stat = fs.lstatSync(resolved);
  if (
    resolved !== scope.rootRealPath ||
    real !== resolved ||
    stat.isSymbolicLink() ||
    !stat.isDirectory()
  ) {
    throw new Error(
      "promoted_plan_git_invalid_root: workspace precisa ser canônico",
    );
  }
  return real;
}

function collectDeclaredPlanPaths(value: unknown, paths: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectDeclaredPlanPaths(item, paths);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (
      key === "path" &&
      typeof item === "string" &&
      isPlanLaneWritablePath(item)
    ) {
      paths.add(item.replaceAll("\\", "/").replace(/^\.\//, ""));
    }
    collectDeclaredPlanPaths(item, paths);
  }
}

function statusPaths(output: string): string[] {
  const records = output.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (const record of records) {
    if (record.length < 4 || record[2] !== " ") {
      throw new Error(
        "promoted_plan_git_status_invalid: status Git não pôde ser provado",
      );
    }
    if (record[0] === "R" || record[0] === "C" || record[1] === "R") {
      throw new Error(
        "promoted_plan_git_status_invalid: rename/copy não é permitido",
      );
    }
    paths.push(record.slice(3).replaceAll("\\", "/"));
  }
  return paths;
}

function assertExactPlanContent(
  scope: ProjectExecutionScope,
  relativePath: string,
  expected: PromotedPlanSnapshot,
): void {
  const physical = readWorkspaceTextFile(scope, relativePath);
  if (
    physical.content !== expected.summary ||
    sha256(physical.content) !== expected.summarySha256
  ) {
    throw new Error(
      `promoted_plan_file_drift: ${relativePath} diverge do handoff físico selado`,
    );
  }
}

function exactSortedPaths(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((candidate, index) => candidate === expected[index])
  );
}

function optionalRefSha(
  git: GitRunner,
  root: string,
  reference: string,
): string | null {
  const result = git.run(
    root,
    ["rev-parse", "--verify", "--quiet", `${reference}^{commit}`],
    { allowFailure: true },
  );
  if (result.status === 1) return null;
  if (result.status !== 0) {
    throw new Error(
      "promoted_plan_git_transaction_invalid: journal Git não pôde ser provado",
    );
  }
  return assertSha(result.stdout.trim(), "promoted plan transaction");
}

function assertOnlyPlanStatus(
  git: GitRunner,
  root: string,
  allowedPaths: ReadonlySet<string>,
): void {
  const changed = statusPaths(
    git.run(root, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]).stdout,
  );
  if (changed.some((candidate) => !allowedPaths.has(candidate))) {
    throw new Error(
      "promoted_plan_git_recovery_unrelated: recovery encontrou alteração fora do plano",
    );
  }
}

function indexMatchesCommitAtPaths(
  git: GitRunner,
  root: string,
  commitSha: string,
  paths: readonly string[],
): boolean {
  const result = git.run(
    root,
    ["diff", "--cached", "--quiet", commitSha, "--", ...paths],
    { allowFailure: true },
  );
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(
    "promoted_plan_git_index_invalid: index compartilhado não pôde ser provado",
  );
}

function assertExactPromotedPlanCommit(
  git: GitRunner,
  root: string,
  candidateSha: string,
  expected: PromotedPlanSnapshot,
  physicalPaths: readonly string[],
): string {
  const parents = git
    .run(root, ["rev-list", "--parents", "-n", "1", candidateSha])
    .stdout.trim()
    .split(/\s+/);
  if (parents.length !== 2 || parents[0] !== candidateSha) {
    throw new Error(
      "promoted_plan_git_transaction_invalid: commit transacional exige um parent exato",
    );
  }
  const parentSha = assertSha(parents[1]!, "promoted plan transaction parent");
  const committedPaths = git
    .run(root, [
      "diff-tree",
      "--no-commit-id",
      "--name-only",
      "-r",
      "-z",
      candidateSha,
    ])
    .stdout.split("\0")
    .filter(Boolean)
    .sort();
  if (!exactSortedPaths(committedPaths, physicalPaths)) {
    throw new Error(
      "promoted_plan_git_transaction_invalid: journal contém paths não autorizados",
    );
  }
  const identity = git
    .run(root, [
      "show",
      "-s",
      "--format=%an%x00%ae%x00%cn%x00%ce",
      candidateSha,
    ])
    .stdout.trimEnd()
    .split("\0");
  const message = git
    .run(root, ["show", "-s", "--format=%B", candidateSha])
    .stdout.trimEnd();
  if (
    identity[0] !== PLAN_COMMIT_ENV.GIT_AUTHOR_NAME ||
    identity[1] !== PLAN_COMMIT_ENV.GIT_AUTHOR_EMAIL ||
    identity[2] !== PLAN_COMMIT_ENV.GIT_COMMITTER_NAME ||
    identity[3] !== PLAN_COMMIT_ENV.GIT_COMMITTER_EMAIL ||
    message !== `${PLAN_COMMIT_MESSAGE_PREFIX}${expected.summarySha256}`
  ) {
    throw new Error(
      "promoted_plan_git_transaction_invalid: identidade do commit transacional divergiu",
    );
  }
  for (const relativePath of physicalPaths) {
    const committedContent = git.run(root, [
      "show",
      `${candidateSha}:${relativePath}`,
    ]).stdout;
    if (
      committedContent !== expected.summary ||
      sha256(committedContent) !== expected.summarySha256
    ) {
      throw new Error(
        `promoted_plan_git_transaction_invalid: ${relativePath} diverge no journal`,
      );
    }
  }
  return parentSha;
}

/**
 * Completes a Main-owned commit whose branch CAS may already have succeeded.
 * The journal is a private Git ref tied to the sealed promoted-plan digest.
 * Recovery resets only the authorized plan path and only when the shared
 * index still equals either the exact parent or the exact candidate.
 */
function recoverPromotedPlanTransaction(
  git: GitRunner,
  scope: ProjectExecutionScope,
  root: string,
  reference: string,
  transactionRef: string,
  expected: PromotedPlanSnapshot,
  physicalPaths: readonly string[],
): string | null {
  const candidateSha = optionalRefSha(git, root, transactionRef);
  if (!candidateSha) return null;
  const parentSha = assertExactPromotedPlanCommit(
    git,
    root,
    candidateSha,
    expected,
    physicalPaths,
  );
  for (const candidate of physicalPaths) {
    assertExactPlanContent(scope, candidate, expected);
  }
  const currentHead = assertSha(
    git.run(root, ["rev-parse", "--verify", "HEAD^{commit}"]).stdout.trim(),
    "promoted plan recovery HEAD",
  );
  const allowed = new Set(physicalPaths);
  assertOnlyPlanStatus(git, root, allowed);

  if (currentHead === parentSha) {
    if (!indexMatchesCommitAtPaths(git, root, parentSha, physicalPaths)) {
      throw new Error(
        "promoted_plan_git_recovery_index_drift: index não corresponde ao parent transacional",
      );
    }
    git.run(root, ["update-ref", reference, candidateSha, parentSha]);
  } else if (currentHead !== candidateSha) {
    git.run(root, ["update-ref", "-d", transactionRef, candidateSha]);
    throw new Error(
      "promoted_plan_git_parent_raced: HEAD avançou fora da transação Nexus",
    );
  }

  if (!indexMatchesCommitAtPaths(git, root, candidateSha, physicalPaths)) {
    if (!indexMatchesCommitAtPaths(git, root, parentSha, physicalPaths)) {
      throw new Error(
        "promoted_plan_git_recovery_index_drift: index não corresponde ao parent nem ao commit Nexus",
      );
    }
    git.run(root, [
      "reset",
      "--quiet",
      candidateSha,
      "--",
      ...physicalPaths,
    ]);
  }
  if (
    git.run(root, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]).stdout.length > 0
  ) {
    throw new Error(
      "promoted_plan_git_recovery_dirty: workspace não ficou limpo após recovery",
    );
  }
  git.run(root, ["update-ref", "-d", transactionRef, candidateSha]);
  return candidateSha;
}

/**
 * Read-only proof consumed by Context Doctor. A plan becomes context evidence
 * only when its exact bytes are both tracked in HEAD and hash-equal to the
 * promoted physical handoff.
 */
export function resolvePromotedPlanGitSource(
  scope: ProjectExecutionScope,
  expected: PromotedPlanSnapshot,
  dependencies: PromotedPlanGitDeps = {},
): SanctionedPromotedPlanSource {
  if (sha256(expected.summary) !== expected.summarySha256) {
    throw new Error(
      "promoted_plan_corrupt: summary não corresponde ao hash selado",
    );
  }
  const declared = new Set<string>();
  collectDeclaredPlanPaths(expected.artifacts, declared);
  const root = canonicalRoot(scope);
  const physicalPaths = [...declared]
    .filter((candidate) => fs.existsSync(path.join(root, candidate)))
    .sort();
  if (physicalPaths.length !== 1) {
    throw new Error(
      "promoted_plan_source_ambiguous: exige exatamente um plan.md/docs/plan.md físico",
    );
  }
  const relativePath = physicalPaths[0]!;
  assertExactPlanContent(scope, relativePath, expected);

  const git = dependencies.gitRunner ?? new ProcessGitRunner();
  const topLevel = git.run(root, ["rev-parse", "--show-toplevel"]);
  if (fs.realpathSync(topLevel.stdout.trim()) !== root) {
    throw new Error(
      "promoted_plan_git_nested_root: workspace precisa ser a raiz Git exata",
    );
  }
  assertSafeLocalGitConfig(git, root);
  const headSha = assertSha(
    git.run(root, ["rev-parse", "--verify", "HEAD^{commit}"]).stdout.trim(),
    "promoted plan source HEAD",
  );
  if (
    git.run(root, [
      "status",
      "--porcelain=v1",
      "-z",
      "--",
      relativePath,
    ]).stdout.length > 0
  ) {
    throw new Error(
      `promoted_plan_source_dirty: ${relativePath} não corresponde ao HEAD`,
    );
  }
  const tracked = git.run(
    root,
    ["ls-files", "--error-unmatch", "--", relativePath],
    { allowFailure: true },
  );
  if (tracked.status !== 0) {
    throw new Error(
      `promoted_plan_source_untracked: ${relativePath} não está versionado`,
    );
  }
  const committedContent = git.run(root, [
    "show",
    `${headSha}:${relativePath}`,
  ]).stdout;
  if (
    committedContent !== expected.summary ||
    sha256(committedContent) !== expected.summarySha256
  ) {
    throw new Error(
      `promoted_plan_source_drift: ${relativePath} diverge do handoff em HEAD`,
    );
  }
  return Object.freeze({
    path: relativePath as SanctionedPromotedPlanSource["path"],
    content: expected.summary,
    sourceHash: expected.summarySha256,
    headSha,
  });
}

/**
 * Turns the exact plan artifact reviewed during promotion into the Git source
 * for standard-vN+1. It never creates/adopts files and refuses any unrelated
 * staged, tracked or untracked workspace state.
 */
export function commitPromotedPlanToGit(
  scope: ProjectExecutionScope,
  expected: PromotedPlanSnapshot,
  dependencies: PromotedPlanGitDeps = {},
): PromotedPlanGitReceipt {
  if (sha256(expected.summary) !== expected.summarySha256) {
    throw new Error(
      "promoted_plan_corrupt: summary não corresponde ao hash selado",
    );
  }
  const declared = new Set<string>();
  collectDeclaredPlanPaths(expected.artifacts, declared);
  if (declared.size === 0) {
    throw new Error(
      "promoted_plan_artifact_missing: handoff não declara plan.md/docs/plan.md",
    );
  }

  const root = canonicalRoot(scope);
  const git = dependencies.gitRunner ?? new ProcessGitRunner();
  const topLevel = git.run(root, ["rev-parse", "--show-toplevel"]);
  if (fs.realpathSync(topLevel.stdout.trim()) !== root) {
    throw new Error(
      "promoted_plan_git_nested_root: workspace precisa ser a raiz Git exata",
    );
  }
  assertSafeLocalGitConfig(git, root);
  const physicalPaths = [...declared]
    .filter((candidate) => fs.existsSync(path.join(root, candidate)))
    .sort();
  if (physicalPaths.length !== 1) {
    throw new Error(
      "promoted_plan_file_ambiguous: exige exatamente um plan.md/docs/plan.md físico",
    );
  }
  for (const candidate of physicalPaths) {
    assertExactPlanContent(scope, candidate, expected);
  }
  const beforeHead = assertSha(
    git.run(root, ["rev-parse", "--verify", "HEAD^{commit}"]).stdout.trim(),
    "promoted plan base HEAD",
  );
  const referenceResult = git.run(
    root,
    ["symbolic-ref", "--quiet", "HEAD"],
    { allowFailure: true },
  );
  const reference = referenceResult.stdout.trim();
  if (
    referenceResult.status !== 0 ||
    !reference.startsWith("refs/heads/")
  ) {
    throw new Error(
      "promoted_plan_git_invalid_branch: promoção exige uma branch Git",
    );
  }
  const transactionRef =
    `${PLAN_TRANSACTION_REF_PREFIX}/${expected.digest}`;
  const recoveredHead = recoverPromotedPlanTransaction(
    git,
    scope,
    root,
    reference,
    transactionRef,
    expected,
    physicalPaths,
  );
  if (recoveredHead) {
    return Object.freeze({
      headSha: recoveredHead,
      paths: Object.freeze(physicalPaths),
      summarySha256: expected.summarySha256,
      committed: false,
    });
  }
  const stagedBefore = git.run(root, [
    "diff",
    "--cached",
    "--name-only",
    "-z",
  ]).stdout;
  if (stagedBefore.length > 0) {
    throw new Error(
      "promoted_plan_git_staged: remova alterações staged antes da promoção",
    );
  }

  const changed = statusPaths(
    git.run(root, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]).stdout,
  );
  if (
    changed.some(
      (candidate) =>
        !declared.has(candidate) || !isPlanLaneWritablePath(candidate),
    )
  ) {
    throw new Error(
      "promoted_plan_git_unrelated_changes: o workspace contém alterações fora do plano selado",
    );
  }

  if (changed.length === 0) {
    for (const candidate of physicalPaths) {
      const tracked = git.run(
        root,
        ["ls-files", "--error-unmatch", "--", candidate],
        { allowFailure: true },
      );
      if (tracked.status !== 0) {
        throw new Error(
          `promoted_plan_git_untracked: ${candidate} não está versionado`,
        );
      }
      const committedContent = git.run(root, [
        "show",
        `${beforeHead}:${candidate}`,
      ]).stdout;
      if (
        committedContent !== expected.summary ||
        sha256(committedContent) !== expected.summarySha256
      ) {
        throw new Error(
          `promoted_plan_git_head_drift: ${candidate} não corresponde ao plano selado em HEAD`,
        );
      }
    }
    return Object.freeze({
      headSha: beforeHead,
      paths: Object.freeze(physicalPaths),
      summarySha256: expected.summarySha256,
      committed: false,
    });
  }

  const changedSet = new Set(changed);
  if (physicalPaths.some((candidate) => !changedSet.has(candidate))) {
    throw new Error(
      "promoted_plan_git_ambiguous: artifacts declarados não correspondem ao status físico",
    );
  }

  const privateIndex = createPrivateGitIndex();
  try {
    git.run(root, ["read-tree", beforeHead], {
      privateIndexFile: privateIndex.path,
    });
    git.run(root, ["add", "--", ...physicalPaths], {
      privateIndexFile: privateIndex.path,
    });
    const treeSha = assertSha(
      git
        .run(root, ["write-tree"], {
          privateIndexFile: privateIndex.path,
        })
        .stdout.trim(),
      "promoted plan tree",
    );
    const treePaths = git
      .run(root, [
        "diff-tree",
        "--no-commit-id",
        "--name-only",
        "-r",
        "-z",
        beforeHead,
        treeSha,
      ])
      .stdout.split("\0")
      .filter(Boolean)
      .sort();
    if (
      treePaths.length !== physicalPaths.length ||
      treePaths.some((candidate, index) => candidate !== physicalPaths[index])
    ) {
      throw new Error(
        "promoted_plan_git_tree_mismatch: árvore divergiu dos artifacts selados",
      );
    }
    for (const candidate of physicalPaths) {
      assertExactPlanContent(scope, candidate, expected);
    }
    const committedHead = assertSha(
      git
        .run(
          root,
          [
            "commit-tree",
            treeSha,
            "-p",
            beforeHead,
            "-m",
            `${PLAN_COMMIT_MESSAGE_PREFIX}${expected.summarySha256}`,
          ],
          { env: PLAN_COMMIT_ENV },
        )
        .stdout.trim(),
      "promoted plan commit",
    );
    git.run(root, [
      "update-ref",
      transactionRef,
      committedHead,
      "0".repeat(committedHead.length),
    ]);
    git.run(root, [
      "update-ref",
      reference,
      committedHead,
      beforeHead,
    ]);
    git.run(
      root,
      [
        "reset",
        "--quiet",
        committedHead,
        "--",
        ...physicalPaths,
      ],
    );
    git.run(root, [
      "update-ref",
      "-d",
      transactionRef,
      committedHead,
    ]);
  } finally {
    privateIndex.dispose();
  }

  const headSha = assertSha(
    git.run(root, ["rev-parse", "--verify", "HEAD^{commit}"]).stdout.trim(),
    "promoted plan HEAD",
  );
  const committedPaths = git
    .run(root, [
      "diff-tree",
      "--no-commit-id",
      "--name-only",
      "-r",
      "-z",
      headSha,
    ])
    .stdout.split("\0")
    .filter(Boolean)
    .sort();
  if (
    committedPaths.length !== physicalPaths.length ||
    committedPaths.some(
      (candidate, index) => candidate !== physicalPaths[index],
    )
  ) {
    throw new Error(
      "promoted_plan_git_commit_mismatch: commit contém paths não autorizados",
    );
  }
  const parentSha = assertSha(
    git.run(root, ["rev-parse", `${headSha}^`]).stdout.trim(),
    "promoted plan parent",
  );
  if (parentSha !== beforeHead) {
    throw new Error(
      "promoted_plan_git_parent_mismatch: base mudou durante a promoção",
    );
  }
  if (
    git.run(root, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]).stdout.length > 0
  ) {
    throw new Error(
      "promoted_plan_git_raced: workspace mudou durante o commit do plano",
    );
  }
  return Object.freeze({
    headSha,
    paths: Object.freeze(physicalPaths),
    summarySha256: expected.summarySha256,
    committed: true,
  });
}
