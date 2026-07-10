import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebContents } from "electron";
import {
  bindResolvedRendererWorkspaceScope,
  clearRendererWorkspaceScope,
} from "../persistence/renderer-workspace-scope";
import { testProjectScope } from "./__tests__/scope-fixture";
import { broadcastToProject } from "./project-scoped-broadcast";

function renderer(
  id: number,
): WebContents & { send: ReturnType<typeof vi.fn> } {
  return {
    id,
    isDestroyed: () => false,
    isCrashed: () => false,
    send: vi.fn(),
  } as unknown as WebContents & { send: ReturnType<typeof vi.fn> };
}

const rendererA = renderer(101);
const rendererB = renderer(202);

afterEach(() => {
  clearRendererWorkspaceScope(rendererA);
  clearRendererWorkspaceScope(rendererB);
  vi.clearAllMocks();
});

describe("broadcastToProject", () => {
  it("sends A changes only to A renderers, never B", () => {
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
    bindResolvedRendererWorkspaceScope(rendererA, scopeA);
    bindResolvedRendererWorkspaceScope(rendererB, scopeB);

    broadcastToProject(
      [rendererA, rendererB],
      scopeA,
      "orch:missions.changed",
      [{ id: "mission-a" }],
    );

    expect(rendererA.send).toHaveBeenCalledOnce();
    expect(rendererB.send).not.toHaveBeenCalled();
  });
});
