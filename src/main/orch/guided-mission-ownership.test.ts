import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { GitRunner } from "../runtime/git-command";
import { testProjectScope } from "./__tests__/scope-fixture";
import {
  approvedIntentOwnershipClaims,
  listRepositoryOwnershipClaims,
  ownershipLooksRepoWide,
  MAX_FREE_FORM_GREENFIELD_OVERLAP,
  MAX_FREE_FORM_OWNERSHIP_FILES,
  MAX_FREE_FORM_TOP_LEVEL_ROOTS,
} from "./guided-mission-ownership";

describe("guided mission ownership inventory authority", () => {
  it("derives only exact safe artifact paths from the approved intent", () => {
    expect(
      approvedIntentOwnershipClaims({
        goal:
          "Crie `reports/final.json`; consulte https://example.com/status.json.",
        acceptanceCriteria: [
          'Crie output.json com conteúdo exato "segredo.txt".',
          "Sem alterar segredo.txt ou PRODUCT.md.",
          'Crie "../../outside.txt" e "/absolute.txt".',
          'Não crie ".github/workflows/release.yml".',
        ],
      }),
    ).toEqual(["output.json", "reports/final.json"]);
  });

  it("does not mistake literal content for ownership and scopes negation to its clause", () => {
    expect(
      approvedIntentOwnershipClaims({
        goal:
          "Crie resultado.txt com conteúdo exato `unrelated.txt`. Não esqueça de criar resumo.md.",
        acceptanceCriteria: [
          "Não altere README.md, mas crie reports/final.json.",
          "Sem alterar segredo.txt, salve status.json.",
          "Não crie forbidden.txt, rejected.txt.",
        ],
      }),
    ).toEqual([
      "reports/final.json",
      "resultado.txt",
      "resumo.md",
      "status.json",
    ]);
  });

  it("fails closed when ls-tree fails for a committed clean repository", () => {
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "nexus-guided-committed-inventory-failure-"),
    );
    try {
      const rootRealPath = fs.realpathSync(temporaryRoot);
      fs.writeFileSync(path.join(rootRealPath, "placeholder.txt"), "tracked\n");
      const run = vi.fn(
        (_cwd: string, args: readonly string[]) => {
          if (
            args[0] === "rev-parse" &&
            args[1] === "--is-inside-work-tree"
          ) {
            return { status: 0, stdout: "true\n", stderr: "" };
          }
          if (args[0] === "ls-tree") {
            throw new Error("simulated ls-tree failure");
          }
          if (
            args[0] === "rev-parse" &&
            args.includes("HEAD^{commit}")
          ) {
            return {
              status: 0,
              stdout: "0123456789abcdef0123456789abcdef01234567\n",
              stderr: "",
            };
          }
          if (args[0] === "status") {
            return { status: 0, stdout: "", stderr: "" };
          }
          throw new Error(`unexpected Git command: ${args.join(" ")}`);
        },
      );
      const git: GitRunner = { run };

      expect(() =>
        listRepositoryOwnershipClaims(
          testProjectScope({ rootRealPath }),
          git,
        ),
      ).toThrow(/guided_plan_inventory_unavailable/i);
      expect(
        run.mock.calls.some(([, args]) => args[0] === "status"),
      ).toBe(false);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});

describe("ownershipLooksRepoWide", () => {
  it("counts nested claims under catalog directory roots", () => {
    const catalogDirs = [
      "src",
      "docs",
      "apps",
      "packages",
      "server",
      "mobile",
      "api",
      "lib",
      "bin",
      "cmd",
      "internal",
      "infra",
      "k8s",
      "docker",
      "config",
      "database",
      "backend",
      "android",
      "ios",
      "assets",
      "examples",
      "benches",
      "crates",
      "gradle",
    ];
    expect(catalogDirs).toHaveLength(MAX_FREE_FORM_GREENFIELD_OVERLAP);
    expect(
      ownershipLooksRepoWide(
        catalogDirs.map((root, index) => `${root}/nested/file-${index}.ts`),
      ),
    ).toBe(true);
    expect(ownershipLooksRepoWide(["src/a.ts", "src/b.ts", "docs/c.md"])).toBe(
      false,
    );
  });

  it("flags excessive file volume and top-level root fan-out", () => {
    expect(
      ownershipLooksRepoWide(
        Array.from(
          { length: MAX_FREE_FORM_OWNERSHIP_FILES },
          (_, index) => `artifact-${index}.txt`,
        ),
      ),
    ).toBe(true);
    expect(
      ownershipLooksRepoWide(
        Array.from(
          { length: MAX_FREE_FORM_TOP_LEVEL_ROOTS },
          (_, index) => `root-${index}/a.txt`,
        ),
      ),
    ).toBe(true);
  });
});
