import { createHash } from "node:crypto";
import type {
  MissionEventType,
} from "../../shared/mission-events";
import type {
  ObserverFrame,
  ObserverFrameKind,
} from "../../shared/observer-frame";
import { getAgentSessionInfo } from "../pty/pty-manager";
import { getAcpDriverSession } from "../acp/acp-harness-driver";
import { emitMissionEvent } from "./mission-event-emit";
import { tapObserverFrames } from "./observer-bus";
import {
  normalizeSkillName,
  observerToolKind,
  type ObserverToolKind,
} from "./observer-tool-kind";
import { noteSessionToolCall } from "./session-web-exposure";

const EVENT_TYPE_BY_FRAME_KIND: Readonly<
  Record<ObserverFrameKind, MissionEventType>
> = Object.freeze({
  turn_started: "observer.turn_started",
  turn_ended: "observer.turn_ended",
  tool_call: "observer.tool_call",
  tool_result: "observer.tool_result",
  status_changed: "observer.status_changed",
  session_spawned: "observer.session_spawned",
  session_exited: "observer.session_exited",
  stall_suspected: "observer.stall_suspected",
  provider_error: "observer.provider_error",
});

let detachProjector: (() => void) | null = null;

function stableSessionKey(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
}

function stableFrameKey(frame: ObserverFrame): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        kind: frame.kind,
        payload: frame.payload,
        at: frame.at,
      }),
    )
    .digest("hex")
    .slice(0, 24);
  return `observer:${stableSessionKey(frame.sessionId)}:${frame.seq}:${digest}`;
}

/** Teto do nome copiado para o topo do payload (título de ACP é texto livre). */
const TOOL_NAME_MAX_LENGTH = 200;

/**
 * F-780: nome e categoria da tool no TOPO do payload do evento — onde a linha
 * do tempo da missão (AgentActivityTimeline) e a projeção em disco leem, e
 * onde uma consulta SQL alcança sem descer no quadro. Só o rótulo: argumento
 * e saída da tool (`input`/`content`) ficam apenas dentro de `observer`.
 */
function observerToolIdentity(frame: ObserverFrame): {
  toolName?: string | null;
  toolKind?: ObserverToolKind | null;
  skillName?: string;
} {
  if (frame.kind !== "tool_call" && frame.kind !== "tool_result") return {};
  const toolName = frame.payload.toolName;
  // Revalidado aqui: o rótulo da skill nunca sai do padrão estrito.
  const skillName =
    frame.kind === "tool_call" ? normalizeSkillName(frame.payload.skillName) : null;
  // F-808: WebFetch/WebSearch nativos (fora do MCP do Nexus) também expõem a
  // sessão — o hook é o único lugar que os vê.
  if (frame.kind === "tool_call") {
    noteSessionToolCall(frame.sessionId, toolName, frame.payload.toolKind);
  }
  return {
    toolName:
      typeof toolName === "string"
        ? toolName.slice(0, TOOL_NAME_MAX_LENGTH)
        : null,
    toolKind: observerToolKind(
      toolName,
      frame.kind === "tool_call" ? frame.payload.toolKind : undefined,
    ),
    ...(skillName ? { skillName } : {}),
  };
}

function projectObserverFrame(frame: ObserverFrame): void {
  try {
    const agent = getAgentSessionInfo(frame.sessionId);
    const acp = agent ? null : getAcpDriverSession(frame.sessionId);
    const missionId = frame.missionId ?? agent?.missionId ?? acp?.missionId;
    const scope = agent?.scope ?? acp?.scope;
    // A detached/user PTY has no mission journal scope. The observer ring
    // still retains it; only the mission projection is intentionally skipped.
    if (!missionId || !scope) return;

    const runId = `observer:${stableSessionKey(frame.sessionId)}`;
    const payload = {
      frameSeq: frame.seq,
      sessionId: frame.sessionId,
      ...(frame.paneId ? { paneId: frame.paneId } : {}),
      ...(frame.turnId ? { turnId: frame.turnId } : {}),
      ...observerToolIdentity(frame),
      observer: frame.payload,
    };
    emitMissionEvent(scope, {
      missionId,
      runId,
      type: EVENT_TYPE_BY_FRAME_KIND[frame.kind],
      payload,
      idempotencyKey: stableFrameKey(frame),
      origin: "main",
      occurredAt: frame.at,
    });
  } catch (error) {
    // Observability must never change the hook/reducer outcome. The bus has
    // already retained the frame, so a journal failure only loses the durable
    // projection and remains diagnosable in the main process log.
    console.warn("[observer-journal] frame projection failed:", error);
  }
}

/** Install the durable mission timeline projection once during main bootstrap. */
export function installObserverMissionEventProjector(): () => void {
  if (detachProjector) return detachProjector;
  const detach = tapObserverFrames(projectObserverFrame);
  const cleanup = () => {
    detach();
    if (detachProjector === cleanup) detachProjector = null;
  };
  detachProjector = cleanup;
  return cleanup;
}

/** Test/reset hook; production never needs to call this directly. */
export function uninstallObserverMissionEventProjector(): void {
  detachProjector?.();
}
