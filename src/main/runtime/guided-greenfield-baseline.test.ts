import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectExecutionScope } from "../../shared/types";
import {
  ensureGuidedGitBaselineBeforeContext,
  ensurePlanLaneGitBaseline,
} from "./guided-greenfield-baseline";
import {
  GUIDED_GREENFIELD_BRIEF_PATH,
  parseGuidedGreenfieldBrief,
  renderGuidedGreenfieldBrief,
} from "./guided-greenfield-brief";
import {
  ProcessGitRunner,
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
