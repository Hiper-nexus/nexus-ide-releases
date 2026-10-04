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
  it('adds the soak renderer marker only from the explicit Main private smoke branch', () => {
    const create = between('export function createMainWindow(', '// Establish the user-facing application policy');
    expect(create).toContain('isSoakSmokeRequested');
    expect(create).toContain('smokeTest: isCurrentProcessSmokeTest()');
    expect(create).toContain('packaged: app.isPackaged');
    expect(create).toContain('userData: app.getPath(\'userData\')');
    expect(create).toContain('privateSoak ?');
  });
  it("keeps xterm parsing timers active in a covered second Nexus window", () => {
    expect(between("const win = new BrowserWindow({", "// Policy already set before construction"))
      .toContain("backgroundThrottling: process.platform !== 'darwin'");
  });

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
