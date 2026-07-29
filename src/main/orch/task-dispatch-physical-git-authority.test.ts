import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertIntegratedPhysicalGitAuthority,
  assertQualityCandidatePhysicalGitAuthority,
} from "./task-dispatch-physical-git-authority";

let repositoryPath = "";

function git(args: readonly string[]): string {
  return execFileSync("git", ["-C", repositoryPath, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function commit(message: string): string {
  git(["add", "."]);
  git(["commit", "-m", message]);
  return git(["rev-parse", "--verify", "HEAD^{commit}"]);
}

beforeEach(() => {
  repositoryPath = fs.mkdtempSync(
    path.join(os.tmpdir(), "nexus-quality-git-authority-"),
  );
  git(["init"]);
  git(["config", "user.name", "Nexus Test"]);
  git(["config", "user.email", "nexus-test@localhost"]);
});

afterEach(() => {
  fs.rmSync(repositoryPath, { recursive: true, force: true });
});

describe("task dispatch physical Git quality authority", () => {
  it("binds the reviewed binary diff to the exact integrated candidate", () => {
    fs.writeFileSync(path.join(repositoryPath, "candidate.txt"), "base\n");
    const baseSha = commit("base");
    fs.writeFileSync(
      path.join(repositoryPath, "candidate.txt"),
      "base\ncandidate\n",
    );
    const candidateHeadSha = commit("candidate");
    const diff = execFileSync(
      "git",
      [
        "-C",
        repositoryPath,
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--binary",
        "--full-index",
        baseSha,
        candidateHeadSha,
      ],
      { encoding: "utf8" },
    );
    const diffHash = createHash("sha256").update(diff).digest("hex");

    expect(() =>
      assertQualityCandidatePhysicalGitAuthority({
        rootRealPath: repositoryPath,
        baseSha,
        candidateHeadSha,
        diffHash,
        integratedHeadSha: candidateHeadSha,
      }),
    ).not.toThrow();
    expect(() =>
      assertIntegratedPhysicalGitAuthority({
        rootRealPath: repositoryPath,
        workerHeadSha: candidateHeadSha,
        integratedHeadSha: candidateHeadSha,
      }),
    ).not.toThrow();
  });

  it("rejects a label-only diff hash and a different integration commit", () => {
    fs.writeFileSync(path.join(repositoryPath, "candidate.txt"), "base\n");
    const baseSha = commit("base");
    fs.writeFileSync(
      path.join(repositoryPath, "candidate.txt"),
      "base\ncandidate\n",
    );
    const candidateHeadSha = commit("candidate");

    expect(() =>
      assertQualityCandidatePhysicalGitAuthority({
        rootRealPath: repositoryPath,
        baseSha,
        candidateHeadSha,
        diffHash: "0".repeat(64),
        integratedHeadSha: candidateHeadSha,
      }),
    ).toThrow(/diff diverges/i);

    fs.writeFileSync(
      path.join(repositoryPath, "candidate.txt"),
      "base\ncandidate\nlater\n",
    );
    const laterHeadSha = commit("later");
    const diff = execFileSync(
      "git",
      [
        "-C",
        repositoryPath,
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--binary",
        "--full-index",
        baseSha,
        candidateHeadSha,
      ],
      { encoding: "utf8" },
    );

    expect(() =>
      assertQualityCandidatePhysicalGitAuthority({
        rootRealPath: repositoryPath,
        baseSha,
        candidateHeadSha,
        diffHash: createHash("sha256").update(diff).digest("hex"),
        integratedHeadSha: laterHeadSha,
      }),
    ).toThrow(/exact integrated Git receipt/i);
    expect(() =>
      assertIntegratedPhysicalGitAuthority({
        rootRealPath: repositoryPath,
        workerHeadSha: candidateHeadSha,
        integratedHeadSha: candidateHeadSha,
        checkoutMayHaveAdvanced: true,
      }),
    ).not.toThrow();
  });
});
