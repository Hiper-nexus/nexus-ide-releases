import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isPlanLaneWritablePath } from "../../shared/mission-intent";
import type { ProjectExecutionScope } from "../../shared/types";
import {
  AsyncProcessGitRunner,
  ProcessGitRunner,
  assertSafeLocalGitConfigAsync,
  assertSafeLocalGitConfig,
  createPrivateGitIndex,
  type AsyncGitRunner,
  type GitRunner,
} from "./git-command";
import {
  GUIDED_GREENFIELD_BRIEF_PATH,
  parseGuidedGreenfieldBrief,
  renderGuidedGreenfieldBrief,
  type GuidedGreenfieldApprovedIntent,
} from "./guided-greenfield-brief";
import { assertSha } from "./worktree-contract";

export type GuidedGitBaselineResult = Readonly<{
  kind: "existing" | "initialized-empty" | "committed-unborn";
  rootRealPath: string;
  integrationRef: string;
  headSha: string;
}>;

export interface GuidedGitBaselineDeps {
  readonly gitRunner?: GitRunner;
  /** Exact user-approved intent; projected only into a physically empty tree. */
  readonly approvedIntent?: GuidedGreenfieldApprovedIntent;
}

export interface GuidedGitBaselineAsyncDeps {
  readonly asyncGitRunner?: AsyncGitRunner;
}

const BASELINE_COMMIT_ENV = Object.freeze({
  GIT_AUTHOR_NAME: "Nexus",
  GIT_AUTHOR_EMAIL: "nexus@localhost",
  GIT_COMMITTER_NAME: "Nexus",
  GIT_COMMITTER_EMAIL: "nexus@localhost",
});
const EMPTY_BASELINE_COMMIT_MESSAGE = "chore: initialize Nexus workspace";
const BRIEF_BASELINE_COMMIT_MESSAGE =
  "docs: record approved Nexus greenfield brief";
const WORKTREE_CHECKPOINT_COMMIT_MESSAGE =
  "nexus: baseline da árvore de trabalho (snapshot automático)";
const BASELINE_TRANSACTION_REF_PREFIX =
  "refs/nexus/transactions/guided-baseline";
const MAX_WORKTREE_CHECKPOINT_ATTEMPTS = 4;
const SAFE_ENV_TEMPLATE_RE =
  /^\.env\.(?:example|sample|template|defaults?)$/i;
const CREDENTIAL_DATA_FILE_RE =
  /^(?:credentials?|secrets?)(?:\.(?:json|ya?ml|toml|ini|env))?$/i;

function isCredentialLikeUntrackedPath(rawPath: string): boolean {
  const normalized = rawPath.replaceAll("\\", "/").replace(/^\.\/+/, "");
  const segments = normalized.split("/").filter(Boolean);
  const basename = segments.at(-1) ?? "";
  const lower = basename.toLowerCase();
  if (
    lower.startsWith(".env") &&
    !SAFE_ENV_TEMPLATE_RE.test(lower)
  ) {
    return true;
  }
  if (
    [".npmrc", ".pypirc", ".netrc", ".git-credentials"].includes(lower) ||
    [".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"].some((extension) =>
      lower.endsWith(extension),
    ) ||
    /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i.test(basename) ||
    CREDENTIAL_DATA_FILE_RE.test(basename)
  ) {
    return true;
  }
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  return (
    lowerSegments.includes(".ssh") ||
    (lowerSegments.includes(".aws") && lower === "credentials")
  );
}

function assertNoUntrackedCredentialPaths(
  untrackedOutput: string,
): void {
  const sensitive = untrackedOutput
    .split("\0")
    .filter(Boolean)
    .filter(isCredentialLikeUntrackedPath);
  if (sensitive.length === 0) return;
  throw new Error(
    "guided_git_checkpoint_untracked_credential: untracked credential-like " +
      `path(s) require explicit git add or .gitignore: ${sensitive
        .slice(0, 5)
        .join(", ")}`,
  );
}

function assertNoUntrackedCredentials(
  git: GitRunner,
  root: string,
): void {
  assertNoUntrackedCredentialPaths(
    git.run(root, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]).stdout,
  );
}

async function assertNoUntrackedCredentialsAsync(
  git: AsyncGitRunner,
  root: string,
): Promise<void> {
  assertNoUntrackedCredentialPaths(
    (
      await git.run(root, [
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
      ])
    ).stdout,
  );
}

function canonicalRoot(scope: ProjectExecutionScope): string {
  const resolved = path.resolve(scope.rootRealPath);
  const rootRealPath = fs.realpathSync(resolved);
  const stat = fs.lstatSync(resolved);
  if (
    scope.rootRealPath !== resolved ||
    rootRealPath !== resolved ||
    stat.isSymbolicLink() ||
    !stat.isDirectory()
  ) {
    throw new Error(
      "guided_git_baseline_invalid_root: o workspace deve ser um diretório real canônico",
    );
  }
  return rootRealPath;
}

function integrationRef(git: GitRunner, root: string): string {
  const result = git.run(root, ["symbolic-ref", "--quiet", "HEAD"], {
    allowFailure: true,
  });
  const reference = result.stdout.trim();
  if (result.status !== 0 || !reference.startsWith("refs/heads/")) {
    throw new Error(
      "guided_git_baseline_invalid_branch: o workspace precisa estar em uma branch Git",
    );
  }
  return reference;
}

async function integrationRefAsync(
  git: AsyncGitRunner,
  root: string,
): Promise<string> {
  const result = await git.run(
    root,
    ["symbolic-ref", "--quiet", "HEAD"],
    { allowFailure: true },
  );
  const reference = result.stdout.trim();
  if (result.status !== 0 || !reference.startsWith("refs/heads/")) {
    throw new Error(
      "guided_git_baseline_invalid_branch: o workspace precisa estar em uma branch Git",
    );
  }
  return reference;
}

