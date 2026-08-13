import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { PaneModel } from "../../shared/types";
import {
  buildHandoffRequestPrompt,
  buildWorktreePlanningPrompt,
} from "../lib/pane-interactions";
import { useContextualPanelNavStore } from "../state/contextual-panel-nav-store";
import { useOrchStore } from "../state/orch-store";
import { useToastStore } from "../state/toast-store";
import { useProductNavigationStore } from "../state/product-navigation-store";
import { submitLivePanePrompt } from "../terminal/submit-live-pane-prompt";
import {
  getPaneSessionId,
  getScrollbackExcerpt,
} from "../terminal/terminal-host";
import { PixelIcon, type PixelIconName } from "./PixelIcon";

export interface PaneContextMenuProps {
  readonly pane: PaneModel;
  readonly point: { readonly x: number; readonly y: number };
  readonly onClose: () => void;
}

interface MenuAction {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly icon: PixelIconName;
  readonly run: () => void | Promise<void>;
}

function viewportPoint(point: PaneContextMenuProps["point"]): {
  left: number;
  top: number;
} {
  const width = 276;
  const height = 250;
  const maxLeft = Math.max(8, window.innerWidth - width - 8);
  const maxTop = Math.max(8, window.innerHeight - height - 8);
  return {
    left: Math.max(8, Math.min(point.x, maxLeft)),
    top: Math.max(8, Math.min(point.y, maxTop)),
  };
}

/**
 * Context actions remain user-initiated and renderer-only. Handoff asks the
 * worker to use the durable MCP tool; worktree emits an instruction for the
 * mission dispatcher instead of running Git or mutating a checkout.
 */
export function PaneContextMenu({
  pane,
  point,
  onClose,
}: PaneContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const pushToast = useToastStore((state) => state.push);
  const mission = useOrchStore((state) =>
    pane.missionId
      ? state.missions.find((item) => item.id === pane.missionId)
      : undefined,
  );
  const openContextualTab = useContextualPanelNavStore(
    (state) => state.openTab,
  );

  useEffect(() => {
    menuRef.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]')
      ?.focus();
    const onPointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (
        event.key !== "ArrowDown" &&
        event.key !== "ArrowUp" &&
        event.key !== "Home" &&
        event.key !== "End"
      ) {
        return;
      }
      const items = [
        ...(menuRef.current?.querySelectorAll<HTMLButtonElement>(
          '[role="menuitem"]',
        ) ?? []),
      ];
      if (items.length === 0) return;
      event.preventDefault();
      const current = items.indexOf(
        document.activeElement as HTMLButtonElement,
      );
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : event.key === "ArrowUp"
              ? (current - 1 + items.length) % items.length
              : (current + 1) % items.length;
      items[next]?.focus();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  const actions: MenuAction[] = [];

  if (
    pane.kind === "cli-agent" &&
    pane.role === "worker" &&
    pane.missionId &&
    mission?.status === "running" &&
    getPaneSessionId(pane.id)
  ) {
    actions.push({
      id: "handoff",
      label: "Solicitar handoff",
      detail: "Pede ao worker uma entrega durável para o orquestrador.",
      icon: "mission",
      run: async () => {
        try {
          const sent = await submitLivePanePrompt(
            pane,
            buildHandoffRequestPrompt(pane),
          );
          if (!sent) {
            pushToast(
              "warn",
              "Handoff não solicitado",
              "O worker não aceitou a solicitação.",
            );
            return;
          }
          pushToast(
            "success",
            "Handoff solicitado",
            "O gate da missão validará a entrega do worker.",
          );
        } catch {
          pushToast(
            "warn",
            "Handoff não solicitado",
            "O worker não aceitou a solicitação.",
          );
        }
      },
    });
  }

  if (pane.missionId) {
    const missionId = pane.missionId;
    actions.push({
      id: "worktree",
      label: "Planejar worktree",
      detail: "Copia a instrução e abre a missão. Cole no orquestrador.",
      icon: "orch",
      run: async () => {
        const instruction = buildWorktreePlanningPrompt(pane);
        try {
          await navigator.clipboard.writeText(instruction);
          pushToast(
            "success",
            "Instrução copiada",
            "Cole no orquestrador. O motor Nexus mantém a autoridade.",
          );
        } catch {
          pushToast(
            "warn",
            "Clipboard indisponível",
            "A missão foi aberta, mas a instrução não pôde ser copiada.",
          );
        }
        useProductNavigationStore.getState().openMission(missionId);
      },
    });
  }

  actions.push({
    id: "git",
    label: "Abrir painel Git",
    detail: "Mostra alterações e histórico do workspace.",
    icon: "files",
    run: () => openContextualTab("git", { focus: true }),
  });

  actions.push({
    id: "copy-output",
    label: "Copiar saída",
    detail: "Copia até 12 mil caracteres recentes deste terminal.",
    icon: "terminal",
    run: async () => {
      const excerpt = getScrollbackExcerpt(pane.id, 12_000);
      if (!excerpt.trim()) {
        pushToast(
          "warn",
          "Sem saída",
          "Este pane ainda não tem texto copiável.",
        );
        return;
      }
      try {
        await navigator.clipboard.writeText(excerpt);
        pushToast("success", "Saída copiada", "Trecho recente no clipboard.");
      } catch {
        pushToast(
          "warn",
          "Clipboard indisponível",
          "Não foi possível copiar a saída.",
        );
      }
    },
  });

  const position = viewportPoint(point);
  return createPortal(
    <div
      ref={menuRef}
      className="pane-context-menu"
      role="menu"
      aria-label={`Ações do pane ${pane.title}`}
      style={position}
      tabIndex={-1}
      onContextMenu={(event) => event.preventDefault()}
    >
      <p className="pane-context-menu__head">{pane.title}</p>
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          role="menuitem"
          className="pane-context-menu__item"
          title={action.detail}
          onClick={() => {
            onClose();
            void action.run();
          }}
        >
          <PixelIcon name={action.icon} size={12} />
          <span>
            <strong>{action.label}</strong>
            <small>{action.detail}</small>
          </span>
        </button>
      ))}
    </div>,
    document.body,
  );
}
