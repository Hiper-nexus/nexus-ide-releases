import fs from "node:fs";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(new URL("./window.ts", import.meta.url), "utf8");

function between(start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("deferred main renderer navigation", () => {
  it("keeps about:blank events outside renderer recovery authority", () => {
    for (const [start, end] of [
      ["wc.on('render-process-gone'", "win.on('unresponsive'"],
      ["wc.on('did-fail-load'", "const startLoadWatchdog"],
      ["wc.on('did-finish-load'", "wc.on('did-start-navigation'"],
      ["wc.on('did-start-navigation'", "const startRenderer"],
    ] as const) {
      expect(between(start, end)).toContain("!rendererStartAuthorized");
    }
  });

  it("starts one real navigation explicitly and keeps the normal activate path immediate", () => {
    const startRenderer = between(
      "const startRenderer = (): void =>",
      "return win;",
    );

    expect(startRenderer).toContain("rendererStartAuthorized = true");
    expect(startRenderer).toContain(
      "wc.once('did-finish-load', ensureMacDockPresence)",
    );
    expect(startRenderer).toContain("startLoadWatchdog();");
    expect(startRenderer).toContain("load();");
    expect(startRenderer).toContain(
      "if (options.deferRendererLoad !== true)",
    );
    expect(startRenderer).toContain("startMainWindowRenderer(win);");
  });
});
