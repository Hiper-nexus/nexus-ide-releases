import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isPlanLaneWritablePath } from "../../shared/mission-intent";
import type { ProjectExecutionScope } from "../../shared/types";
import {
  ProcessGitRunner,
  assertSafeLocalGitConfig,
  createPrivateGitIndex,
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

const BASELINE_COMMIT_ENV = Object.freeze({
  GIT_AUTHOR_NAME: "Nexus",
  GIT_AUTHOR_EMAIL: "nexus@localhost",
  GIT_COMMITTER_NAME: "Nexus",
  GIT_COMMITTER_EMAIL: "nexus@localhost",
});
const EMPTY_BASELINE_COMMIT_MESSAGE = "chore: initialize Nexus workspace";
const BRIEF_BASELINE_COMMIT_MESSAGE =
  "docs: record approved Nexus greenfield brief";
const BASELINE_TRANSACTION_REF_PREFIX =
  "refs/nexus/transactions/guided-baseline";

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

/**
 * Materialize the only safe Git baseline variants for beginner greenfields.
 *
 * Existing repositories are never rewritten. A repository is initialized only
 * when the physical folder has zero entries. An unborn repository receives an
 * empty main-owned commit only when status is completely clean, so Nexus never
 * stages or adopts user files merely to make WorktreeManager operational.
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
      throw new Error(
        "guided_git_baseline_dirty: deixe o workspace limpo antes de iniciar a missão",
      );
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
