import type { WebContents } from "electron";
import type { ProjectExecutionScope } from "../../shared/types";
import { getRendererWorkspaceScope } from "../persistence/renderer-workspace-scope";

export function sameProjectScope(
  left: ProjectExecutionScope,
  right: ProjectExecutionScope,
): boolean {
  return (
    left.installationId === right.installationId &&
    left.projectId === right.projectId &&
    left.checkoutId === right.checkoutId &&
    left.rootRealPath === right.rootRealPath
  );
}

export function broadcastToProject(
  renderers: Iterable<WebContents>,
  scope: ProjectExecutionScope,
  channel: string,
  payload: unknown,
): void {
  for (const wc of renderers) {
    const rendererScope = getRendererWorkspaceScope(wc);
    if (
      rendererScope &&
      sameProjectScope(rendererScope, scope) &&
      !wc.isDestroyed() &&
      !wc.isCrashed()
    ) {
      wc.send(channel, payload);
    }
  }
}
