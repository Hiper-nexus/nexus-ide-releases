import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("MissionJournalPanel responsive controls", () => {
  it("wraps refresh controls instead of overflowing the 200px panel", () => {
    const component = readFileSync(
      "src/renderer/components/product/MissionJournalPanel.tsx",
      "utf8",
    );
    const css = readFileSync(
      "src/renderer/styles/product-wave.css",
      "utf8",
    );

    expect(component).toContain("mission-journal__controls");
    expect(css).toMatch(
      /\.mission-journal__controls\s*\{[^}]*flex-wrap:\s*wrap;/u,
    );
    expect(css).toMatch(
      /\.mission-journal__controls\s*>\s*\.product-pane__input\s*\{[^}]*flex:\s*1\s+1\s+140px;[^}]*width:\s*auto;[^}]*min-width:\s*0;/u,
    );
  });
});
