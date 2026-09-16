import {
  getContextBySession,
  isCurrentGateContext,
  type AgentGateContext,
} from "./gate";
import { getPaneRuntimeAuthorityBySession } from "./pane-registry";
import { sameProjectExecutionScope } from "./project-domain-store-registry";

/** Resolve only Main-owned spawn metadata against both current physical panes. */
export function resolveWorkspaceHandoffParent(ctx: AgentGateContext) {
  if (
    !isCurrentGateContext(ctx) ||
    !ctx.sessionId ||
    ctx.missionId ||
    ctx.contextRevision ||
    ctx.workerIncarnationId ||
    ctx.role === "worker"
  )
    return null;
  const child = getPaneRuntimeAuthorityBySession(ctx.sessionId);
  if (
    !child?.operatorParentSessionId ||
    child.operatorParentSessionId === ctx.sessionId ||
    child.kind !== "cli-agent" ||
    child.role === "worker" ||
    child.missionId ||
    child.contextRevision ||
    child.workerIncarnationId ||
    !child.scope ||
    !sameProjectExecutionScope(child.scope, ctx.scope)
  )
    return null;
  const parent = getPaneRuntimeAuthorityBySession(
    child.operatorParentSessionId,
  );
  const parentContext = getContextBySession(child.operatorParentSessionId);
  if (
    !parent ||
    !parentContext ||
    !isCurrentGateContext(parentContext) ||
    parentContext.role === "worker" ||
    parentContext.missionId ||
    parentContext.contextRevision ||
    parentContext.workerIncarnationId ||
    parent.kind !== "cli-agent" ||
    parent.role === "worker" ||
    parent.missionId ||
    parent.contextRevision ||
    parent.workerIncarnationId ||
    !parent.scope ||
    !sameProjectExecutionScope(parent.scope, ctx.scope) ||
    !sameProjectExecutionScope(parentContext.scope, ctx.scope)
  )
    return null;
  return { child, parent, parentContext };
}