/**
 * Captures the current working tree as a commit the worker can branch from,
 * without mutating the operator's checkout.
 *
 * `read-tree HEAD` + `add -A` + `write-tree` run against a Nexus-private index
 * file, so the operator's staged state, working tree and HEAD are untouched;
 * `.gitignore` is still honoured because `add -A` applies it. The resulting
 * commit is parented on HEAD, which keeps history linear for the later merge.
 *
 * Returns HEAD unchanged when the snapshot produces the same tree, so a
 * clean-enough repository never grows an empty baseline commit.
 */
export function snapshotWorkingTreeCommit(
  git: GitRunner,
  root: string,
  headSha: string,
): string {
  assertNoUntrackedCredentials(git, root);
  const privateIndex = createPrivateGitIndex();
  try {
    const withIndex = { privateIndexFile: privateIndex.path } as const;
    git.run(root, ["read-tree", headSha], withIndex);
    git.run(root, ["add", "-A", "--", "."], withIndex);
    const treeSha = assertSha(
      git.run(root, ["write-tree"], withIndex).stdout.trim(),
      "guided worktree snapshot tree",
    );
    const headTree = assertSha(
      git.run(root, ["rev-parse", `${headSha}^{tree}`]).stdout.trim(),
      "guided HEAD tree",
    );
    if (treeSha === headTree) return headSha;
    return assertSha(
      git
        .run(
          root,
          [
            "commit-tree",
            treeSha,
            "-p",
            headSha,
            "-m",
            WORKTREE_CHECKPOINT_COMMIT_MESSAGE,
          ],
          { env: BASELINE_COMMIT_ENV },
        )
        .stdout.trim(),
      "guided worktree snapshot commit",
    );
  } finally {
    privateIndex.dispose();
  }
}

async function snapshotWorkingTreeCommitAsync(
  git: AsyncGitRunner,
  root: string,
  headSha: string,
): Promise<string> {
  await assertNoUntrackedCredentialsAsync(git, root);
  const privateIndex = createPrivateGitIndex();
  try {
    const withIndex = { privateIndexFile: privateIndex.path } as const;
    await git.run(root, ["read-tree", headSha], withIndex);
    await git.run(root, ["add", "-A", "--", "."], withIndex);
    const treeSha = assertSha(
      (await git.run(root, ["write-tree"], withIndex)).stdout.trim(),
      "guided async worktree snapshot tree",
    );
    const headTree = assertSha(
      (await git.run(root, ["rev-parse", `${headSha}^{tree}`])).stdout.trim(),
      "guided async HEAD tree",
    );
    if (treeSha === headTree) return headSha;
    return assertSha(
      (
        await git.run(
          root,
          [
            "commit-tree",
            treeSha,
            "-p",
            headSha,
            "-m",
            WORKTREE_CHECKPOINT_COMMIT_MESSAGE,
          ],
          { env: BASELINE_COMMIT_ENV },
        )
      ).stdout.trim(),
      "guided async worktree snapshot commit",
    );
  } finally {
    privateIndex.dispose();
  }
}

function assertCheckpointGitOperationIdle(
  git: GitRunner,
  root: string,
): void {
  if (git.run(root, ["ls-files", "--unmerged", "-z"]).stdout.length > 0) {
    throw new Error(
      "guided_git_checkpoint_operation_active: o índice possui conflitos não resolvidos",
    );
  }
  for (const marker of [
    "MERGE_HEAD",
    "REBASE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
  ]) {
    const result = git.run(
      root,
      ["rev-parse", "--verify", "--quiet", marker],
      { allowFailure: true },
    );
    if (result.status === 0) {
      throw new Error(
        `guided_git_checkpoint_operation_active: ${marker} está ativo`,
      );
    }
  }
  for (const statePath of ["rebase-merge", "rebase-apply", "BISECT_LOG"]) {
    const resolved = git
      .run(root, ["rev-parse", "--git-path", statePath])
      .stdout.trim();
    const absolute = path.isAbsolute(resolved)
      ? resolved
      : path.resolve(root, resolved);
    if (fs.existsSync(absolute)) {
      throw new Error(
        `guided_git_checkpoint_operation_active: ${statePath} está ativo`,
      );
    }
  }
}

async function assertCheckpointGitOperationIdleAsync(
  git: AsyncGitRunner,
  root: string,
): Promise<void> {
  if (
    (await git.run(root, ["ls-files", "--unmerged", "-z"])).stdout.length > 0
  ) {
    throw new Error(
      "guided_git_checkpoint_operation_active: o índice possui conflitos não resolvidos",
    );
  }
  for (const marker of [
    "MERGE_HEAD",
    "REBASE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
  ]) {
    const result = await git.run(
      root,
      ["rev-parse", "--verify", "--quiet", marker],
      { allowFailure: true },
    );
    if (result.status === 0) {
      throw new Error(
        `guided_git_checkpoint_operation_active: ${marker} está ativo`,
      );
    }
  }
  for (const statePath of ["rebase-merge", "rebase-apply", "BISECT_LOG"]) {
    const resolved = (
      await git.run(root, ["rev-parse", "--git-path", statePath])
    ).stdout.trim();
    const absolute = path.isAbsolute(resolved)
      ? resolved
      : path.resolve(root, resolved);
    if (fs.existsSync(absolute)) {
      throw new Error(
        `guided_git_checkpoint_operation_active: ${statePath} está ativo`,
      );
    }
  }
}

