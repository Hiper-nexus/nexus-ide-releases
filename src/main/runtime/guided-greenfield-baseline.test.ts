import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectExecutionScope } from "../../shared/types";
import {
  ensureGuidedGitBaseline,
  ensureGuidedGitBaselineForWorktreeAsync,
  ensureGuidedGitBaselineBeforeContext,
  ensurePlanLaneGitBaseline,
} from "./guided-greenfield-baseline";
import {
  GUIDED_GREENFIELD_BRIEF_PATH,
  parseGuidedGreenfieldBrief,
  renderGuidedGreenfieldBrief,
} from "./guided-greenfield-brief";
import {
  AsyncProcessGitRunner,
  ProcessGitRunner,
  type AsyncGitRunner,
  type GitResult,
  type GitRunOptions,
  type GitRunner,
} from "./git-command";

const roots: string[] = [];
const approvedIntent = Object.freeze({
  goal: "Entregar o primeiro produto sem inventar requisitos",
  acceptanceCriteria: Object.freeze([
    "O resultado satisfaz exatamente o objetivo aprovado",
    "As escolhas técnicas são verificadas antes da entrega",
  ]),
});

function scopeFor(root: string): ProjectExecutionScope {
  return {
    version: 1,
    installationId: "installation-context-baseline",
    projectId: "project-context-baseline",
    checkoutId: "checkout-context-baseline",
    rootRealPath: fs.realpathSync(root),
    identitySource: "manifest",
  };
}

