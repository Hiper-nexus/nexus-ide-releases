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
    // Racks: a relação é o núcleo do cabo (path) por cima da capa grossa.
    const edgeLineRule = cssRule(missionCss, ".mission-graph__edge");
    expect(edgeLineRule).toMatch(/stroke:\s*var\(--/);
    expect(edgeLineRule).toMatch(/stroke-width:\s*(1\.5(px)?|[2-9](px)?)/);
    const cableRule = cssRule(missionCss, ".mission-graph__cable");
    expect(cableRule).toMatch(/stroke:\s*var\(--/);
    expect(cableRule).toMatch(/stroke-width:\s*([4-9]|1\d)(px)?/);

    // Canonical edge kinds (e.g., dependency kinds) should have distinct dash patterns
    expect(missionCss).toMatch(/\.mission-graph__edge--[^:]+\s*\{[^}]*stroke-dasharray:/);
  });

  it("collapsed board is one header line: extras and body hidden without unmount styles", () => {
    const collapsedRule = cssRule(missionCss, ".mission-board--collapsed");
    expect(collapsedRule).toMatch(/height:\s*auto/);
    expect(missionCss).toMatch(
      /\.mission-board__body\[hidden\]\s*\{[^}]*display:\s*none/,
    );
    expect(missionCss).toMatch(
      /\.mission-board--collapsed \.mission-board__reason\s*\{[^}]*display:\s*none/,
    );
    expect(missionCss).toMatch(
      /\.mission-board--collapsed \.mission-board__workspace[,\s]/,
    );
  });

  it("Mais menu is a token-styled panel that leaves flow only when hidden", () => {
    const menuRule = cssRule(missionCss, ".mission-board__menu");
    expect(menuRule).toMatch(/position:\s*absolute/);
    expect(menuRule).toMatch(/background:\s*var\(--bg-elevated\)/);
    expect(menuRule).toMatch(/border:\s*1px solid var\(--border-strong\)/);
    expect(missionCss).toMatch(
      /\.mission-board__menu\[hidden\]\s*\{[^}]*display:\s*none/,
    );
    expect(missionCss).toMatch(
      /\.mission-board__header--menu-open\s*\{[^}]*overflow:\s*visible/,
    );
  });

  it("keeps the mission title column from shrinking to a single letter", () => {
    const headerRule = cssRule(missionCss, ".mission-board__header");
    expect(headerRule).toMatch(
      /grid-template-columns:\s*minmax\(\s*(1[2-9]rem|[2-9]\drem)/,
    );
  });

  it("mission title stays one chrome line (F-010)", () => {
    const titleRule = cssRule(missionCss, ".mission-board__identity h1");
    expect(titleRule).toMatch(/white-space:\s*nowrap/);
    expect(titleRule).toMatch(/text-overflow:\s*ellipsis/);
    expect(titleRule).toMatch(/overflow:\s*hidden/);
  });

  it("wraps compact actions at the stacked-graph breakpoint so Terminais stays on-screen (F-005)", () => {
    const stackedAt = missionCss.indexOf(
      "@container mission-board (max-width: 1099px)",
    );
    const nextAt = missionCss.indexOf("@container", stackedAt + 1);
    const stackedBlock =
      nextAt === -1
        ? missionCss.slice(stackedAt)
        : missionCss.slice(stackedAt, nextAt);
    expect(stackedBlock).toMatch(/\.mission-board__header\s*\{/);
    expect(stackedBlock).toMatch(
      /\.mission-board__actions\s*\{[^}]*flex-wrap:\s*wrap/,
    );

    // Full reason text is not ellipsized in compact container query overrides
    // Check for absence of white-space: nowrap or text-overflow: ellipsis in reason rules inside container query
    const reasonRuleRegex = /@container[^{]*\{[\s\S]*?\.mission-board__reason[^}]*\}[\s\S]*?\}/;
    const match = missionCss.match(reasonRuleRegex);
    if (match) {
      expect(match[0]).not.toContain("text-overflow: ellipsis");
      expect(match[0]).not.toContain("white-space: nowrap");
    }
  });

  it("reserves toolbar space so zoom does not sit under the details toggle", () => {
    const toolbar = cssRule(
      missionCss,
      ".mission-board__graph-region .mission-graph:not(.mission-graph--presentation) .mission-graph__toolbar",
    );
    expect(toolbar).toContain(
      "padding-inline-end: calc(var(--mission-inspector-toggle-width) + var(--space-3) * 2)",
    );
    const toggle = cssRule(missionCss, ".mission-board__inspector-toggle");
    expect(toggle).toContain("inline-size: var(--mission-inspector-toggle-width)");
    expect(toggle).toContain("inset-inline-end: var(--space-3)");
    const zoom = cssRule(missionCss, ".mission-graph__zoom-controls");
    expect(zoom).toMatch(/flex-wrap:\s*nowrap/);
    expect(zoom).toMatch(/min-width:\s*max-content/);
    expect(missionCss).toMatch(
      /@container mission-board \(max-width: 720px\)[\s\S]*?\.mission-graph__zoom-controls\s*\{[^}]*flex:\s*1 1 100%/,
    );
    expect(missionCss).not.toMatch(/@media\s*\(max-width:\s*720px\)/);
    expect(missionCss).toMatch(/justify-content:\s*safe center/);
    expect(missionCss).toMatch(/\.mission-graph__surface\s*\{[^}]*position:\s*absolute/);
    expect(missionCss).toMatch(/\.mission-graph__surface\s*\{[^}]*margin-inline:\s*0/);
  });
});
