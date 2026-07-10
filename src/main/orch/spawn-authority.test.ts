import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Squad } from "../../shared/orch-types";
import { testProjectScope } from "./__tests__/scope-fixture";
import { bindSpawnAuthority, resolveSpawnAuthority } from "./spawn-authority";

const tempDirs: string[] = [];

function tempProject(): string {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "nexus-spawn-authority-")),
  );
  tempDirs.push(root);
  return root;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const squad: Squad = {
  id: "nexus-review",
  name: "Code Review",
  createdAt: "1",
  builtin: true,
  orchestratorInstructions: "",
  agents: [
    {
      id: "orch",
      agentName: "Maestro",
      category: "orchestrator",
      cli: "claude",
      allowedTools: ["nexus_pane_spawn"],
      allowedSkills: ["review"],
    },
  ],
};

describe("spawn authority resolution", () => {
  it("keeps a trusted pending binding unchanged", () => {
    const pending = {
      missionId: "mission-a",
      agentName: "worker-a",
      role: "worker" as const,
      allowedTools: [],
      allowedSkills: ["test"],
      scope: testProjectScope(),
    };

    expect(resolveSpawnAuthority("orchspawn-1", pending, [squad])).toBe(
      pending,
    );
  });

  it("treats a spawn without orchestration metadata as a direct user spawn", () => {
    expect(resolveSpawnAuthority(undefined, null, [squad])).toBeNull();
  });

  it("reconstructs the legacy initial squad role from the trusted registry", () => {
    expect(
      resolveSpawnAuthority("squad-nexus-review-m123", null, [squad]),
    ).toEqual({
      squadId: "nexus-review",
      agentName: "Maestro",
      role: "orchestrator",
      allowedTools: ["nexus_pane_spawn"],
      allowedSkills: ["review"],
    });
  });

  it("restores a persisted pane with its original scope and attenuated worker tools", () => {
    const scope = testProjectScope({ projectId: "project-a" });
    const persisted = {
      id: "mpane-1",
      missionId: "mission-a",
      adapterId: "codex",
      title: "QA",
      agentName: "QA",
      role: "worker" as const,
      paneId: "pane-a",
      scope,
      allowedTools: ["nexus_file_read"],
      allowedSkills: ["review"],
      createdAt: 1,
    };

    expect(resolveSpawnAuthority(undefined, null, [squad], persisted)).toEqual({
      missionId: "mission-a",
      agentName: "QA",
      role: "worker",
      allowedTools: ["nexus_file_read"],
      allowedSkills: ["review"],
      scope,
    });
  });

  it("fails closed for stale or fabricated orchestration requests", () => {
    expect(() =>
      resolveSpawnAuthority("orchspawn-expired", null, [squad]),
    ).toThrow(/unknown or expired/);
    expect(() =>
      resolveSpawnAuthority("squad-unknown-x", null, [squad]),
    ).toThrow(/unknown or expired/);
  });

  it("binds a direct user spawn to the main-authorized project, never to renderer cwd identity", () => {
    const root = tempProject();
    const nested = path.join(root, "packages", "app");
    fs.mkdirSync(nested, { recursive: true });
    const trustedScope = testProjectScope({ rootRealPath: root });

    expect(
      bindSpawnAuthority({
        requestId: undefined,
        pending: null,
        squads: [squad],
        persistedPane: null,
        trustedUserScope: trustedScope,
        requestedCwd: nested,
      }),
    ).toEqual({
      source: "direct-user",
      context: null,
      scope: trustedScope,
      coordinationScope: trustedScope,
      cwd: fs.realpathSync(nested),
    });
  });

  it("rejects a renderer cwd outside the trusted project instead of minting a new scope", () => {
    const root = tempProject();
    const outside = tempProject();

    expect(() =>
      bindSpawnAuthority({
        requestId: undefined,
        pending: null,
        squads: [squad],
        persistedPane: null,
        trustedUserScope: testProjectScope({ rootRealPath: root }),
        requestedCwd: outside,
      }),
    ).toThrow(/cwd escapes workspace/);
  });

  it("uses the main-recorded pending cwd and ignores a renderer substitution", () => {
    const root = tempProject();
    const trustedCwd = path.join(root, "packages", "api");
    fs.mkdirSync(trustedCwd, { recursive: true });
    const scope = testProjectScope({ rootRealPath: root });

    expect(
      bindSpawnAuthority({
        requestId: "orchspawn-1",
        pending: {
          missionId: "mission-a",
          role: "worker",
          allowedTools: [],
          scope,
          requestedCwd: trustedCwd,
        },
        squads: [squad],
        persistedPane: null,
        trustedUserScope: null,
        requestedCwd: tempProject(),
      }).cwd,
    ).toBe(fs.realpathSync(trustedCwd));
  });

  it("binds task filesystem authority to an external worktree without changing mission coordinates", () => {
    const coordinationRoot = tempProject();
    const worktreeRoot = tempProject();
    const coordinationScope = testProjectScope({ rootRealPath: coordinationRoot });
    const executionScope = { ...coordinationScope, rootRealPath: worktreeRoot };

    const authority = bindSpawnAuthority({
      requestId: "orchspawn-worktree",
      pending: {
        missionId: "mission-a",
        role: "worker",
        allowedTools: [],
        scope: coordinationScope,
        executionScope,
        requestedCwd: worktreeRoot,
      },
      squads: [squad],
      persistedPane: null,
      trustedUserScope: null,
    });

    expect(authority.scope.rootRealPath).toBe(worktreeRoot);
    expect(authority.coordinationScope).toEqual(coordinationScope);
    expect(authority.cwd).toBe(worktreeRoot);
  });

  it("rejects a worktree carrying different project coordinates", () => {
    const coordinationRoot = tempProject();
    const worktreeRoot = tempProject();
    const coordinationScope = testProjectScope({ rootRealPath: coordinationRoot });
    expect(() => bindSpawnAuthority({
      requestId: "orchspawn-worktree",
      pending: {
        missionId: "mission-a",
        role: "worker",
        allowedTools: [],
        scope: coordinationScope,
        executionScope: {
          ...coordinationScope,
          projectId: "other-project",
          rootRealPath: worktreeRoot,
        },
        requestedCwd: worktreeRoot,
      },
      squads: [squad],
      persistedPane: null,
      trustedUserScope: null,
    })).toThrow(/execution scope differs/i);
  });

  it("rejects direct, pending and persisted spawns that have no trusted project scope", () => {
    expect(() =>
      bindSpawnAuthority({
        requestId: undefined,
        pending: null,
        squads: [squad],
        persistedPane: null,
        trustedUserScope: null,
      }),
    ).toThrow(/authorized project scope/);

    expect(() =>
      bindSpawnAuthority({
        requestId: "orchspawn-1",
        pending: {
          missionId: "mission-a",
          role: "worker",
          allowedTools: [],
        },
        squads: [squad],
        persistedPane: null,
        trustedUserScope: testProjectScope(),
      }),
    ).toThrow(/pending spawn.*scope/);

    expect(() =>
      bindSpawnAuthority({
        requestId: undefined,
        pending: null,
        squads: [squad],
        persistedPane: {
          id: "mpane-legacy",
          missionId: "mission-a",
          adapterId: "codex",
          title: "Legacy",
          role: "worker",
          paneId: "pane-legacy",
          createdAt: 1,
        },
        trustedUserScope: testProjectScope(),
      }),
    ).toThrow(/persisted pane.*scope/);
  });
});
