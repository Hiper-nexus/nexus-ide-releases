import fs from "node:fs";
import { describe, expect, it } from "vitest";

const wizardCss = fs.readFileSync(
  new URL("../styles/launch-wizard.css", import.meta.url),
  "utf8",
);
const panelsCss = fs.readFileSync(
  new URL("../styles/panels.css", import.meta.url),
  "utf8",
);
const wizardSource = fs.readFileSync(
  new URL("./MissionWizard.tsx", import.meta.url),
  "utf8",
);

function cssRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
}

function rule(selector: string): string {
  return cssRule(wizardCss, selector);
}

describe("MissionWizard action layout invariants", () => {
  it("contains the panel inside the dynamic viewport", () => {
    const panel = rule(".wizard__panel");
    expect(panel).toContain("100dvh");
    expect(panel).toContain("min-height: 0");
    expect(panel).toContain("overflow: hidden");
  });

  it("gives the content the only scroll authority", () => {
    const body = rule(".wizard__body");
    expect(body).toContain("flex: 1 1 auto");
    expect(body).toContain("min-height: 0");
    expect(body).toContain("overflow-y: auto");
    expect(body).toContain("overscroll-behavior: contain");
  });

  it("keeps actions in a separate footer with a compact sticky fallback", () => {
    const actions = rule(".wizard__actions");
    expect(actions).toContain("position: absolute");
    expect(actions).toContain("bottom: 0");
    expect(actions).toContain("border-top:");
    expect(wizardCss).toMatch(
      /@media \(max-width: 720px\), \(max-height: 560px\)[\s\S]*?\.wizard__actions\s*\{[\s\S]*?position: sticky/,
    );
  });

  it("organizes plan review cards in two columns with a compact fallback", () => {
    expect(rule(".wizard__plan-grid")).toContain(
      "grid-template-columns: repeat(2, minmax(0, 1fr))",
    );
    expect(wizardCss).toMatch(
      /@media \(max-width: 720px\)\s*\{[\s\S]*?\.wizard__plan-grid\s*\{[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/,
    );
  });

  it("keeps the approval CTA touch-safe and uses only declared accent tokens", () => {
    expect(rule(".wizard__btn--primary")).toContain("min-height: 44px");
    expect(wizardSource).not.toContain("--accent-cyan");
  });

  it("presents the approval note as a contained band instead of an accent stripe", () => {
    const approvalNote = rule(".wizard__approval-note");
    expect(approvalNote).toContain("border-block:");
    expect(approvalNote).toContain("var(--bg-elevated)");
    expect(approvalNote).not.toContain("border-left");
  });

  it("keeps keyboard focus visible on the mission inputs", () => {
    const inputFocus = cssRule(panelsCss, ".wizard__input:focus-visible");
    expect(inputFocus).toContain("outline: 2px solid var(--accent)");
    expect(inputFocus).toContain("outline-offset: -2px");
    expect(panelsCss).not.toMatch(
      /\.wizard__input:focus\s*\{[^}]*outline:\s*none/,
    );
  });
});
