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

  it("starts renderer navigation early and holds the React mount on the boot:ready gate", () => {
    const createWindow = appReadySource.indexOf(
      "createMainWindow({ deferRendererLoad: true })",
    );
    const resolvePath = appReadySource.indexOf("const userPathReady = resolveUserPath({");
    const startRenderer = appReadySource.indexOf(
      "startMainWindowRenderer(mainWindow)",
    );
    const bootstrap = appReadySource.indexOf("await bootstrap(userPathReady);");
    const gateResolve = appReadySource.indexOf("resolveBootReady();");
    const gateReject = appReadySource.indexOf("rejectBootReady(error)");
    const bootstrapFailure = appReadySource.indexOf(
      "bootstrap failed before renderer navigation",
    );

    expect([
      createWindow,
      resolvePath,
      startRenderer,
      bootstrap,
      gateResolve,
      gateReject,
      bootstrapFailure,
    ]).not.toContain(-1);
    expect(resolvePath).toBeLessThan(createWindow);
    // A navegação roda em paralelo ao bootstrap; quem segura o React é o
    // gate boot:ready — ele resolve só depois de todo o IPC registrado.
    expect(startRenderer).toBeLessThan(bootstrap);
    expect(bootstrap).toBeLessThan(gateResolve);
    expect(gateResolve).toBeLessThan(gateReject);
    expect(gateReject).toBeLessThan(bootstrapFailure);
    expect(appReadySource).toContain("await withBootReadyDeadline(async () => {");
    expect(appReadySource).toContain("handleBootReadyFailure(error, {");
    expect(appReadySource).toContain("isShutdownSealed: isPtySessionAdmissionSealedForShutdown");
    const telemetryAwait = bootstrapSource.indexOf("await bootStepAsync('initUsageTelemetry'");
    const shutdownCheckAfterTelemetry = bootstrapSource.indexOf(
      "if (isPtySessionAdmissionSealedForShutdown()) return;",
      telemetryAwait,
    );
    const initOrch = bootstrapSource.indexOf("void initOrchestration()");
    expect(telemetryAwait).toBeGreaterThan(-1);
    expect(shutdownCheckAfterTelemetry).toBeGreaterThan(telemetryAwait);
    expect(shutdownCheckAfterTelemetry).toBeLessThan(initOrch);
  });

  it("does not park the window on the 4 s orchestration race — CLI spawns wait at their own gate", () => {
    // A corrida de 16/08 se resolve no funil de spawn (pty-ipc espera
    // orchestrationReady), não bloqueando a janela num teto arbitrário.
    const gateRegion = appReadySource.slice(
      appReadySource.indexOf("await bootstrap(userPathReady);"),
      appReadySource.indexOf("resolveBootReady();"),
    );
    expect(gateRegion).not.toContain("initOrchestration(");
    expect(gateRegion).not.toContain("Promise.race(");
    // O fire-and-forget do bootstrap continua: a orquestração inicia cedo,
    // só não é mais pré-condição da janela.
    expect(bootstrapSource).toContain("void initOrchestration()");
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

describe('Post-boot idle queue deferral', () => {
  it('defers heavy post-boot work to enqueuePostBootIdleTask and registers quota lazily', () => {
    expect(bootstrapSource).toContain("enqueuePostBootIdleTask('startCliAutoUpdate'");
    expect(bootstrapSource).toContain("enqueuePostBootIdleTask('maybeOfferFirstRunProvisioning'");
    expect(bootstrapSource).toContain("enqueuePostBootIdleTask('createRedlineSink'");
    expect(bootstrapSource).toContain("enqueuePostBootIdleTask('syncInstalledRedline'");
    expect(bootstrapSource).toContain("registerQuotaServiceLazy(() => ({");
    expect(bootstrapSource).toContain("enqueuePostBootIdleTask('startMissionQuotaPoll'");
    expect(bootstrapSource).not.toContain("bootStep('getSearchMixer', () => getSearchMixer())");
    expect(appReadySource).toContain("enqueuePostBootIdleTask('post-boot-hooks-and-shot-bridge'");
  });

  it('configures the agent hook endpoint before React can restore panes (B1)', () => {
    // pty-manager injects NEXUS_AGENT_HOOK_ENDPOINT/NEXUS_PANE_KEY only when the
    // endpoint already exists at spawn; panes restored on mount keep their env.
    // Com o renderer paralelo, "antes do React" = antes do gate resolver.
    const gateResolve = appReadySource.indexOf('resolveBootReady();');
    const steps = [
      'configureAgentRuntimeUserDataPath(userDataPath);',
      'bootstrapManagedAgentHooks({ enabled: false });',
      'await startAgentHookHttpServer({ userDataPath });',
      'configureAgentHookEndpointPath(hookServer.endpointFilePath);',
      'hookDropBoxWatcher.start();',
    ];
    const positions = steps.map((step) => appReadySource.indexOf(step));
    expect([gateResolve, ...positions]).not.toContain(-1);
    for (const step of steps) {
      expect(mainSource.split(step).length - 1, step).toBe(1);
    }
    positions.reduce((previous, position) => {
      expect(previous).toBeLessThan(position);
      return position;
    });
    expect(positions.at(-1)).toBeLessThan(gateResolve);
    // A queued closure written above the renderer mount gate would still run
    // after mount: nothing before it may be deferred to the idle queue.
    expect(appReadySource.slice(0, gateResolve)).not.toContain('enqueuePostBootIdleTask(');
    const queuedHooks = appReadySource.slice(
      appReadySource.indexOf("enqueuePostBootIdleTask('post-boot-hooks-and-shot-bridge'"),
      appReadySource.indexOf('// Gap B:'),
    );
    expect(queuedHooks).toContain('resolveManagedHookConsent');
    expect(queuedHooks).not.toContain('startAgentHookHttpServer');
  });

  it('runs the cache-only Claude freshness pass in bootstrap, before the renderer (C5)', () => {
    expect(bootstrapSource).toMatch(/traceBootstrap\('before Claude subscription freshness'\);\s*startClaudeSubscriptionFreshness\(\);/u);
    expect(mainSource).not.toContain("enqueuePostBootIdleTask('startClaudeSubscriptionFreshness'");
  });

  it('arms the idle-queue ceilings at whenReady and never awaits the provisioning modal in series (C1/C2)', () => {
    const arm = appReadySource.indexOf('startPostBootIdleQueue();');
    const createWindow = appReadySource.indexOf('createMainWindow({ deferRendererLoad: true })');
    expect(arm).toBeGreaterThan(-1);
    expect(arm).toBeLessThan(createWindow);
    const provisioning = bootstrapSource.slice(
      bootstrapSource.indexOf("enqueuePostBootIdleTask('maybeOfferFirstRunProvisioning'"),
      bootstrapSource.indexOf("enqueuePostBootIdleTask('createRedlineSink'"),
    );
    expect(provisioning).toContain('void maybeOfferFirstRunProvisioning(');
    expect(provisioning).not.toContain('await maybeOfferFirstRunProvisioning(');
  });

  it('bounds the idle-queue stop inside a tracked shutdown phase (C2)', () => {
    expect(mainSource).toMatch(/await trackShutdownPhase\("stopPostBootIdleQueue", \(\) => stopPostBootIdleQueue\(\)\);/u);
    expect(mainSource).not.toMatch(/\n\s*await stopPostBootIdleQueue\(\);/u);
  });
});
