import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PromotedPlanSnapshot } from "../../shared/mission-intent";
import type { ProjectExecutionScope } from "../../shared/types";
import { ensureGuidedGitBaseline } from "../runtime/guided-greenfield-baseline";
import {
  ProcessGitRunner,
  type GitResult,
  type GitRunOptions,
  type GitRunner,
} from "../runtime/git-command";
import {
  commitPromotedPlanToGit,
  resolvePromotedPlanGitSource,
} from "./promoted-plan-git-authority";

const roots: string[] = [];

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function freshScope(): ProjectExecutionScope {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "nexus-plan-promotion-")),
  );
  roots.push(root);
  return {
    version: 1,
    installationId: "installation-plan-test",
    projectId: "project-plan-test",
    checkoutId: "checkout-plan-test",
    rootRealPath: root,
    identitySource: "manifest",
  };
}

function snapshot(summary: string): PromotedPlanSnapshot {
  const artifacts = [{ path: "plan.md", kind: "prd" }];
  return {
    version: 1,
    handoffId: "handoff-plan-physical",
    sourceIntentVersion: 1,
    sourceSessionId: "session-plan-physical",
    handoffCreatedAt: 1,
    physicalReceipt: {
      receiptId: "receipt-plan-physical",
      toolCallId: "tool-plan-physical",
      source: "http-mcp",
      authoritySha256: "a".repeat(64),
      issuedAt: 1,
    },
    summary,
    artifacts,
    summarySha256: sha256(summary),
    artifactsSha256: sha256(JSON.stringify(artifacts)),
    digest: "b".repeat(64),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("physical promoted-plan Git authority", () => {
  it("takes a blank plan workspace through write and promotion to a clean standard baseline", () => {
    const scope = freshScope();
    const initial = ensureGuidedGitBaseline(scope);
    const summary =
      "# PRD aprovado\n\nImplementar o fluxo por stories, com testes e revisão.";
    fs.writeFileSync(path.join(scope.rootRealPath, "plan.md"), summary);

    const receipt = commitPromotedPlanToGit(scope, snapshot(summary));

    expect(initial.kind).toBe("initialized-empty");
    expect(receipt).toMatchObject({
      committed: true,
      paths: ["plan.md"],
      summarySha256: sha256(summary),
      headSha: expect.stringMatching(/^[a-f0-9]{40,64}$/),
    });
    expect(receipt.headSha).not.toBe(initial.headSha);
    expect(ensureGuidedGitBaseline(scope)).toMatchObject({
      kind: "existing",
      headSha: receipt.headSha,
    });
    expect(commitPromotedPlanToGit(scope, snapshot(summary))).toMatchObject({
      committed: false,
      headSha: receipt.headSha,
      paths: ["plan.md"],
    });
    expect(resolvePromotedPlanGitSource(scope, snapshot(summary))).toEqual({
      path: "plan.md",
      content: summary,
      sourceHash: sha256(summary),
      headSha: receipt.headSha,
    });
  });

  it("rejects unrelated user files instead of adopting them", () => {
    const scope = freshScope();
    ensureGuidedGitBaseline(scope);
    const summary = "# PRD seguro\n\nSomente o plano físico pode ser promovido.";
    fs.writeFileSync(path.join(scope.rootRealPath, "plan.md"), summary);
    fs.writeFileSync(
      path.join(scope.rootRealPath, "user-notes.txt"),
      "do not adopt\n",
    );

    expect(() =>
      commitPromotedPlanToGit(scope, snapshot(summary)),
    ).toThrow(/unrelated_changes/i);
    expect(
      fs.existsSync(path.join(scope.rootRealPath, ".git", "index.lock")),
    ).toBe(false);
  });

  it("rejects a plan file that drifted from the sealed handoff", () => {
    const scope = freshScope();
    ensureGuidedGitBaseline(scope);
    const expected = "# PRD original\n\nConteúdo aprovado e selado.";
    fs.writeFileSync(
      path.join(scope.rootRealPath, "plan.md"),
      `${expected}\nmutação tardia`,
    );

    expect(() =>
      commitPromotedPlanToGit(scope, snapshot(expected)),
    ).toThrow(/file_drift/i);
  });

  it("rejects even an authorized plan path when it was staged outside Main", () => {
    const scope = freshScope();
    ensureGuidedGitBaseline(scope);
    const summary = "# PRD staged\n\nEste index não foi criado pelo Main.";
    fs.writeFileSync(path.join(scope.rootRealPath, "plan.md"), summary);
    new ProcessGitRunner().run(scope.rootRealPath, [
      "add",
      "--",
      "plan.md",
    ]);

    expect(() =>
      commitPromotedPlanToGit(scope, snapshot(summary)),
    ).toThrow(/git_staged/i);
  });

  it("proves exact HEAD bytes even when Git status is hidden by assume-unchanged", () => {
    const scope = freshScope();
    ensureGuidedGitBaseline(scope);
    const summary = "# PRD esperado\n\nBytes selados.";
    fs.writeFileSync(path.join(scope.rootRealPath, "plan.md"), summary);
    commitPromotedPlanToGit(scope, snapshot(summary));
    const git = new ProcessGitRunner();
    fs.writeFileSync(
      path.join(scope.rootRealPath, "plan.md"),
      "# PRD diferente no HEAD\n",
    );
    git.run(scope.rootRealPath, ["add", "--", "plan.md"]);
    git.run(scope.rootRealPath, ["commit", "-m", "replace plan in HEAD"], {
      env: {
        GIT_AUTHOR_NAME: "User",
        GIT_AUTHOR_EMAIL: "user@localhost",
        GIT_COMMITTER_NAME: "User",
        GIT_COMMITTER_EMAIL: "user@localhost",
      },
    });
    fs.writeFileSync(path.join(scope.rootRealPath, "plan.md"), summary);
    git.run(scope.rootRealPath, [
      "update-index",
      "--assume-unchanged",
      "plan.md",
    ]);
    expect(git.run(scope.rootRealPath, ["status", "--porcelain=v1"]).stdout)
      .toBe("");

    expect(() =>
      commitPromotedPlanToGit(scope, snapshot(summary)),
    ).toThrow(/head_drift/i);
  });

  it("recovers a crash after branch CAS without creating a second plan commit", () => {
    const scope = freshScope();
    ensureGuidedGitBaseline(scope);
    const summary = "# PRD transacional\n\nRecovery deve manter estes bytes.";
    fs.writeFileSync(path.join(scope.rootRealPath, "plan.md"), summary);
    const base = new ProcessGitRunner();
    let crashed = false;
    const crashingRunner: GitRunner = {
      run(
        cwd: string,
        args: readonly string[],
        options?: GitRunOptions,
      ): GitResult {
        if (!crashed && args[0] === "reset" && args.includes("plan.md")) {
          crashed = true;
          throw new Error("injected crash after promoted-plan branch CAS");
        }
        return base.run(cwd, args, options);
      },
    };

    expect(() =>
      commitPromotedPlanToGit(scope, snapshot(summary), {
        gitRunner: crashingRunner,
      }),
    ).toThrow(/injected crash/i);
    const committedHead = base
      .run(scope.rootRealPath, ["rev-parse", "HEAD"])
      .stdout.trim();

    expect(commitPromotedPlanToGit(scope, snapshot(summary))).toMatchObject({
      committed: false,
      headSha: committedHead,
      paths: ["plan.md"],
    });
    expect(
      base.run(scope.rootRealPath, ["rev-list", "--count", "HEAD"]).stdout.trim(),
    ).toBe("2");
    expect(
      base.run(scope.rootRealPath, [
        "for-each-ref",
        "--format=%(refname)",
        "refs/nexus/transactions/promoted-plan",
      ]).stdout,
    ).toBe("");
    expect(
      base.run(scope.rootRealPath, ["status", "--porcelain=v1"]).stdout,
    ).toBe("");
  });

  it("recovers a crash after the plan journal but before branch CAS", () => {
    const scope = freshScope();
    const baseline = ensureGuidedGitBaseline(scope);
    const summary = "# PRD journal\n\nO journal precede a troca do branch.";
    fs.writeFileSync(path.join(scope.rootRealPath, "plan.md"), summary);
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
          args[1]?.startsWith(
            "refs/nexus/transactions/promoted-plan/",
          )
        ) {
          crashed = true;
          throw new Error("injected crash after promoted-plan journal");
        }
        return result;
      },
    };

    expect(() =>
      commitPromotedPlanToGit(scope, snapshot(summary), {
        gitRunner: crashingRunner,
      }),
    ).toThrow(/injected crash/i);
    expect(
      base.run(scope.rootRealPath, ["rev-parse", "HEAD"]).stdout.trim(),
    ).toBe(baseline.headSha);

    const recovered = commitPromotedPlanToGit(scope, snapshot(summary));
    expect(recovered).toMatchObject({
      committed: false,
      paths: ["plan.md"],
    });
    expect(recovered.headSha).not.toBe(baseline.headSha);
    expect(base.run(scope.rootRealPath, ["status", "--porcelain=v1"]).stdout)
      .toBe("");
  });

  it("uses parent CAS when another commit wins and never puts that commit inside the plan commit", () => {
    const scope = freshScope();
    ensureGuidedGitBaseline(scope);
    const summary = "# PRD com corrida\n\nO parent precisa ser exato.";
    fs.writeFileSync(path.join(scope.rootRealPath, "plan.md"), summary);
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
          base.run(cwd, ["commit", "--allow-empty", "-m", "concurrent commit"], {
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
      commitPromotedPlanToGit(scope, snapshot(summary), {
        gitRunner: racingRunner,
      }),
    ).toThrow();
    const racedHead = base
      .run(scope.rootRealPath, ["rev-parse", "HEAD"])
      .stdout.trim();
    expect(
      base.run(
        scope.rootRealPath,
        ["cat-file", "-e", `${racedHead}:plan.md`],
        { allowFailure: true },
      ).status,
    ).not.toBe(0);
    expect(() =>
      commitPromotedPlanToGit(scope, snapshot(summary)),
    ).toThrow(/parent_raced/i);
    const completed = commitPromotedPlanToGit(scope, snapshot(summary));
    expect(completed.committed).toBe(true);
    expect(
      base.run(scope.rootRealPath, ["rev-parse", `${completed.headSha}^`])
        .stdout.trim(),
    ).toBe(racedHead);
  });

  it("never includes a concurrently staged unrelated file in the private plan tree", () => {
    const scope = freshScope();
    ensureGuidedGitBaseline(scope);
    const summary = "# PRD index privado\n\nSomente plan.md pode entrar.";
    fs.writeFileSync(path.join(scope.rootRealPath, "plan.md"), summary);
    const base = new ProcessGitRunner();
    let injected = false;
    const racingRunner: GitRunner = {
      run(
        cwd: string,
        args: readonly string[],
        options?: GitRunOptions,
      ): GitResult {
        const result = base.run(cwd, args, options);
        if (
          !injected &&
          args[0] === "status" &&
          args.includes("--untracked-files=all")
        ) {
          injected = true;
          fs.writeFileSync(path.join(cwd, "secret.txt"), "must stay out\n");
          base.run(cwd, ["add", "--", "secret.txt"]);
        }
        return result;
      },
    };

    expect(() =>
      commitPromotedPlanToGit(scope, snapshot(summary), {
        gitRunner: racingRunner,
      }),
    ).toThrow(/raced/i);
    expect(
      base.run(
        scope.rootRealPath,
        ["cat-file", "-e", "HEAD:secret.txt"],
        { allowFailure: true },
      ).status,
    ).not.toBe(0);
    expect(base.run(scope.rootRealPath, ["show", "HEAD:plan.md"]).stdout).toBe(
      summary,
    );
  });
});
