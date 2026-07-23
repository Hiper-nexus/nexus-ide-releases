/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PANE_SKILL_DRAG_TYPE } from "../../lib/pane-interactions";
import { SkillsPanelBody } from "./ProductPanelBodies";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function mount(): { host: HTMLDivElement; root: Root } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<SkillsPanelBody />));
  return { host, root };
}

describe("SkillsPanelBody drag contract", () => {
  beforeEach(() => {
    Object.defineProperty(window, "nexus", {
      configurable: true,
      value: {
        product: {
          skillsList: vi.fn(async () => [
            {
              id: "skill-code-review",
              name: "code-review",
              description: "Revê mudanças com evidência.",
              category: "workflow",
            },
          ]),
        },
      },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "nexus");
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("exposes a Nexus-only draggable chip with an accessible copy fallback", async () => {
    const { host, root } = mount();
    await act(async () => Promise.resolve());

    const chip = host.querySelector<HTMLElement>(
      '[data-testid="skill-drag-chip"]',
    );
    expect(chip?.getAttribute("draggable")).toBe("true");
    expect(chip?.getAttribute("aria-label")).toContain(
      "Arrastar skill code-review",
    );

    const setData = vi.fn();
    const event = new Event("dragstart", { bubbles: true });
    Object.defineProperty(event, "dataTransfer", {
      value: { setData, effectAllowed: "none" },
    });
    act(() => chip?.dispatchEvent(event));

    expect(setData).toHaveBeenCalledTimes(1);
    expect(setData).toHaveBeenCalledWith(
      PANE_SKILL_DRAG_TYPE,
      expect.stringContaining('"name":"code-review"'),
    );
    expect(host.textContent).toContain("Arraste para um agente");
    act(() => root.unmount());
  });
});
