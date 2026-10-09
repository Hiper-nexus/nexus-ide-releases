import fs from "node:fs";
import { describe, expect, it } from "vitest";

const mainSource = fs.readFileSync(new URL("./main.ts", import.meta.url), "utf8");
const bootstrapSource = mainSource.slice(
  mainSource.indexOf("async function bootstrap(): Promise<void>"),
  mainSource.indexOf("function isAutomatedReleaseTest"),
);
const appReadySource = mainSource.slice(
  mainSource.indexOf("app.whenReady().then"),
  mainSource.indexOf("app.on(\"second-instance\""),
);

describe("main bootstrap settings migration order", () => {
  it("migrates retired provider defaults before any orchestration runtime is configured", () => {
    const settings = bootstrapSource.indexOf("registerSettingsIpc();");
    const adapters = bootstrapSource.indexOf("initAdapterRegistry();");
    const providers = bootstrapSource.indexOf(
      "initializeProviderConfigStore();",
    );
    const migration = bootstrapSource.indexOf(
      "migrateRetiredOrchestratorSettings({",
    );
    const runtime = bootstrapSource.indexOf(
      "projectRuntimeManager = new ProjectRuntimeManager",
    );
    // configureMissionScheduler foi varrido com o núcleo cerimonial (ac0bc643);
    // o fast-lane não agenda no bootstrap. O que importa aqui é que o runtime
    // de orquestração só é construído DEPOIS da migração dos defaults retirados.
    const orchestrationIpc = bootstrapSource.indexOf("registerOrchIpc();");

    expect([
      settings,
      adapters,
      providers,
      migration,
      runtime,
      orchestrationIpc,
    ]).not.toContain(-1);
    expect(settings).toBeLessThan(adapters);
    expect(adapters).toBeLessThan(providers);
    expect(providers).toBeLessThan(migration);
    expect(migration).toBeLessThan(runtime);
    expect(migration).toBeLessThan(orchestrationIpc);
  });

  it("keeps an atomic migration write failure non-fatal to desktop bootstrap", () => {
    expect(bootstrapSource).toMatch(
      /try\s*\{\s*migrateRetiredOrchestratorSettings\(\{[\s\S]*?\}\);\s*\}\s*catch\s*\(error\)\s*\{[\s\S]*?console\.warn/um,
    );
  });

  it("constructs the native window early but starts React only after every bootstrap IPC is registered", () => {
    const createWindow = appReadySource.indexOf(
      "createMainWindow({ deferRendererLoad: true })",
    );
    const resolvePath = appReadySource.indexOf("await resolveUserPath();");
    const bootstrap = appReadySource.indexOf("await bootstrap();");
    const startRenderer = appReadySource.indexOf(
      "startMainWindowRenderer(mainWindow)",
    );
    const bootstrapFailure = appReadySource.indexOf(
      "bootstrap failed before renderer navigation",
    );

    expect([
      createWindow,
      resolvePath,
      bootstrap,
      startRenderer,
      bootstrapFailure,
    ]).not.toContain(-1);
    expect(createWindow).toBeLessThan(resolvePath);
    expect(resolvePath).toBeLessThan(bootstrap);
    expect(bootstrap).toBeLessThan(startRenderer);
    expect(startRenderer).toBeLessThan(bootstrapFailure);
  });
});

describe("main Squirrel install/update events", () => {
  it("do not run the app boot, so nothing launched from the hook holds the installer", () => {
    const flag = mainSource.indexOf("squirrelStartupEvent = true;");
    const gate = mainSource.indexOf("if (squirrelStartupEvent || !wireDeepLinks()) {");
    const ready = mainSource.indexOf("app.whenReady().then");
    expect(flag).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(flag);
    // O boot (e o sync do Redline dentro dele) só existe no ramo else do gate.
    expect(ready).toBeGreaterThan(gate);
  });
});


describe('Main Shot destination wiring (F-1054)', () => {
  it('uses bound renderer scope plus live Main inventory and forwards the target in the event', () => {
    const shot = mainSource.slice(mainSource.indexOf('await startShotBridgeServer({'), mainSource.indexOf('[main] shot-bridge bootstrap failed:'));
    expect(shot).toContain('listPaneSnapshots()');
    expect(shot).toContain('getRendererWorkspaceScope(win.webContents)');
    expect(shot).toContain('listLiveSessionLocations()');
    expect(shot).toContain('onFiles: (files, targetPaneId)');
    expect(shot).toContain('...(targetPaneId ? { targetPaneId } : {})');
    expect(shot).toContain('app.getPath("pictures")');
    expect(shot).toContain('app.getPath("videos")');
  });
});
