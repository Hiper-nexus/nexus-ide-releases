import fs from "node:fs";
import { describe, expect, it } from "vitest";

const missionCss = fs.readFileSync(
  new URL("../../styles/mission-board.css", import.meta.url),
  "utf8",
);

function cssRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
}

describe("MissionBoard layout system invariants (RED test)", () => {
  it("establishes named inline-size containment on the board", () => {
    const boardRule = cssRule(missionCss, ".mission-board");
    expect(boardRule).toMatch(/container-type:\s*inline-size/);
    expect(boardRule).toMatch(/container-name:\s*\w+/);
  });

  it("uses @container queries rather than viewport @media for responsive graph/inspector + compact header", () => {
    // Media queries for viewport max-width (e.g. 1099px or 760px) should be absent for responsive layout
    expect(missionCss).not.toMatch(/@media\s*\(max-width:\s*(1099px|760px)\)/);

    // Layout switches must happen within @container blocks
    expect(missionCss).toContain("@container");
    expect(missionCss).toMatch(/@container\s+[^{]+\.mission-board__workspace-layout/);
    expect(missionCss).toMatch(/@container\s+[^{]+\.mission-inspector/);
    expect(missionCss).toMatch(/@container\s+[^{]+\.mission-board__header/);
  });

  it("ensures native resize is absent from workspace elements", () => {
    // Native resize horizontal/vertical/both should not be present on inspector or layout containers
    const inspectorRule = cssRule(missionCss, ".mission-inspector");
    expect(inspectorRule).not.toContain("resize:");
    expect(missionCss).not.toMatch(/\.mission-board__workspace-layout\s*\{[^}]*resize:/);
  });

  it("uses the exact stacked inspector extent and lets the graph absorb the remainder", () => {
    expect(missionCss).toMatch(
      /@container mission-board \(max-width: 1099px\)[\s\S]*?\.mission-board__graph-region\s*\{[^}]*min-height:\s*0;/,
    );
    expect(missionCss).toMatch(
      /@container mission-board \(max-width: 1099px\)[\s\S]*?\.mission-board__inspector-region\s*\{[^}]*flex:\s*0 0 var\(--mission-inspector-size, 40%\);[^}]*min-height:\s*30%;[^}]*max-height:\s*60%/,
    );
  });

  it("defines an explicit splitter with an 8px-equivalent pointer target and focus styling", () => {
    // Splitter element selector must exist
    expect(missionCss).toMatch(/\.mission-board__splitter/);
    const splitterRule = cssRule(missionCss, ".mission-board__splitter");
    
    // Explicit pointer target width/hit area (e.g. 8px width or using invisible expanded pseudo-element)
    expect(splitterRule).toMatch(/(width|flex-basis):\s*8px|inset:\s*[^;]*(-3px|-4px|8px)/);

    // Must have focus/keyboard focus styling
    expect(missionCss).toMatch(/\.mission-board__splitter:(focus-visible|focus)/);
  });

  it("ensures edge stroke uses a token/high-contrast color at >=1.5px and distinct dash patterns", () => {
    const edgeLineRule = cssRule(missionCss, ".mission-graph__edges line");
    expect(edgeLineRule).toMatch(/stroke:\s*var\(--/);
    expect(edgeLineRule).toMatch(/stroke-width:\s*(1\.5(px)?|[2-9](px)?)/);

    // Canonical edge kinds (e.g., dependency kinds) should have distinct dash patterns
    expect(missionCss).toMatch(/\.mission-graph__edge--[^:]+\s*\{[^}]*stroke-dasharray:/);
  });

  it("wraps compact actions and ensures reason text is not ellipsized in compact rules", () => {
    // Compact action rules within container queries should have flex-wrap: wrap
    expect(missionCss).toMatch(/@container[^{]*\{[\s\S]*?\.mission-board__actions\s*\{[^}]*flex-wrap:\s*wrap/);

    // Full reason text is not ellipsized in compact container query overrides
    // Check for absence of white-space: nowrap or text-overflow: ellipsis in reason rules inside container query
    const reasonRuleRegex = /@container[^{]*\{[\s\S]*?\.mission-board__reason[^}]*\}[\s\S]*?\}/;
    const match = missionCss.match(reasonRuleRegex);
    if (match) {
      expect(match[0]).not.toContain("text-overflow: ellipsis");
      expect(match[0]).not.toContain("white-space: nowrap");
    }
  });
});
