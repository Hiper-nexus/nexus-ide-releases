import fs from "node:fs";
import { describe, expect, it } from "vitest";

const mainSource = fs.readFileSync(new URL("./main.ts", import.meta.url), "utf8");
const bootstrapSource = mainSource.slice(
  mainSource.indexOf("async function bootstrap("),
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
    const resolvePath = appReadySource.indexOf("const userPathReady = resolveUserPath({");
    const bootstrap = appReadySource.indexOf("await bootstrap(userPathReady);");
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
    expect(resolvePath).toBeLessThan(createWindow);
    expect(resolvePath).toBeLessThan(bootstrap);
    expect(bootstrap).toBeLessThan(startRenderer);
    expect(startRenderer).toBeLessThan(bootstrapFailure);
  });

  it('awaits the early PATH flight immediately before adapter discovery and automatically rescans after revalidation', () => {
    expect(bootstrapSource).toMatch(/await userPathReady;\s*initAdapterRegistry\(\);/u);
    expect(appReadySource).toContain('cachePath: path.join(app.getPath("userData"), "login-path.json")');
    expect(appReadySource).toContain('void userPathReady.catch(() => undefined);');
    expect(appReadySource).toMatch(/retryLoginShellPathIfMissed\(\)\s*\.then\(\(changed\) => \(changed \? rescanAdapterBinaries\(\) : undefined\)\)/u);
  });

  it('starts the native heavy-job proof without holding bootstrap', () => {
    expect(bootstrapSource).toContain("void bootStepAsync('nativeHeavyJobEnvironment'");
    expect(bootstrapSource).not.toContain("await bootStepAsync('nativeHeavyJobEnvironment'");
  });

  it('overlaps an asynchronous orphan supervisor sweep with window creation, but finishes before any host can spawn', () => {
    const startSweep = appReadySource.indexOf("const orphanSupervisorSweep = bootStepAsync(");
    const createWindow = appReadySource.indexOf('createMainWindow({ deferRendererLoad: true })');
    const awaitSweep = appReadySource.indexOf('await orphanSupervisorSweep;');
    const bootstrap = appReadySource.indexOf('await bootstrap(userPathReady);');
    expect([startSweep, createWindow, awaitSweep, bootstrap]).not.toContain(-1);
    expect(startSweep).toBeLessThan(createWindow);
    expect(createWindow).toBeLessThan(awaitSweep);
    expect(awaitSweep).toBeLessThan(bootstrap);
    const sweep = appReadySource.slice(startSweep, createWindow);
    expect(sweep).toContain('execFile("/bin/ps"');
    expect(sweep).toContain('listProcesses: () => processes');
    expect(sweep).not.toContain('execFileSync');
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
    expect(shot).toContain('onFiles: (files, targetPaneId, targetBinding)');
    expect(shot).toContain('...(targetPaneId ? { targetPaneId } : {})');
    expect(shot).toContain('...(targetBinding ? { targetBinding } : {})');
    expect(shot).toContain('app.getPath("pictures")');
    expect(shot).toContain('app.getPath("videos")');
  });
});
