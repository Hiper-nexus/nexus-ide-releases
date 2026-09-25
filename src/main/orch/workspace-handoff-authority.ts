import {
  getContextBySession,
  isCurrentGateContext,
  type AgentGateContext,
} from "./gate";
import { getAgentSessionInfo } from "../pty/pty-manager";
import { getPaneRuntimeAuthorityBySession } from "./pane-registry";
import { sameProjectExecutionScope } from "./project-domain-store-registry";
import type { ProjectExecutionScope } from "../../shared/types";

interface HandPane {
  readonly paneId: string;
  readonly kind?: string;
  readonly role?: string;
  readonly missionId?: string;
  readonly contextRevision?: string;
  readonly workerIncarnationId?: string;
  readonly scope?: Readonly<ProjectExecutionScope>;
  readonly operatorParentSessionId?: string;
}

/**
 * O registro de panes espelha só o workspace que a janela mostra agora. Com a
 * janela noutro workspace, as sessões PTY deste continuam vivas no main, e é a
 * ficha main-owned delas que responde.
 */
function handPaneOf(sessionId: string): HandPane | null {
  const registered = getPaneRuntimeAuthorityBySession(sessionId);
  if (registered) return registered;
  const agent = getAgentSessionInfo(sessionId);
  return agent
    ? {
        paneId: agent.paneId ?? sessionId,
        kind: "cli-agent",
        role: agent.role,
        missionId: agent.missionId,
        contextRevision: agent.authoritySeal?.contextRevision,
        workerIncarnationId: agent.workerIncarnationId,
        scope: agent.scope,
      }
    : null;
}

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
  const child = handPaneOf(ctx.sessionId);
  // O vínculo com o pai é autoridade do Main: a meta do spawn no registro ou o
  // token cunhado no spawn. Divergência entre os dois falha fechado.
  const parentSessionId =
    child?.operatorParentSessionId ?? ctx.operatorParentSessionId;
  if (
    !child ||
    !parentSessionId ||
    (ctx.operatorParentSessionId !== undefined &&
      child.operatorParentSessionId !== undefined &&
      child.operatorParentSessionId !== ctx.operatorParentSessionId) ||
    parentSessionId === ctx.sessionId ||
    child.kind !== "cli-agent" ||
    child.role === "worker" ||
    child.missionId ||
    child.contextRevision ||
    child.workerIncarnationId ||
    !child.scope ||
    !sameProjectExecutionScope(child.scope, ctx.scope)
  )
    return null;
  const parent = handPaneOf(parentSessionId);
  const parentContext = getContextBySession(parentSessionId);
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
