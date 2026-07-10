import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectRuntimeManager } from "../runtime/project-runtime-manager";
import { testProjectScope } from "./__tests__/scope-fixture";
import { ProjectDomainStoreRegistry } from "./project-domain-store-registry";

const roots: string[] = [];
const managers: ProjectRuntimeManager[] = [];

function runtimeManager(): ProjectRuntimeManager {
  const baseDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "nexus-domain-registry-"),
  );
  roots.push(baseDir);
  const manager = new ProjectRuntimeManager({
    baseDir,
    appVersion: "0.12.0-test",
  });
  managers.push(manager);
  return manager;
}

afterEach(() => {
  for (const manager of managers.splice(0)) manager.closeAll();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("ProjectDomainStoreRegistry", () => {
  it("isolates A/B data and emits only the changed scope", () => {
    const registry = new ProjectDomainStoreRegistry(runtimeManager());
    const scopeA = testProjectScope({
      projectId: "project-a",
      checkoutId: "checkout-a",
      rootRealPath: "/workspace/a",
    });
    const scopeB = testProjectScope({
      projectId: "project-b",
      checkoutId: "checkout-b",
      rootRealPath: "/workspace/b",
    });
    const changes = vi.fn();
    registry.onChange(changes);
    const suiteA = registry.forScope(scopeA);
    const suiteB = registry.forScope(scopeB);

    suiteA.missions.create({ title: "Mission A" });

    expect(suiteA.missions.list().map((mission) => mission.title)).toEqual([
      "Mission A",
    ]);
    expect(suiteB.missions.list()).toEqual([]);
    expect(changes).toHaveBeenCalledTimes(1);
    expect(changes).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project-a" }),
      "missions",
    );
    expect(registry.forScope(scopeA)).toBe(suiteA);
    registry.dispose();
  });

  it("announces a suite before first mutation and replays existing suites", () => {
    const registry = new ProjectDomainStoreRegistry(runtimeManager());
    const scopeA = testProjectScope({ checkoutId: "checkout-a" });
    const first = vi.fn();
    registry.onScope(first);

    const suiteA = registry.forScope(scopeA);

    expect(first).toHaveBeenCalledWith(scopeA, suiteA);
    expect(first).toHaveBeenCalledTimes(1);
    const late = vi.fn();
    registry.onScope(late);
    expect(late).toHaveBeenCalledWith(scopeA, suiteA);
    registry.dispose();
  });
});