function promoteWorktreeCheckpoint(
  git: GitRunner,
  root: string,
  reference: string,
  candidateSha: string,
  parentSha: string,
): boolean {
  return (
    git.run(
      root,
      ["update-ref", reference, candidateSha, parentSha],
      { allowFailure: true },
    ).status === 0
  );
}

function checkpointDirtyWorktree(
  git: GitRunner,
  root: string,
  reference: string,
): string {
  for (
    let attempt = 0;
    attempt < MAX_WORKTREE_CHECKPOINT_ATTEMPTS;
    attempt += 1
  ) {
    assertCheckpointGitOperationIdle(git, root);
    if (integrationRef(git, root) !== reference) {
      throw new Error(
        "guided_git_checkpoint_branch_raced: a branch ativa mudou durante o checkpoint",
      );
    }
    const parentSha = currentHeadOrNull(git, root);
    if (!parentSha) {
      throw new Error(
        "guided_git_checkpoint_head_missing: HEAD desapareceu durante o checkpoint",
      );
    }
    if (cleanStatus(git, root)) return parentSha;

    const candidateSha = snapshotWorkingTreeCommit(
      git,
      root,
      parentSha,
    );
    if (
      candidateSha !== parentSha &&
      git.run(root, ["rev-parse", `${candidateSha}^`]).stdout.trim() !==
        parentSha
    ) {
      throw new Error(
        "guided_git_checkpoint_candidate_invalid: o parent do checkpoint divergiu",
      );
    }
    if (integrationRef(git, root) !== reference) {
      throw new Error(
        "guided_git_checkpoint_branch_raced: a branch ativa mudou durante o checkpoint",
      );
    }
    if (currentHeadOrNull(git, root) !== parentSha) {
      continue;
    }
    if (
      candidateSha !== parentSha &&
      !promoteWorktreeCheckpoint(
        git,
        root,
        reference,
        candidateSha,
        parentSha,
      )
    ) {
      continue;
    }
    assertCheckpointGitOperationIdle(git, root);
    if (
      integrationRef(git, root) !== reference ||
      currentHeadOrNull(git, root) !== candidateSha
    ) {
      continue;
    }
    git.run(root, ["read-tree", candidateSha]);
    if (
      integrationRef(git, root) === reference &&
      currentHeadOrNull(git, root) === candidateSha &&
      cleanStatus(git, root)
    ) {
      return candidateSha;
    }
  }
  throw new Error(
    `guided_git_checkpoint_raced: o workspace continuou mudando após ${MAX_WORKTREE_CHECKPOINT_ATTEMPTS} tentativas atômicas`,
  );
}

async function currentHeadOrNullAsync(
  git: AsyncGitRunner,
  root: string,
): Promise<string | null> {
  const head = await git.run(
    root,
    ["rev-parse", "--verify", "HEAD^{commit}"],
    { allowFailure: true },
  );
  if (head.status !== 0) return null;
  return assertSha(head.stdout.trim(), "guided async baseline HEAD");
}

async function cleanStatusAsync(
  git: AsyncGitRunner,
  root: string,
): Promise<boolean> {
  return (
    (
      await git.run(root, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ])
    ).stdout.length === 0
  );
}

async function checkpointDirtyWorktreeAsync(
  git: AsyncGitRunner,
  root: string,
  reference: string,
): Promise<string> {
  for (
    let attempt = 0;
    attempt < MAX_WORKTREE_CHECKPOINT_ATTEMPTS;
    attempt += 1
  ) {
    await assertCheckpointGitOperationIdleAsync(git, root);
    if ((await integrationRefAsync(git, root)) !== reference) {
      throw new Error(
        "guided_git_checkpoint_branch_raced: a branch ativa mudou durante o checkpoint",
      );
    }
    const parentSha = await currentHeadOrNullAsync(git, root);
    if (!parentSha) {
      throw new Error(
        "guided_git_checkpoint_head_missing: HEAD desapareceu durante o checkpoint",
      );
    }
    if (await cleanStatusAsync(git, root)) return parentSha;

    const candidateSha = await snapshotWorkingTreeCommitAsync(
      git,
      root,
      parentSha,
    );
    if (
      candidateSha !== parentSha &&
      (
        await git.run(root, ["rev-parse", `${candidateSha}^`])
      ).stdout.trim() !== parentSha
    ) {
      throw new Error(
        "guided_git_checkpoint_candidate_invalid: o parent do checkpoint divergiu",
      );
    }
    if ((await integrationRefAsync(git, root)) !== reference) {
      throw new Error(
        "guided_git_checkpoint_branch_raced: a branch ativa mudou durante o checkpoint",
      );
    }
    if ((await currentHeadOrNullAsync(git, root)) !== parentSha) continue;
    if (
      candidateSha !== parentSha &&
      (
        await git.run(
          root,
          ["update-ref", reference, candidateSha, parentSha],
          { allowFailure: true },
        )
      ).status !== 0
    ) {
      continue;
    }
    await assertCheckpointGitOperationIdleAsync(git, root);
    if (
      (await integrationRefAsync(git, root)) !== reference ||
      (await currentHeadOrNullAsync(git, root)) !== candidateSha
    ) {
      continue;
    }
    await git.run(root, ["read-tree", candidateSha]);
    if (
      (await integrationRefAsync(git, root)) === reference &&
      (await currentHeadOrNullAsync(git, root)) === candidateSha &&
      (await cleanStatusAsync(git, root))
    ) {
      return candidateSha;
    }
  }
  throw new Error(
    `guided_git_checkpoint_raced: o workspace continuou mudando após ${MAX_WORKTREE_CHECKPOINT_ATTEMPTS} tentativas atômicas`,
  );
}

