import { useRef, useState, type DragEvent, type ReactNode } from "react";
import type { PaneModel } from "../../shared/types";
import {
  PANE_SKILL_DRAG_TYPE,
  buildSkillInvocationPrompt,
  hasSkillDragType,
  parseSkillDragPayload,
  resolveSkillDropPolicy,
} from "../lib/pane-interactions";
import { useLayoutStore } from "../state/layout-store";
import { useOrchStore } from "../state/orch-store";
import { useToastStore } from "../state/toast-store";
import { submitLivePanePrompt } from "../terminal/submit-live-pane-prompt";
import { getPaneSessionId } from "../terminal/terminal-host";
import { PaneContextMenu } from "./PaneContextMenu";

export interface PaneInteractionSurfaceProps {
  readonly pane: PaneModel;
  readonly className: string;
  readonly children: ReactNode;
}

/**
 * User interaction shell around a terminal pane. Skill drops are accepted only
 * from the Nexus MIME payload and only after a fail-closed roster preflight.
 */
export function PaneInteractionSurface({
  pane,
  className,
  children,
}: PaneInteractionSurfaceProps) {
  const [menuPoint, setMenuPoint] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [skillDragActive, setSkillDragActive] = useState(false);
  const dragDepth = useRef(0);
  const focusPane = useLayoutStore((state) => state.focus);
  const missions = useOrchStore((state) => state.missions);
  const squads = useOrchStore((state) => state.squads);
  const pushToast = useToastStore((state) => state.push);

  function isSkillDrag(event: DragEvent<HTMLDivElement>): boolean {
    return hasSkillDragType(event.dataTransfer.types);
  }

  function finishSkillDrag() {
    dragDepth.current = 0;
    setSkillDragActive(false);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    if (!isSkillDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    finishSkillDrag();

    const payload = parseSkillDragPayload(
      event.dataTransfer.getData(PANE_SKILL_DRAG_TYPE),
    );
    if (!payload) {
      pushToast("warn", "Skill rejeitada", "O payload arrastado é inválido.");
      return;
    }
    const policy = resolveSkillDropPolicy({
      pane,
      skillName: payload.name,
      missions,
      squads,
    });
    if (!policy.allowed) {
      pushToast("warn", "Skill não enviada", policy.reason);
      return;
    }
    if (!getPaneSessionId(pane.id)) {
      pushToast(
        "warn",
        "Skill não enviada",
        "A sessão do agente não está ativa.",
      );
      return;
    }
    void submitLivePanePrompt(pane, buildSkillInvocationPrompt(payload.name))
      .then((sent) => {
        if (!sent) {
          pushToast(
            "warn",
            "Skill não enviada",
            "A sessão do agente deixou de responder.",
          );
          return;
        }
        pushToast(
          "success",
          "Skill enviada",
          `${payload.name}: o Nexus mantém as permissões do agente.`,
        );
      })
      .catch(() => {
        pushToast(
          "warn",
          "Skill não enviada",
          "A sessão do agente deixou de responder.",
        );
      });
  }

  return (
    <div
      className={`${className}${skillDragActive ? " pane--skill-target" : ""}`}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        focusPane(pane.id);
        setMenuPoint({ x: event.clientX, y: event.clientY });
      }}
      onDragEnter={(event) => {
        if (!isSkillDrag(event)) return;
        event.preventDefault();
        dragDepth.current += 1;
        setSkillDragActive(true);
      }}
      onDragOver={(event) => {
        if (!isSkillDrag(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect =
          pane.kind === "cli-agent" ? "copy" : "none";
      }}
      onDragLeave={(event) => {
        if (!isSkillDrag(event)) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setSkillDragActive(false);
      }}
      onDrop={onDrop}
    >
      {children}
      {skillDragActive && (
        <div className="pane-skill-drop" role="status" aria-live="polite">
          {pane.kind === "cli-agent"
            ? `Solte a skill em ${pane.agentName ?? pane.title}`
            : "Skills exigem um pane de agente"}
        </div>
      )}
      {menuPoint && (
        <PaneContextMenu
          pane={pane}
          point={menuPoint}
          onClose={() => setMenuPoint(null)}
        />
      )}
    </div>
  );
}