function freshRoot(name: string): string {
  const parent = fs.mkdtempSync(
    path.join(os.tmpdir(), "nexus-context-baseline-"),
  );
  roots.push(parent);
  const root = path.join(parent, name);
  fs.mkdirSync(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("guided baseline before context bootstrap", () => {
  it("commits a physically empty folder before Doctor can create .context", () => {
    const root = freshRoot("empty");
    const receipt = ensureGuidedGitBaselineBeforeContext(scopeFor(root), {
      approvedIntent,
    });
    const brief = fs.readFileSync(
      path.join(root, GUIDED_GREENFIELD_BRIEF_PATH),
      "utf8",
    );

    expect(receipt).toMatchObject({ kind: "initialized-empty" });
    expect(brief).toBe(renderGuidedGreenfieldBrief(approvedIntent));
    expect(parseGuidedGreenfieldBrief(brief)).toEqual(approvedIntent);
    expect(brief).toContain("Explicit unknowns");
    expect(brief).not.toMatch(
      /\b(?:React|Node\.js|PostgreSQL|subscription|per-seat)\b/i,
    );
    expect(
      new ProcessGitRunner()
        .run(root, ["rev-parse", "--verify", "HEAD^{commit}"])
        .stdout.trim(),
    ).toBe(receipt?.headSha);
    expect(
      new ProcessGitRunner().run(root, [
        "show",
        `HEAD:${GUIDED_GREENFIELD_BRIEF_PATH}`,
      ]).stdout,
    ).toBe(brief);
  });

  it("is idempotent and never rewrites the committed exact brief", () => {
    const root = freshRoot("idempotent");
    const scope = scopeFor(root);
    const first = ensureGuidedGitBaselineBeforeContext(scope, {
      approvedIntent,
    });
    const firstContent = fs.readFileSync(
      path.join(root, GUIDED_GREENFIELD_BRIEF_PATH),
      "utf8",
    );
    const second = ensureGuidedGitBaselineBeforeContext(scope, {
      approvedIntent,
    });

    expect(second?.headSha).toBe(first?.headSha);
    expect(
      fs.readFileSync(path.join(root, GUIDED_GREENFIELD_BRIEF_PATH), "utf8"),
    ).toBe(firstContent);
    expect(
      new ProcessGitRunner()
        .run(root, ["rev-list", "--count", "HEAD"])
        .stdout.trim(),
    ).toBe("1");
  });

  it("rejects mission B against the canonical brief for mission A without rewriting it", () => {
    const root = freshRoot("intent-mismatch");
    const scope = scopeFor(root);
    const first = ensureGuidedGitBaselineBeforeContext(scope, {
      approvedIntent,
    });
    const briefA = fs.readFileSync(
      path.join(root, GUIDED_GREENFIELD_BRIEF_PATH),
      "utf8",
    );

    expect(() =>
      ensureGuidedGitBaselineBeforeContext(scope, {
        approvedIntent: {
          goal: "Missão B incompatível",
          acceptanceCriteria: ["Critério B"],
        },
      }),
    ).toThrow(/brief_intent_mismatch.*outra intenção aprovada/i);
    expect(
      fs.readFileSync(path.join(root, GUIDED_GREENFIELD_BRIEF_PATH), "utf8"),
    ).toBe(briefA);
    expect(
      new ProcessGitRunner().run(root, ["rev-parse", "HEAD"]).stdout.trim(),
    ).toBe(first?.headSha);
    expect(
      new ProcessGitRunner().run(root, ["status", "--porcelain=v1"]).stdout,
    ).toBe("");
  });

  it("never adopts a nonempty non-repository folder", () => {
    const root = freshRoot("user-files");
    fs.writeFileSync(path.join(root, "notes.txt"), "user-owned\n");

    expect(
      ensureGuidedGitBaselineBeforeContext(scopeFor(root), {
        approvedIntent,
      }),
    ).toBeNull();
    expect(fs.existsSync(path.join(root, ".git"))).toBe(false);
    expect(
      fs.existsSync(path.join(root, GUIDED_GREENFIELD_BRIEF_PATH)),
    ).toBe(false);
    expect(fs.readFileSync(path.join(root, "notes.txt"), "utf8")).toBe(
      "user-owned\n",
    );
  });

  it("leaves an existing dirty repository untouched for the later worker gate", () => {
    const root = freshRoot("existing");
    const git = new ProcessGitRunner();
    git.run(root, ["init", "--quiet"]);
    git.run(root, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    git.run(
      root,
      ["commit", "--allow-empty", "-m", "existing baseline"],
      {
        env: {
          GIT_AUTHOR_NAME: "Test",
          GIT_AUTHOR_EMAIL: "test@localhost",
          GIT_COMMITTER_NAME: "Test",
          GIT_COMMITTER_EMAIL: "test@localhost",
        },
      },
    );
    fs.writeFileSync(path.join(root, "notes.txt"), "dirty user state\n");

    expect(
      ensureGuidedGitBaselineBeforeContext(scopeFor(root), {
        approvedIntent,
      }),
    ).toBeNull();
    expect(
      fs.existsSync(path.join(root, GUIDED_GREENFIELD_BRIEF_PATH)),
    ).toBe(false);
    expect(
      git.run(root, ["status", "--porcelain=v1"]).stdout,
    ).toContain("notes.txt");
  });

  it("recovers a crash after PRODUCT branch CAS without creating a second commit", () => {
    const root = freshRoot("brief-crash-recovery");
    const scope = scopeFor(root);
    const base = new ProcessGitRunner();
    let crashed = false;
    const crashingRunner: GitRunner = {
      run(
        cwd: string,
        args: readonly string[],
        options?: GitRunOptions,
      ): GitResult {
        if (
          !crashed &&
          args[0] === "reset" &&
          args.includes(GUIDED_GREENFIELD_BRIEF_PATH)
        ) {
          crashed = true;
          throw new Error("injected crash after PRODUCT branch CAS");
        }
        return base.run(cwd, args, options);
      },
    };

    expect(() =>
      ensureGuidedGitBaselineBeforeContext(scope, {
        approvedIntent,
        gitRunner: crashingRunner,
      }),
    ).toThrow(/injected crash/i);
    const committedHead = base.run(root, ["rev-parse", "HEAD"]).stdout.trim();

    expect(
      ensureGuidedGitBaselineBeforeContext(scope, { approvedIntent }),
    ).toMatchObject({ headSha: committedHead });
    expect(base.run(root, ["rev-list", "--count", "HEAD"]).stdout.trim()).toBe(
      "1",
    );
    expect(base.run(root, ["status", "--porcelain=v1"]).stdout).toBe("");
    expect(
      base.run(root, [
        "for-each-ref",
        "--format=%(refname)",
        "refs/nexus/transactions/guided-baseline",
      ]).stdout,
    ).toBe("");
  });

  it("recovers a crash immediately after journaling without leaving an untracked PRODUCT orphan", () => {
    const root = freshRoot("brief-journal-crash");
    const scope = scopeFor(root);
    const base = new ProcessGitRunner();
    let crashed = false;
    const crashingRunner: GitRunner = {
      run(
        cwd: string,
        args: readonly string[],
        options?: GitRunOptions,
      ): GitResult {
        const result = base.run(cwd, args, options);
        if (
          !crashed &&
          args[0] === "update-ref" &&
          args[1]?.startsWith("refs/nexus/transactions/guided-baseline/")
        ) {
          crashed = true;
          throw new Error("injected crash after PRODUCT journal");
        }
        return result;
      },
    };

    expect(() =>
      ensureGuidedGitBaselineBeforeContext(scope, {
        approvedIntent,
        gitRunner: crashingRunner,
      }),
    ).toThrow(/injected crash/i);
    expect(fs.existsSync(path.join(root, GUIDED_GREENFIELD_BRIEF_PATH))).toBe(
      false,
    );

    const recovered = ensureGuidedGitBaselineBeforeContext(scope, {
      approvedIntent,
    });
    expect(recovered?.headSha).toMatch(/^[a-f0-9]{40,64}$/);
    expect(
      base.run(root, ["show", "HEAD:PRODUCT.md"]).stdout,
    ).toBe(renderGuidedGreenfieldBrief(approvedIntent));
    expect(base.run(root, ["status", "--porcelain=v1"]).stdout).toBe("");
  });

  it("cleans only the journal-proven PRODUCT artifact when a concurrent commit wins CAS", () => {
    const root = freshRoot("brief-parent-race");
    const scope = scopeFor(root);
    const base = new ProcessGitRunner();
    let raced = false;
    const racingRunner: GitRunner = {
      run(
        cwd: string,
        args: readonly string[],
        options?: GitRunOptions,
      ): GitResult {
        if (
          !raced &&
          args[0] === "update-ref" &&
          args[1]?.startsWith("refs/heads/")
        ) {
          raced = true;
          base.run(cwd, ["commit", "--allow-empty", "-m", "concurrent baseline"], {
            env: {
              GIT_AUTHOR_NAME: "Concurrent",
              GIT_AUTHOR_EMAIL: "concurrent@localhost",
              GIT_COMMITTER_NAME: "Concurrent",
              GIT_COMMITTER_EMAIL: "concurrent@localhost",
            },
          });
        }
        return base.run(cwd, args, options);
      },
    };

    expect(() =>
      ensureGuidedGitBaselineBeforeContext(scope, {
        approvedIntent,
        gitRunner: racingRunner,
      }),
    ).toThrow();
    expect(fs.existsSync(path.join(root, GUIDED_GREENFIELD_BRIEF_PATH))).toBe(
      true,
    );
    expect(() =>
      ensureGuidedGitBaselineBeforeContext(scope, { approvedIntent }),
    ).toThrow(/parent_raced/i);
    expect(fs.existsSync(path.join(root, GUIDED_GREENFIELD_BRIEF_PATH))).toBe(
      false,
    );

    const completed = ensureGuidedGitBaselineBeforeContext(scope, {
      approvedIntent,
    });
    expect(completed?.kind).toBe("existing");
    expect(base.run(root, ["status", "--porcelain=v1"]).stdout).toBe("");
    expect(
      base.run(
        root,
        ["cat-file", "-e", "HEAD:PRODUCT.md"],
        { allowFailure: true },
      ).status,
    ).toBe(0);
  });

  it("never includes a concurrently staged unrelated file in the private baseline tree", () => {
    const root = freshRoot("brief-private-index");
    const scope = scopeFor(root);
    const base = new ProcessGitRunner();
    let statusCalls = 0;
    const racingRunner: GitRunner = {
      run(
        cwd: string,
        args: readonly string[],
        options?: GitRunOptions,
      ): GitResult {
        const result = base.run(cwd, args, options);
        if (
          args[0] === "status" &&
          args.includes("--untracked-files=all") &&
          ++statusCalls === 2
        ) {
          fs.writeFileSync(path.join(cwd, "secret.txt"), "must stay out\n");
          base.run(cwd, ["add", "--", "secret.txt"]);
        }
        return result;
      },
    };

    expect(() =>
      ensureGuidedGitBaselineBeforeContext(scope, {
        approvedIntent,
        gitRunner: racingRunner,
      }),
    ).toThrow(/raced/i);
    expect(
      base.run(
        root,
        ["cat-file", "-e", "HEAD:secret.txt"],
        { allowFailure: true },
      ).status,
    ).not.toBe(0);
    expect(base.run(root, ["show", "HEAD:PRODUCT.md"]).stdout).toBe(
      renderGuidedGreenfieldBrief(approvedIntent),
    );
  });
});

describe("guided dirty checkout checkpoint", () => {
  it("refuses an untracked credential-like file without moving HEAD or the index", async () => {
    const root = freshRoot("dirty-untracked-secret");
    const scope = scopeFor(root);
    const git = new ProcessGitRunner();
    git.run(root, ["init", "--quiet", "-b", "main"]);
    fs.writeFileSync(path.join(root, "app.txt"), "base\n");
    git.run(root, ["add", "--", "app.txt"]);
    git.run(root, ["commit", "-m", "user baseline"], {
      env: {
        GIT_AUTHOR_NAME: "User",
        GIT_AUTHOR_EMAIL: "user@localhost",
        GIT_COMMITTER_NAME: "User",
        GIT_COMMITTER_EMAIL: "user@localhost",
      },
    });
    const priorHead = git.run(root, ["rev-parse", "HEAD"]).stdout.trim();
    fs.writeFileSync(path.join(root, ".env.local"), "API_TOKEN=real-secret\n");

    await expect(
      ensureGuidedGitBaselineForWorktreeAsync(scope),
    ).rejects.toThrow(/untracked credential/i);

    expect(git.run(root, ["rev-parse", "HEAD"]).stdout.trim()).toBe(priorHead);
    expect(
      git.run(root, ["status", "--porcelain=v1"]).stdout,
    ).toBe("?? .env.local\n");
    expect(fs.readFileSync(path.join(root, ".env.local"), "utf8")).toBe(
      "API_TOKEN=real-secret\n",
    );
  });

  it("keeps normal templates and explicitly staged credential-like paths in the checkpoint", () => {
    const root = freshRoot("dirty-explicit-secret");
    const scope = scopeFor(root);
    const git = new ProcessGitRunner();
    git.run(root, ["init", "--quiet", "-b", "main"]);
    fs.writeFileSync(path.join(root, "app.txt"), "base\n");
    git.run(root, ["add", "--", "app.txt"]);
    git.run(root, ["commit", "-m", "user baseline"], {
      env: {
        GIT_AUTHOR_NAME: "User",
        GIT_AUTHOR_EMAIL: "user@localhost",
        GIT_COMMITTER_NAME: "User",
        GIT_COMMITTER_EMAIL: "user@localhost",
      },
    });
    fs.writeFileSync(path.join(root, ".env.example"), "API_TOKEN=\n");
    fs.writeFileSync(path.join(root, ".env.local"), "API_TOKEN=approved\n");
    git.run(root, ["add", "--", ".env.local"]);

    ensureGuidedGitBaseline(scope);

    expect(git.run(root, ["status", "--porcelain=v1"]).stdout).toBe("");
    expect(git.run(root, ["show", "HEAD:.env.example"]).stdout).toBe(
      "API_TOKEN=\n",
    );
    expect(git.run(root, ["show", "HEAD:.env.local"]).stdout).toBe(
      "API_TOKEN=approved\n",
    );
  });

  it("checkpoints a dirty repository without blocking the event loop", async () => {
    const root = freshRoot("dirty-checkpoint-async");
    const scope = scopeFor(root);
    const git = new ProcessGitRunner();
    git.run(root, ["init", "--quiet", "-b", "main"]);
    fs.writeFileSync(path.join(root, "app.txt"), "base\n");
    git.run(root, ["add", "--", "app.txt"]);
    git.run(root, ["commit", "-m", "user baseline"], {
      env: {
        GIT_AUTHOR_NAME: "User",
        GIT_AUTHOR_EMAIL: "user@localhost",
        GIT_COMMITTER_NAME: "User",
        GIT_COMMITTER_EMAIL: "user@localhost",
      },
    });
    fs.writeFileSync(path.join(root, "app.txt"), "operator view\n");

    const delegate = new AsyncProcessGitRunner();
    let commands = 0;
    const asyncGit: AsyncGitRunner = {
      async run(cwd, args, options) {
        commands += 1;
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
        return delegate.run(cwd, args, options);
      },
    };
    let timerFired = false;
    const pending = ensureGuidedGitBaselineForWorktreeAsync(scope, {
      asyncGitRunner: asyncGit,
    });
    setTimeout(() => {
      timerFired = true;
    }, 0);
    const receipt = await pending;

    expect(timerFired).toBe(true);
    expect(commands).toBeGreaterThan(5);
    expect(git.run(root, ["status", "--porcelain=v1"]).stdout).toBe("");
    expect(git.run(root, ["show", "HEAD:app.txt"]).stdout).toBe(
      "operator view\n",
    );
    expect(receipt.headSha).toBe(
      git.run(root, ["rev-parse", "HEAD"]).stdout.trim(),
    );
  });

  it("coalesces concurrent baseline probes for the same physical workspace", async () => {
    const root = freshRoot("concurrent-baseline");
    const scope = scopeFor(root);
    const git = new ProcessGitRunner();
    git.run(root, ["init", "--quiet", "-b", "main"]);
    fs.writeFileSync(path.join(root, "app.txt"), "base\n");
    git.run(root, ["add", "--", "app.txt"]);
    git.run(root, ["commit", "-m", "user baseline"], {
      env: {
        GIT_AUTHOR_NAME: "User",
        GIT_AUTHOR_EMAIL: "user@localhost",
        GIT_COMMITTER_NAME: "User",
        GIT_COMMITTER_EMAIL: "user@localhost",
      },
    });

    const delegate = new AsyncProcessGitRunner();
    let topLevelProbes = 0;
    const asyncGit: AsyncGitRunner = {
      async run(cwd, args, options) {
        if (
          args[0] === "rev-parse" &&
          args[1] === "--show-toplevel"
        ) {
          topLevelProbes += 1;
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
        return delegate.run(cwd, args, options);
      },
    };

    const [first, second, third] = await Promise.all([
      ensureGuidedGitBaselineForWorktreeAsync(scope, {
        asyncGitRunner: asyncGit,
      }),
      ensureGuidedGitBaselineForWorktreeAsync(scope, {
        asyncGitRunner: asyncGit,
      }),
      ensureGuidedGitBaselineForWorktreeAsync(scope, {
        asyncGitRunner: asyncGit,
      }),
    ]);

    expect(topLevelProbes).toBe(1);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it("clears a failed concurrent baseline so a later dispatch can retry", async () => {
    const root = freshRoot("retry-baseline");
    const scope = scopeFor(root);
    const git = new ProcessGitRunner();
    git.run(root, ["init", "--quiet", "-b", "main"]);
    fs.writeFileSync(path.join(root, "app.txt"), "base\n");
    git.run(root, ["add", "--", "app.txt"]);
    git.run(root, ["commit", "-m", "user baseline"], {
      env: {
        GIT_AUTHOR_NAME: "User",
        GIT_AUTHOR_EMAIL: "user@localhost",
        GIT_COMMITTER_NAME: "User",
        GIT_COMMITTER_EMAIL: "user@localhost",
      },
    });

    const delegate = new AsyncProcessGitRunner();
    let topLevelProbes = 0;
    const asyncGit: AsyncGitRunner = {
      async run(cwd, args, options) {
        if (
          args[0] === "rev-parse" &&
          args[1] === "--show-toplevel"
        ) {
          topLevelProbes += 1;
          if (topLevelProbes === 1) {
            throw new Error("transient baseline probe failure");
          }
        }
        return delegate.run(cwd, args, options);
      },
    };

    await expect(
      ensureGuidedGitBaselineForWorktreeAsync(scope, {
        asyncGitRunner: asyncGit,
      }),
    ).rejects.toThrow("transient baseline probe failure");

    await expect(
      ensureGuidedGitBaselineForWorktreeAsync(scope, {
        asyncGitRunner: asyncGit,
      }),
    ).resolves.toMatchObject({ kind: "existing" });
    expect(topLevelProbes).toBe(2);
  });

  it("promotes the exact tracked, staged and untracked operator view without rewriting bytes", () => {
    const root = freshRoot("dirty-checkpoint");
    const scope = scopeFor(root);
    const git = new ProcessGitRunner();
    git.run(root, ["init", "--quiet", "-b", "main"]);
    fs.writeFileSync(path.join(root, "tracked.txt"), "tracked base\n");
    fs.writeFileSync(path.join(root, "removed.txt"), "remove me\n");
    git.run(root, ["add", "--", "tracked.txt", "removed.txt"]);
    git.run(root, ["commit", "-m", "user baseline"], {
      env: {
        GIT_AUTHOR_NAME: "User",
        GIT_AUTHOR_EMAIL: "user@localhost",
        GIT_COMMITTER_NAME: "User",
        GIT_COMMITTER_EMAIL: "user@localhost",
      },
    });
    const priorHead = git.run(root, ["rev-parse", "HEAD"]).stdout.trim();

    fs.writeFileSync(path.join(root, "tracked.txt"), "tracked working\n");
    fs.writeFileSync(path.join(root, "staged.txt"), "staged version\n");
    git.run(root, ["add", "--", "staged.txt"]);
    fs.writeFileSync(
      path.join(root, "staged.txt"),
      "working version after stage\n",
    );
    fs.writeFileSync(path.join(root, "untracked.txt"), "untracked bytes\n");
    fs.unlinkSync(path.join(root, "removed.txt"));

    const receipt = ensureGuidedGitBaseline(scope);

    expect(receipt.headSha).not.toBe(priorHead);
    expect(git.run(root, ["rev-parse", "HEAD"]).stdout.trim()).toBe(
      receipt.headSha,
    );
    expect(
      git.run(root, ["rev-parse", `${receipt.headSha}^`]).stdout.trim(),
    ).toBe(priorHead);
    expect(git.run(root, ["status", "--porcelain=v1"]).stdout).toBe("");
    expect(git.run(root, ["show", "HEAD:tracked.txt"]).stdout).toBe(
      "tracked working\n",
    );
    expect(git.run(root, ["show", "HEAD:staged.txt"]).stdout).toBe(
      "working version after stage\n",
    );
    expect(git.run(root, ["show", "HEAD:untracked.txt"]).stdout).toBe(
      "untracked bytes\n",
    );
    expect(
      git.run(root, ["cat-file", "-e", "HEAD:removed.txt"], {
        allowFailure: true,
      }).status,
    ).not.toBe(0);
    expect(fs.readFileSync(path.join(root, "tracked.txt"), "utf8")).toBe(
      "tracked working\n",
    );
    expect(fs.readFileSync(path.join(root, "staged.txt"), "utf8")).toBe(
      "working version after stage\n",
    );
    expect(fs.readFileSync(path.join(root, "untracked.txt"), "utf8")).toBe(
      "untracked bytes\n",
    );
  });

  it("recovers idempotently when the process stops after branch CAS but before index normalization", () => {
    const root = freshRoot("dirty-checkpoint-recovery");
    const scope = scopeFor(root);
    const base = new ProcessGitRunner();
    base.run(root, ["init", "--quiet", "-b", "main"]);
    fs.writeFileSync(path.join(root, "app.txt"), "base\n");
    base.run(root, ["add", "--", "app.txt"]);
    base.run(root, ["commit", "-m", "user baseline"], {
      env: {
        GIT_AUTHOR_NAME: "User",
        GIT_AUTHOR_EMAIL: "user@localhost",
        GIT_COMMITTER_NAME: "User",
        GIT_COMMITTER_EMAIL: "user@localhost",
      },
    });
    fs.writeFileSync(path.join(root, "app.txt"), "operator view\n");
    let crashed = false;
    const crashingRunner: GitRunner = {
      run(
        cwd: string,
        args: readonly string[],
        options?: GitRunOptions,
      ): GitResult {
        if (
          !crashed &&
          args[0] === "read-tree" &&
          !options?.privateIndexFile
        ) {
          crashed = true;
          throw new Error("injected crash before shared index normalization");
        }
        return base.run(cwd, args, options);
      },
    };

    expect(() =>
      ensureGuidedGitBaseline(scope, { gitRunner: crashingRunner }),
    ).toThrow(/injected crash/i);
    const promotedHead = base.run(root, ["rev-parse", "HEAD"]).stdout.trim();
    expect(base.run(root, ["status", "--porcelain=v1"]).stdout).not.toBe("");

    const recovered = ensureGuidedGitBaseline(scope);

    expect(recovered.headSha).toBe(promotedHead);
    expect(base.run(root, ["rev-list", "--count", "HEAD"]).stdout.trim()).toBe(
      "2",
    );
    expect(base.run(root, ["status", "--porcelain=v1"]).stdout).toBe("");
    expect(fs.readFileSync(path.join(root, "app.txt"), "utf8")).toBe(
      "operator view\n",
    );
    expect(
      base.run(root, [
        "for-each-ref",
        "--format=%(refname)",
        "refs/nexus/transactions/guided-baseline",
      ]).stdout,
    ).toBe("");
  });

  it("retries a bounded branch CAS race and returns the head actually promoted", () => {
    const root = freshRoot("dirty-checkpoint-race");
    const scope = scopeFor(root);
    const base = new ProcessGitRunner();
    base.run(root, ["init", "--quiet", "-b", "main"]);
    fs.writeFileSync(path.join(root, "app.txt"), "base\n");
    base.run(root, ["add", "--", "app.txt"]);
    base.run(root, ["commit", "-m", "user baseline"], {
      env: {
        GIT_AUTHOR_NAME: "User",
        GIT_AUTHOR_EMAIL: "user@localhost",
        GIT_COMMITTER_NAME: "User",
        GIT_COMMITTER_EMAIL: "user@localhost",
      },
    });
    fs.writeFileSync(path.join(root, "app.txt"), "operator view\n");
    let concurrentHead = "";
    let raced = false;
    const racingRunner: GitRunner = {
      run(
        cwd: string,
        args: readonly string[],
        options?: GitRunOptions,
      ): GitResult {
        if (
          !raced &&
          args[0] === "update-ref" &&
          args[1] === "refs/heads/main"
        ) {
          raced = true;
          const parent = base.run(cwd, ["rev-parse", "HEAD"]).stdout.trim();
          const tree = base
            .run(cwd, ["rev-parse", `${parent}^{tree}`])
            .stdout.trim();
          concurrentHead = base
            .run(
              cwd,
              [
                "commit-tree",
                tree,
                "-p",
                parent,
                "-m",
                "concurrent ref advance",
              ],
              {
                env: {
                  GIT_AUTHOR_NAME: "Concurrent",
                  GIT_AUTHOR_EMAIL: "concurrent@localhost",
                  GIT_COMMITTER_NAME: "Concurrent",
                  GIT_COMMITTER_EMAIL: "concurrent@localhost",
                },
              },
            )
            .stdout.trim();
          base.run(cwd, [
            "update-ref",
            "refs/heads/main",
            concurrentHead,
            parent,
          ]);
        }
        return base.run(cwd, args, options);
      },
    };

    const receipt = ensureGuidedGitBaseline(scope, {
      gitRunner: racingRunner,
    });

    expect(raced).toBe(true);
    expect(
      base.run(root, ["rev-parse", `${receipt.headSha}^`]).stdout.trim(),
    ).toBe(concurrentHead);
    expect(base.run(root, ["rev-parse", "HEAD"]).stdout.trim()).toBe(
      receipt.headSha,
    );
    expect(base.run(root, ["show", "HEAD:app.txt"]).stdout).toBe(
      "operator view\n",
    );
    expect(base.run(root, ["status", "--porcelain=v1"]).stdout).toBe("");
  });

  it("captures a physical mutation that lands immediately after branch CAS", () => {
    const root = freshRoot("dirty-checkpoint-post-cas-mutation");
    const scope = scopeFor(root);
    const base = new ProcessGitRunner();
    base.run(root, ["init", "--quiet", "-b", "main"]);
    fs.writeFileSync(path.join(root, "app.txt"), "base\n");
    base.run(root, ["add", "--", "app.txt"]);
    base.run(root, ["commit", "-m", "user baseline"], {
      env: {
        GIT_AUTHOR_NAME: "User",
        GIT_AUTHOR_EMAIL: "user@localhost",
        GIT_COMMITTER_NAME: "User",
        GIT_COMMITTER_EMAIL: "user@localhost",
      },
    });
    fs.writeFileSync(path.join(root, "app.txt"), "first operator view\n");
    let mutated = false;
    const racingRunner: GitRunner = {
      run(
        cwd: string,
        args: readonly string[],
        options?: GitRunOptions,
      ): GitResult {
        const result = base.run(cwd, args, options);
        if (
          !mutated &&
          args[0] === "update-ref" &&
          args[1] === "refs/heads/main" &&
          result.status === 0
        ) {
          mutated = true;
          fs.writeFileSync(
            path.join(cwd, "app.txt"),
            "latest operator view\n",
          );
        }
        return result;
      },
    };

    const receipt = ensureGuidedGitBaseline(scope, {
      gitRunner: racingRunner,
    });

    expect(mutated).toBe(true);
    expect(base.run(root, ["show", "HEAD:app.txt"]).stdout).toBe(
      "latest operator view\n",
    );
    expect(fs.readFileSync(path.join(root, "app.txt"), "utf8")).toBe(
      "latest operator view\n",
    );
    expect(base.run(root, ["rev-parse", "HEAD"]).stdout.trim()).toBe(
      receipt.headSha,
    );
    expect(base.run(root, ["status", "--porcelain=v1"]).stdout).toBe("");
  });

  it("fails explicitly after the bounded CAS race limit without touching bytes", () => {
    const root = freshRoot("dirty-checkpoint-race-limit");
    const scope = scopeFor(root);
    const base = new ProcessGitRunner();
    base.run(root, ["init", "--quiet", "-b", "main"]);
    fs.writeFileSync(path.join(root, "app.txt"), "base\n");
    base.run(root, ["add", "--", "app.txt"]);
    base.run(root, ["commit", "-m", "user baseline"], {
      env: {
        GIT_AUTHOR_NAME: "User",
        GIT_AUTHOR_EMAIL: "user@localhost",
        GIT_COMMITTER_NAME: "User",
        GIT_COMMITTER_EMAIL: "user@localhost",
      },
    });
    fs.writeFileSync(path.join(root, "app.txt"), "operator bytes\n");
    let races = 0;
    const racingRunner: GitRunner = {
      run(
        cwd: string,
        args: readonly string[],
        options?: GitRunOptions,
      ): GitResult {
        if (
          args[0] === "update-ref" &&
          args[1] === "refs/heads/main"
        ) {
          races += 1;
          const parent = base.run(cwd, ["rev-parse", "HEAD"]).stdout.trim();
          const tree = base
            .run(cwd, ["rev-parse", `${parent}^{tree}`])
            .stdout.trim();
          const concurrent = base
            .run(
              cwd,
              [
                "commit-tree",
                tree,
                "-p",
                parent,
                "-m",
                `concurrent ${races}`,
              ],
              {
                env: {
                  GIT_AUTHOR_NAME: "Concurrent",
                  GIT_AUTHOR_EMAIL: "concurrent@localhost",
                  GIT_COMMITTER_NAME: "Concurrent",
                  GIT_COMMITTER_EMAIL: "concurrent@localhost",
                },
              },
            )
            .stdout.trim();
          base.run(cwd, [
            "update-ref",
            "refs/heads/main",
            concurrent,
            parent,
          ]);
        }
        return base.run(cwd, args, options);
      },
    };

    expect(() =>
      ensureGuidedGitBaseline(scope, { gitRunner: racingRunner }),
    ).toThrow(/continuou mudando após 4 tentativas atômicas/i);
    expect(races).toBe(4);
    expect(fs.readFileSync(path.join(root, "app.txt"), "utf8")).toBe(
      "operator bytes\n",
    );
  });

  it("rejects a same-SHA branch switch instead of normalizing the wrong index", () => {
    const root = freshRoot("dirty-checkpoint-branch-switch");
    const scope = scopeFor(root);
    const base = new ProcessGitRunner();
    base.run(root, ["init", "--quiet", "-b", "main"]);
    fs.writeFileSync(path.join(root, "app.txt"), "base\n");
    base.run(root, ["add", "--", "app.txt"]);
    base.run(root, ["commit", "-m", "user baseline"], {
      env: {
        GIT_AUTHOR_NAME: "User",
        GIT_AUTHOR_EMAIL: "user@localhost",
        GIT_COMMITTER_NAME: "User",
        GIT_COMMITTER_EMAIL: "user@localhost",
      },
    });
    fs.writeFileSync(path.join(root, "app.txt"), "operator bytes\n");
    let switched = false;
    const switchingRunner: GitRunner = {
      run(
        cwd: string,
        args: readonly string[],
        options?: GitRunOptions,
      ): GitResult {
        const result = base.run(cwd, args, options);
        if (
          !switched &&
          args[0] === "update-ref" &&
          args[1] === "refs/heads/main" &&
          result.status === 0
        ) {
          switched = true;
          const promoted = base.run(cwd, ["rev-parse", "HEAD"]).stdout.trim();
          base.run(cwd, ["update-ref", "refs/heads/other", promoted]);
          base.run(cwd, ["symbolic-ref", "HEAD", "refs/heads/other"]);
        }
        return result;
      },
    };

    expect(() =>
      ensureGuidedGitBaseline(scope, { gitRunner: switchingRunner }),
    ).toThrow(/branch ativa mudou/i);
    expect(switched).toBe(true);
    expect(
      base.run(root, ["rev-parse", "refs/heads/main"]).stdout.trim(),
    ).toBe(base.run(root, ["rev-parse", "refs/heads/other"]).stdout.trim());
    expect(fs.readFileSync(path.join(root, "app.txt"), "utf8")).toBe(
      "operator bytes\n",
    );
  });

  it("does not checkpoint while a Git operation owns the shared index", () => {
    const root = freshRoot("dirty-checkpoint-merge-active");
    const scope = scopeFor(root);
    const git = new ProcessGitRunner();
    git.run(root, ["init", "--quiet", "-b", "main"]);
    fs.writeFileSync(path.join(root, "app.txt"), "base\n");
    git.run(root, ["add", "--", "app.txt"]);
    git.run(root, ["commit", "-m", "user baseline"], {
      env: {
        GIT_AUTHOR_NAME: "User",
        GIT_AUTHOR_EMAIL: "user@localhost",
        GIT_COMMITTER_NAME: "User",
        GIT_COMMITTER_EMAIL: "user@localhost",
      },
    });
    const priorHead = git.run(root, ["rev-parse", "HEAD"]).stdout.trim();
    fs.writeFileSync(path.join(root, "app.txt"), "merge-owned bytes\n");
    git.run(root, ["add", "--", "app.txt"]);
    const stagedBefore = git.run(root, ["write-tree"]).stdout.trim();
    fs.writeFileSync(path.join(root, ".git", "MERGE_HEAD"), priorHead + "\n");

    expect(() => ensureGuidedGitBaseline(scope)).toThrow(
      /checkpoint_operation_active.*MERGE_HEAD/i,
    );
    expect(git.run(root, ["rev-parse", "HEAD"]).stdout.trim()).toBe(priorHead);
    expect(git.run(root, ["write-tree"]).stdout.trim()).toBe(stagedBefore);
    expect(fs.readFileSync(path.join(root, "app.txt"), "utf8")).toBe(
      "merge-owned bytes\n",
    );
  });

  it("rejects an unmerged index without advancing HEAD or rewriting conflict bytes", () => {
    const root = freshRoot("dirty-checkpoint-unmerged-index");
    const scope = scopeFor(root);
    const git = new ProcessGitRunner();
    const identity = {
      GIT_AUTHOR_NAME: "User",
      GIT_AUTHOR_EMAIL: "user@localhost",
      GIT_COMMITTER_NAME: "User",
      GIT_COMMITTER_EMAIL: "user@localhost",
    };
    git.run(root, ["init", "--quiet", "-b", "main"]);
    fs.writeFileSync(path.join(root, "app.txt"), "base\n");
    git.run(root, ["add", "--", "app.txt"]);
    git.run(root, ["commit", "-m", "base"], { env: identity });
    git.run(root, ["checkout", "-q", "-b", "feature"]);
    fs.writeFileSync(path.join(root, "app.txt"), "feature\n");
    git.run(root, ["commit", "-am", "feature"], { env: identity });
    git.run(root, ["checkout", "-q", "main"]);
    fs.writeFileSync(path.join(root, "app.txt"), "main\n");
    git.run(root, ["commit", "-am", "main"], { env: identity });
    expect(
      git.run(root, ["merge", "--no-edit", "feature"], {
        allowFailure: true,
      }).status,
    ).not.toBe(0);
    const headBefore = git.run(root, ["rev-parse", "HEAD"]).stdout.trim();
    const unmergedBefore = git.run(
      root,
      ["ls-files", "--unmerged", "-z"],
    ).stdout;
    const bytesBefore = fs.readFileSync(path.join(root, "app.txt"), "utf8");

    expect(() => ensureGuidedGitBaseline(scope)).toThrow(
      /checkpoint_operation_active.*conflitos não resolvidos/i,
    );
    expect(git.run(root, ["rev-parse", "HEAD"]).stdout.trim()).toBe(
      headBefore,
    );
    expect(
      git.run(root, ["ls-files", "--unmerged", "-z"]).stdout,
    ).toBe(unmergedBefore);
    expect(fs.readFileSync(path.join(root, "app.txt"), "utf8")).toBe(
      bytesBefore,
    );
  });
});

describe("plan-lane baseline", () => {
  it("creates a blank baseline and permits a crash-resume with only plan.md dirty", () => {
    const root = freshRoot("plan-resume");
    const scope = scopeFor(root);

    expect(ensurePlanLaneGitBaseline(scope)).toMatchObject({
      kind: "initialized-empty",
    });
    fs.writeFileSync(
      path.join(root, "plan.md"),
      "# Plano em progresso\n\nRetomar sem perder este artifact.",
    );
    expect(ensurePlanLaneGitBaseline(scope)).toMatchObject({
      kind: "existing",
    });
  });

  it("rejects nonempty non-Git folders and unrelated Git drift", () => {
    const nonRepo = freshRoot("plan-nonrepo");
    fs.writeFileSync(path.join(nonRepo, "notes.txt"), "user-owned\n");
    expect(() =>
      ensurePlanLaneGitBaseline(scopeFor(nonRepo)),
    ).toThrow(/nonempty_nonrepo/i);

    const repo = freshRoot("plan-unrelated");
    const scope = scopeFor(repo);
    ensurePlanLaneGitBaseline(scope);
    fs.writeFileSync(path.join(repo, "notes.txt"), "unrelated\n");
    expect(() => ensurePlanLaneGitBaseline(scope)).toThrow(
      /guided_plan_git_dirty/i,
    );
  });

  it("does not adopt a dirty plan path from an existing user repository", () => {
    const root = freshRoot("plan-user-repo");
    const git = new ProcessGitRunner();
    git.run(root, ["init", "--quiet"]);
    git.run(root, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    git.run(root, ["commit", "--allow-empty", "-m", "user baseline"], {
      env: {
        GIT_AUTHOR_NAME: "User",
        GIT_AUTHOR_EMAIL: "user@localhost",
        GIT_COMMITTER_NAME: "User",
        GIT_COMMITTER_EMAIL: "user@localhost",
      },
    });
    fs.writeFileSync(path.join(root, "plan.md"), "# User draft\n");

    expect(() => ensurePlanLaneGitBaseline(scopeFor(root))).toThrow(
      /preexistentes não podem ser adotadas/i,
    );
  });
});