function cleanStatus(git: GitRunner, root: string): boolean {
  return (
    git.run(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
      .stdout.length === 0
  );
}

function physicalWorktreeEntries(root: string): readonly string[] {
  return Object.freeze(
    fs
      .readdirSync(root)
      .filter((entry) => entry !== ".git")
      .sort((left, right) => left.localeCompare(right)),
  );
}

function exactCommittedBrief(
  git: GitRunner,
  root: string,
  expected: string,
): boolean {
  try {
    const target = path.join(root, GUIDED_GREENFIELD_BRIEF_PATH);
    const stat = fs.lstatSync(target);
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      fs.readFileSync(target, "utf8") !== expected
    ) {
      return false;
    }
    const committed = git.run(
      root,
      ["show", `HEAD:${GUIDED_GREENFIELD_BRIEF_PATH}`],
      { allowFailure: true },
    );
    return committed.status === 0 && committed.stdout === expected;
  } catch {
    return false;
  }
}

function canonicalBriefIntentMismatch(
  root: string,
  expected: string,
): boolean {
  try {
    const target = path.join(root, GUIDED_GREENFIELD_BRIEF_PATH);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) return false;
    const content = fs.readFileSync(target, "utf8");
    return parseGuidedGreenfieldBrief(content) !== null && content !== expected;
  } catch {
    return false;
  }
}

function baselineTransactionRef(expectedContent: string | null): string {
  const digest = createHash("sha256")
    .update(expectedContent === null ? "empty\0" : `brief\0${expectedContent}`)
    .digest("hex");
  return `${BASELINE_TRANSACTION_REF_PREFIX}/${digest}`;
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
      "guided_git_baseline_transaction_invalid: journal Git não pôde ser provado",
    );
  }
  return assertSha(result.stdout.trim(), "guided baseline transaction");
}

function strictStatusPaths(git: GitRunner, root: string): readonly string[] {
  const records = git
    .run(root, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ])
    .stdout.split("\0")
    .filter(Boolean);
  return Object.freeze(
    records.map((record) => {
      if (
        record.length < 4 ||
        record[2] !== " " ||
        record[0] === "R" ||
        record[0] === "C" ||
        record[1] === "R"
      ) {
        throw new Error(
          "guided_git_baseline_status_invalid: status Git não pôde ser provado",
        );
      }
      return record.slice(3).replaceAll("\\", "/");
    }),
  );
}

function indexMatchesCommitAtBrief(
  git: GitRunner,
  root: string,
  commitSha: string | null,
): boolean {
  if (commitSha === null) {
    return (
      git.run(root, [
        "ls-files",
        "--stage",
        "-z",
        "--",
        GUIDED_GREENFIELD_BRIEF_PATH,
      ]).stdout.length === 0
    );
  }
  const result = git.run(
    root,
    [
      "diff",
      "--cached",
      "--quiet",
      commitSha,
      "--",
      GUIDED_GREENFIELD_BRIEF_PATH,
    ],
    { allowFailure: true },
  );
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(
    "guided_git_baseline_index_invalid: index compartilhado não pôde ser provado",
  );
}

function assertExactBriefFile(root: string, expectedContent: string): void {
  const target = path.join(root, GUIDED_GREENFIELD_BRIEF_PATH);
  const stat = fs.lstatSync(target);
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.nlink !== 1 ||
    fs.readFileSync(target, "utf8") !== expectedContent
  ) {
    throw new Error(
      "guided_git_baseline_recovery_brief_drift: PRODUCT.md transacional divergiu",
    );
  }
}

