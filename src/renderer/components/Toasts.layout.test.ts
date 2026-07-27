import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { UI_Z } from "../lib/ui-overlay-policy";

const panelsCss = fs.readFileSync(
  new URL("../styles/panels.css", import.meta.url),
  "utf8",
);
const baseCss = fs.readFileSync(
  new URL("../styles/base.css", import.meta.url),
  "utf8",
);

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return panelsCss.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
}

describe("Toasts layout policy", () => {
  it("anchors notifications at bottom-right below modal dimmers", () => {
    const stack = rule(".toasts");
    expect(stack).toContain("bottom:");
    expect(stack).toContain("right:");
    expect(stack).not.toContain("top:");
    expect(stack).toContain("z-index: var(--z-toast)");
    expect(baseCss).toContain(`--z-toast: ${UI_Z.toast}`);
    expect(UI_Z.toast).toBeLessThan(UI_Z.softOverlay);
  });

  it("keeps the stack inert while giving controls accessible hit targets", () => {
    expect(rule(".toasts")).toContain("pointer-events: none");
    expect(rule(".toast")).toContain("pointer-events: auto");
    expect(rule(".toast__action")).toContain("min-height: 44px");
    expect(rule(".toast__close")).toContain("width: 44px");
    expect(rule(".toast__close")).toContain("height: 44px");
  });
});
