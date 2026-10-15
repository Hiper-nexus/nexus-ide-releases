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

  it("registers the boot:ready gate before any renderer navigation", () => {
    const create = between(
      "export function createMainWindow(",
      "const startRenderer = (): void =>",
    );
    expect(create).toContain("registerBootReadyIpc()");
  });

  it("reveals the native frame at ready-to-show only for the authorized renderer URL that loaded without error", () => {
    const readyToShow = between(
      "win.on('ready-to-show'",
      "const commitRendererBoot",
    );
    expect(readyToShow).toContain("!rendererStartAuthorized");
    expect(readyToShow).toContain("win.isVisible()");
    expect(readyToShow).toContain("lastLoadFailed");
    expect(readyToShow).toContain("isAuthorizedRendererSurfaceReady(");
    expect(readyToShow).toContain("markBootPhase('ready-to-show')");
    expect(readyToShow).toContain("win.show()");
    // Não é o commit: o show definitivo (Dock/foco) continua no mount.
    expect(readyToShow).not.toContain("commitRendererBoot()");

    const helper = between(
      "export function isAuthorizedRendererSurfaceReady(",
      "export function createMainWindow(",
    );
    expect(helper).toContain("about:blank");
    expect(helper).toContain("input.lastLoadFailed");
    expect(helper).toContain("new URL(input.currentUrl).href === new URL(input.expectedRendererUrl).href");
  });

  it("treats a renderer awaiting the boot gate as alive in Main up to the deadline without executeJavaScript polling", () => {
    const mountPoll = between(
      "wc.on('did-finish-load'",
      "wc.on('did-start-navigation'",
    );
    const rearmCheck = mountPoll.indexOf("shouldRearmMountWatchdogForBootGate(");
    const rootProbe = mountPoll.indexOf("wc.executeJavaScript(");
    expect(rearmCheck).toBeGreaterThanOrEqual(0);
    expect(rootProbe).toBeGreaterThan(rearmCheck);
    expect(mountPoll).toContain("mountWatchdog.arm()");
    expect(mountPoll).not.toContain("__nexusBootAwaiting");
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