function materializeExactBriefForRecovery(
  root: string,
  expectedContent: string,
): void {
  const target = path.join(root, GUIDED_GREENFIELD_BRIEF_PATH);
  try {
    fs.lstatSync(target);
    assertExactBriefFile(root, expectedContent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    fs.writeFileSync(target, expectedContent, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    assertExactBriefFile(root, expectedContent);
  }
}

function assertExactBaselineCandidate(
  git: GitRunner,
  root: string,
  candidateSha: string,
  expectedContent: string | null,
): string | null {
  const lineage = git
    .run(root, ["rev-list", "--parents", "-n", "1", candidateSha])
    .stdout.trim()
    .split(/\s+/);
  if (
    lineage[0] !== candidateSha ||
    (lineage.length !== 1 && lineage.length !== 2)
  ) {
    throw new Error(
      "guided_git_baseline_transaction_invalid: lineage do journal divergiu",
    );
  }
  const parentSha =
    lineage.length === 2
      ? assertSha(lineage[1]!, "guided baseline transaction parent")
      : null;
  const expectedPaths = expectedContent === null
    ? ""
    : `${GUIDED_GREENFIELD_BRIEF_PATH}\0`;
  const treePaths = git.run(root, [
    "ls-tree",
    "-r",
    "--name-only",
    "-z",
    candidateSha,
  ]).stdout;
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
    treePaths !== expectedPaths ||
    identity[0] !== BASELINE_COMMIT_ENV.GIT_AUTHOR_NAME ||
    identity[1] !== BASELINE_COMMIT_ENV.GIT_AUTHOR_EMAIL ||
    identity[2] !== BASELINE_COMMIT_ENV.GIT_COMMITTER_NAME ||
    identity[3] !== BASELINE_COMMIT_ENV.GIT_COMMITTER_EMAIL ||
    message !==
      (expectedContent === null
        ? EMPTY_BASELINE_COMMIT_MESSAGE
        : BRIEF_BASELINE_COMMIT_MESSAGE)
  ) {
    throw new Error(
      "guided_git_baseline_transaction_invalid: commit do journal divergiu",
    );
  }
  if (expectedContent !== null) {
    const committed = git.run(root, [
      "show",
      `${candidateSha}:${GUIDED_GREENFIELD_BRIEF_PATH}`,
    ]).stdout;
    if (committed !== expectedContent) {
      throw new Error(
        "guided_git_baseline_transaction_invalid: PRODUCT.md do journal divergiu",
      );
    }
  }
  return parentSha;
}

function currentHeadOrNull(git: GitRunner, root: string): string | null {
  const head = git.run(
    root,
    ["rev-parse", "--verify", "HEAD^{commit}"],
    { allowFailure: true },
  );
  if (head.status !== 0) return null;
  return assertSha(head.stdout.trim(), "guided baseline recovery HEAD");
}

function recoverGuidedBaselineTransaction(
  git: GitRunner,
  root: string,
  reference: string,
  expectedContent: string | null,
): string | null {
  const transactionRef = baselineTransactionRef(expectedContent);
  const candidateSha = optionalRefSha(git, root, transactionRef);
  if (!candidateSha) return null;
  const parentSha = assertExactBaselineCandidate(
    git,
    root,
    candidateSha,
    expectedContent,
  );
  const currentHead = currentHeadOrNull(git, root);
  const changed = strictStatusPaths(git, root);
  if (
    changed.some(
      (candidate) =>
        expectedContent === null ||
        candidate !== GUIDED_GREENFIELD_BRIEF_PATH,
    )
  ) {
    throw new Error(
      "guided_git_baseline_recovery_unrelated: recovery encontrou alteração alheia",
    );
  }
  if (
    expectedContent !== null &&
    (currentHead === parentSha || currentHead === candidateSha)
  ) {
    materializeExactBriefForRecovery(root, expectedContent);
  }

  if (currentHead === parentSha) {
    if (
      expectedContent !== null &&
      !indexMatchesCommitAtBrief(git, root, parentSha)
    ) {
      throw new Error(
        "guided_git_baseline_recovery_index_drift: index não corresponde ao parent",
      );
    }
    git.run(root, [
      "update-ref",
      reference,
      candidateSha,
      parentSha ?? "0".repeat(candidateSha.length),
    ]);
  } else if (currentHead !== candidateSha) {
    if (expectedContent !== null) {
      let exactBriefExists = false;
      try {
        assertExactBriefFile(root, expectedContent);
        exactBriefExists = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const tracked = currentHead
        ? git.run(
            root,
            ["ls-tree", "-z", currentHead, "--", GUIDED_GREENFIELD_BRIEF_PATH],
            { allowFailure: true },
          ).stdout
        : "";
      if (
        exactBriefExists &&
        tracked.length === 0 &&
        indexMatchesCommitAtBrief(git, root, currentHead)
      ) {
        // The exact, single-link file is proven to be the artifact created by
        // this journal and no winning HEAD tracks it. It is safe to clean up.
        fs.unlinkSync(path.join(root, GUIDED_GREENFIELD_BRIEF_PATH));
      }
    }
    git.run(root, ["update-ref", "-d", transactionRef, candidateSha]);
    throw new Error(
      "guided_git_baseline_parent_raced: HEAD avançou fora da transação Nexus",
    );
  }

  if (expectedContent !== null) {
    if (!indexMatchesCommitAtBrief(git, root, candidateSha)) {
      if (!indexMatchesCommitAtBrief(git, root, parentSha)) {
        throw new Error(
          "guided_git_baseline_recovery_index_drift: index não corresponde ao parent nem ao commit Nexus",
        );
      }
      git.run(root, [
        "reset",
        "--quiet",
        candidateSha,
        "--",
        GUIDED_GREENFIELD_BRIEF_PATH,
      ]);
    }
  }
  if (!cleanStatus(git, root)) {
    throw new Error(
      "guided_git_baseline_recovery_dirty: workspace não ficou limpo após recovery",
    );
  }
  git.run(root, ["update-ref", "-d", transactionRef, candidateSha]);
  return candidateSha;
}

function commitInitialAuthority(
  git: GitRunner,
  root: string,
  reference: string,
  expectedHead: string | null,
  approvedIntent: GuidedGreenfieldApprovedIntent | undefined,
): string {
  if (physicalWorktreeEntries(root).length !== 0 || !cleanStatus(git, root)) {
    throw new Error(
      "guided_git_baseline_initial_nonempty: a autoridade inicial exige árvore fisicamente vazia e limpa",
    );
  }
  const privateIndex = createPrivateGitIndex();
  const expectedContent = approvedIntent
    ? renderGuidedGreenfieldBrief(approvedIntent)
    : null;
  const transactionRef = baselineTransactionRef(expectedContent);
  try {
    git.run(root, ["read-tree", "--empty"], {
      privateIndexFile: privateIndex.path,
    });
    if (approvedIntent) {
      const sourcePath = path.join(
        path.dirname(privateIndex.path),
        "PRODUCT.md.source",
      );
      fs.writeFileSync(sourcePath, expectedContent!, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      const blobSha = assertSha(
        git.run(root, ["hash-object", "-w", "--", sourcePath]).stdout.trim(),
        "guided PRODUCT blob",
      );
      git.run(root, [
        "update-index",
        "--add",
        "--cacheinfo",
        `100644,${blobSha},${GUIDED_GREENFIELD_BRIEF_PATH}`,
      ], {
        privateIndexFile: privateIndex.path,
      });
    }
    const treeSha = assertSha(
      git
        .run(root, ["write-tree"], {
          privateIndexFile: privateIndex.path,
        })
        .stdout.trim(),
      "guided initial tree",
    );
    const treePaths = git.run(root, [
      "ls-tree",
      "-r",
      "--name-only",
      "-z",
      treeSha,
    ]).stdout;
    const expectedTreePaths = approvedIntent
      ? `${GUIDED_GREENFIELD_BRIEF_PATH}\0`
      : "";
    if (treePaths !== expectedTreePaths) {
      throw new Error(
        "guided_git_baseline_tree_mismatch: árvore inicial contém paths não autorizados",
      );
    }
    const commitArgs = [
      "commit-tree",
      treeSha,
      ...(expectedHead ? ["-p", expectedHead] : []),
      "-m",
      approvedIntent
        ? BRIEF_BASELINE_COMMIT_MESSAGE
        : EMPTY_BASELINE_COMMIT_MESSAGE,
    ];
    const committedHead = assertSha(
      git.run(root, commitArgs, { env: BASELINE_COMMIT_ENV }).stdout.trim(),
      "guided initial commit",
    );
    git.run(root, [
      "update-ref",
      transactionRef,
      committedHead,
      "0".repeat(committedHead.length),
    ]);
    if (approvedIntent) {
      fs.writeFileSync(
        path.join(root, GUIDED_GREENFIELD_BRIEF_PATH),
        expectedContent!,
        {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        },
      );
    }
    git.run(root, [
      "update-ref",
      reference,
      committedHead,
      expectedHead ?? "0".repeat(committedHead.length),
    ]);
    if (approvedIntent) {
      git.run(root, [
        "reset",
        "--quiet",
        committedHead,
        "--",
        GUIDED_GREENFIELD_BRIEF_PATH,
      ]);
    }
    git.run(root, [
      "update-ref",
      "-d",
      transactionRef,
      committedHead,
    ]);
    return committedHead;
  } finally {
    privateIndex.dispose();
  }
}

/**
 * Runs the strict baseline only while context bootstrap can still preserve a
 * truly empty greenfield. Existing repositories already have a baseline; an
 * unborn/non-repository workspace containing user files is intentionally left
 * untouched so the later worker gate can reject it without adopting files.
 */
export function ensureGuidedGitBaselineBeforeContext(
  scope: ProjectExecutionScope,
  dependencies: GuidedGitBaselineDeps = {},
): GuidedGitBaselineResult | null {
  const rootRealPath = canonicalRoot(scope);
  const git = dependencies.gitRunner ?? new ProcessGitRunner();
  const entries = physicalWorktreeEntries(rootRealPath);
  const topLevel = git.run(rootRealPath, ["rev-parse", "--show-toplevel"], {
    allowFailure: true,
  });

  if (topLevel.status !== 0) {
    return entries.length === 0
      ? ensureGuidedGitBaseline(scope, dependencies)
      : null;
  }

  const provedTopLevel = fs.realpathSync(topLevel.stdout.trim());
  if (provedTopLevel !== rootRealPath) {
    return entries.length === 0
      ? ensureGuidedGitBaseline(scope, dependencies)
      : null;
  }

  if (dependencies.approvedIntent) {
    const expected = renderGuidedGreenfieldBrief(
      dependencies.approvedIntent,
    );
    if (
      optionalRefSha(
        git,
        rootRealPath,
        baselineTransactionRef(expected),
      )
    ) {
      return ensureGuidedGitBaseline(scope, dependencies);
    }
  }

  const head = git.run(
    rootRealPath,
    ["rev-parse", "--verify", "HEAD^{commit}"],
    { allowFailure: true },
  );
  if (head.status === 0) {
    if (!dependencies.approvedIntent) return null;
    const expected = renderGuidedGreenfieldBrief(
      dependencies.approvedIntent,
    );
    if (canonicalBriefIntentMismatch(rootRealPath, expected)) {
      throw new Error(
        "guided_greenfield_brief_intent_mismatch: PRODUCT.md pertence a outra intenção aprovada; crie uma nova pasta vazia ou retome a missão original",
      );
    }
    if (!cleanStatus(git, rootRealPath)) return null;
    if (exactCommittedBrief(git, rootRealPath, expected)) {
      return ensureGuidedGitBaseline(scope, dependencies);
    }
    return entries.length === 0
      ? ensureGuidedGitBaseline(scope, dependencies)
      : null;
  }
  return cleanStatus(git, rootRealPath)
    ? ensureGuidedGitBaseline(scope, dependencies)
    : null;
}

async function commitEmptyBaselineAsync(
  git: AsyncGitRunner,
  root: string,
  reference: string,
): Promise<string> {
  const privateIndex = createPrivateGitIndex();
  try {
    const withIndex = { privateIndexFile: privateIndex.path } as const;
    await git.run(root, ["read-tree", "--empty"], withIndex);
    const treeSha = assertSha(
      (await git.run(root, ["write-tree"], withIndex)).stdout.trim(),
      "guided async empty tree",
    );
    const committedHead = assertSha(
      (
        await git.run(
          root,
          [
            "commit-tree",
            treeSha,
            "-m",
            EMPTY_BASELINE_COMMIT_MESSAGE,
          ],
          { env: BASELINE_COMMIT_ENV },
        )
      ).stdout.trim(),
      "guided async initial commit",
    );
    const promoted = await git.run(
      root,
      [
        "update-ref",
        reference,
        committedHead,
        "0".repeat(committedHead.length),
      ],
      { allowFailure: true },
    );
    if (promoted.status !== 0) {
      const winner = await currentHeadOrNullAsync(git, root);
      if (!winner) {
        throw new Error(
          "guided_git_baseline_parent_raced: HEAD mudou sem produzir um commit",
        );
      }
      return winner;
    }
    await git.run(root, ["read-tree", committedHead]);
    return committedHead;
  } finally {
    privateIndex.dispose();
  }
}

/**
 * Scheduler-facing baseline. All potentially expensive repository walks and
 * index writes use the asynchronous Git runner so Electron keeps servicing
 * IPC/PTYS while a large workspace is checkpointed.
 */
export async function ensureGuidedGitBaselineForWorktreeAsync(
  scope: ProjectExecutionScope,
  dependencies: GuidedGitBaselineAsyncDeps = {},
): Promise<GuidedGitBaselineResult> {
  const rootRealPath = canonicalRoot(scope);
  const git =
    dependencies.asyncGitRunner ?? new AsyncProcessGitRunner();
  const entries = (await fs.promises.readdir(rootRealPath)).filter(
    (entry) => entry !== ".git",
  );
  const topLevel = await git.run(
    rootRealPath,
    ["rev-parse", "--show-toplevel"],
    { allowFailure: true },
  );
  let initializedEmpty = false;

  if (topLevel.status !== 0) {
    if (entries.length !== 0) {
      throw new Error(
        "guided_git_baseline_nonempty_nonrepo: inicialize o Git ou escolha uma pasta vazia",
      );
    }
    await git.run(rootRealPath, ["init", "--quiet"]);
    await git.run(
      rootRealPath,
      ["symbolic-ref", "HEAD", "refs/heads/main"],
    );
    initializedEmpty = true;
  } else {
    const provedTopLevel = await fs.promises.realpath(topLevel.stdout.trim());
    if (provedTopLevel !== rootRealPath) {
      throw new Error(
        "guided_git_baseline_nested_root: o workspace deve ser a raiz exata do repositório Git",
      );
    }
  }

  await assertSafeLocalGitConfigAsync(git, rootRealPath);
  const reference = await integrationRefAsync(git, rootRealPath);
  await assertCheckpointGitOperationIdleAsync(git, rootRealPath);
  const headSha = await currentHeadOrNullAsync(git, rootRealPath);
  if (!headSha) {
    if (
      entries.length !== 0 ||
      !(await cleanStatusAsync(git, rootRealPath))
    ) {
      throw new Error(
        "guided_git_baseline_unborn_with_files: faça o primeiro commit dos arquivos existentes antes de iniciar a missão",
      );
    }
    const committedHead = await commitEmptyBaselineAsync(
      git,
      rootRealPath,
      reference,
    );
    if (!(await cleanStatusAsync(git, rootRealPath))) {
      throw new Error(
        "guided_git_baseline_raced: o workspace mudou durante a criação da baseline",
      );
    }
    return Object.freeze({
      kind: initializedEmpty ? "initialized-empty" : "committed-unborn",
      rootRealPath,
      integrationRef: await integrationRefAsync(git, rootRealPath),
      headSha: committedHead,
    });
  }

  const baselineHead = (await cleanStatusAsync(git, rootRealPath))
    ? headSha
    : await checkpointDirtyWorktreeAsync(
        git,
        rootRealPath,
        reference,
      );
  return Object.freeze({
    kind: "existing",
    rootRealPath,
    integrationRef: reference,
    headSha: baselineHead,
  });
}

/**
 * Materialize a safe Git baseline before Nexus creates an isolated worktree.
 *
 * A dirty existing repository is checkpointed from a private index, promoted
 * with compare-and-swap and normalized by updating only the shared index; the
 * operator's physical bytes are never rewritten. A repository is initialized
 * only when the physical folder has zero entries. An unborn repository receives
 * an empty main-owned commit only when status is completely clean.
 */
export function ensureGuidedGitBaseline(
  scope: ProjectExecutionScope,
  dependencies: GuidedGitBaselineDeps = {},
): GuidedGitBaselineResult {
  const rootRealPath = canonicalRoot(scope);
  const git = dependencies.gitRunner ?? new ProcessGitRunner();
  const topLevel = git.run(rootRealPath, ["rev-parse", "--show-toplevel"], {
    allowFailure: true,
  });
  let initializedEmpty = false;

  if (topLevel.status !== 0) {
    if (fs.readdirSync(rootRealPath).length !== 0) {
      throw new Error(
        "guided_git_baseline_nonempty_nonrepo: inicialize o Git ou escolha uma pasta vazia",
      );
    }
    git.run(rootRealPath, ["init", "--quiet"]);
    git.run(rootRealPath, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    initializedEmpty = true;
  } else {
    const provedTopLevel = fs.realpathSync(topLevel.stdout.trim());
    if (provedTopLevel !== rootRealPath) {
      throw new Error(
        "guided_git_baseline_nested_root: o workspace deve ser a raiz exata do repositório Git",
      );
    }
  }

  assertSafeLocalGitConfig(git, rootRealPath);
  const reference = integrationRef(git, rootRealPath);
  assertCheckpointGitOperationIdle(git, rootRealPath);
  const expectedContent = dependencies.approvedIntent
    ? renderGuidedGreenfieldBrief(dependencies.approvedIntent)
    : null;
  const recoveredHead = recoverGuidedBaselineTransaction(
    git,
    rootRealPath,
    reference,
    expectedContent,
  );
  if (recoveredHead) {
    return Object.freeze({
      kind: "existing",
      rootRealPath,
      integrationRef: reference,
      headSha: recoveredHead,
    });
  }
  const head = git.run(
    rootRealPath,
    ["rev-parse", "--verify", "HEAD^{commit}"],
    { allowFailure: true },
  );
  if (head.status === 0) {
    assertCheckpointGitOperationIdle(git, rootRealPath);
    if (dependencies.approvedIntent) {
      const expected = renderGuidedGreenfieldBrief(
        dependencies.approvedIntent,
      );
      if (canonicalBriefIntentMismatch(rootRealPath, expected)) {
        throw new Error(
          "guided_greenfield_brief_intent_mismatch: PRODUCT.md pertence a outra intenção aprovada; crie uma nova pasta vazia ou retome a missão original",
        );
      }
    }
    if (!cleanStatus(git, rootRealPath)) {
      return Object.freeze({
        kind: "existing",
        rootRealPath,
        integrationRef: reference,
        headSha: checkpointDirtyWorktree(git, rootRealPath, reference),
      });
    }
    if (dependencies.approvedIntent) {
      const expected = renderGuidedGreenfieldBrief(
        dependencies.approvedIntent,
      );
      if (
        !exactCommittedBrief(git, rootRealPath, expected) &&
        physicalWorktreeEntries(rootRealPath).length === 0
      ) {
        const committedHead = commitInitialAuthority(
          git,
          rootRealPath,
          reference,
          assertSha(head.stdout.trim(), "guided integration HEAD"),
          dependencies.approvedIntent,
        );
        if (!cleanStatus(git, rootRealPath)) {
          throw new Error(
            "guided_git_baseline_raced: o workspace mudou durante a criação da baseline",
          );
        }
        return Object.freeze({
          kind: "existing",
          rootRealPath,
          integrationRef: reference,
          headSha: committedHead,
        });
      }
    }
    return Object.freeze({
      kind: "existing",
      rootRealPath,
      integrationRef: reference,
      headSha: assertSha(head.stdout.trim(), "guided integration HEAD"),
    });
  }

  if (!cleanStatus(git, rootRealPath)) {
    throw new Error(
      "guided_git_baseline_unborn_with_files: faça o primeiro commit dos arquivos existentes antes de iniciar a missão",
    );
  }
  if (physicalWorktreeEntries(rootRealPath).length !== 0) {
    throw new Error(
      "guided_git_baseline_unborn_with_files: faça o primeiro commit dos arquivos existentes antes de iniciar a missão",
    );
  }
  const committedHead = commitInitialAuthority(
    git,
    rootRealPath,
    reference,
    null,
    dependencies.approvedIntent,
  );
  if (!cleanStatus(git, rootRealPath)) {
    throw new Error(
      "guided_git_baseline_raced: o workspace mudou durante a criação da baseline",
    );
  }
  return Object.freeze({
    kind: initializedEmpty ? "initialized-empty" : "committed-unborn",
    rootRealPath,
    integrationRef: integrationRef(git, rootRealPath),
    headSha: committedHead,
  });
}

/**
 * Plan mode may be resumed after it already wrote its sole authorized
 * artifact. Prove/create the baseline while allowing only unstaged
 * plan.md/docs/plan.md drift; every unrelated or staged path remains
 * fail-closed and promotion later binds the exact bytes to the handoff.
 */
export function ensurePlanLaneGitBaseline(
  scope: ProjectExecutionScope,
  dependencies: GuidedGitBaselineDeps = {},
): GuidedGitBaselineResult {
  const rootRealPath = canonicalRoot(scope);
  const git = dependencies.gitRunner ?? new ProcessGitRunner();
  const topLevel = git.run(rootRealPath, ["rev-parse", "--show-toplevel"], {
    allowFailure: true,
  });
  if (topLevel.status !== 0) {
    return ensureGuidedGitBaseline(scope, dependencies);
  }
  if (fs.realpathSync(topLevel.stdout.trim()) !== rootRealPath) {
    return ensureGuidedGitBaseline(scope, dependencies);
  }
  const head = git.run(
    rootRealPath,
    ["rev-parse", "--verify", "HEAD^{commit}"],
    { allowFailure: true },
  );
  if (head.status !== 0) {
    return ensureGuidedGitBaseline(scope, dependencies);
  }

  assertSafeLocalGitConfig(git, rootRealPath);
  const records = git
    .run(rootRealPath, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ])
    .stdout.split("\0")
    .filter(Boolean);
  if (records.length > 0) {
    const baselineIdentity = git
      .run(rootRealPath, [
        "show",
        "-s",
        "--format=%an%x00%ae%x00%s",
        "HEAD",
      ])
      .stdout.trimEnd()
      .split("\0");
    const baselineTree = git.run(rootRealPath, [
      "ls-tree",
      "-r",
      "--name-only",
      "-z",
      "HEAD",
    ]).stdout;
    if (
      baselineTree.length > 0 ||
      baselineIdentity[0] !== "Nexus" ||
      baselineIdentity[1] !== "nexus@localhost" ||
      baselineIdentity[2] !== "chore: initialize Nexus workspace"
    ) {
      throw new Error(
        "guided_plan_git_dirty: alterações preexistentes não podem ser adotadas pela lane plan",
      );
    }
  }
  for (const record of records) {
    const relativePath = record.slice(3).replaceAll("\\", "/");
    const unstagedTracked = record[0] === " " && record[1] !== " ";
    const untracked = record[0] === "?" && record[1] === "?";
    if (
      record.length < 4 ||
      (!unstagedTracked && !untracked) ||
      !isPlanLaneWritablePath(relativePath)
    ) {
      throw new Error(
        "guided_plan_git_dirty: somente plan.md/docs/plan.md unstaged pode existir antes da CLI plan",
      );
    }
  }
  return Object.freeze({
    kind: "existing",
    rootRealPath,
    integrationRef: integrationRef(git, rootRealPath),
    headSha: assertSha(head.stdout.trim(), "guided plan HEAD"),
  });
}
