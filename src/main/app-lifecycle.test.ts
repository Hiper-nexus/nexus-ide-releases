import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  restoreMainWindowOnActivate,
  shouldCreateWindowOnActivate,
} from './app-lifecycle';

describe('macOS activate lifecycle', () => {
  it('constructs the native window before optional window integrations', () => {
    const source = fs.readFileSync(path.join(__dirname, 'window.ts'), 'utf-8');
    const windowStart = source.indexOf('const win = new BrowserWindow({');
    const integrationStart = source.indexOf('registerExternalLinkIpc();', windowStart);

    expect(windowStart).toBeGreaterThanOrEqual(0);
    expect(integrationStart).toBeGreaterThan(windowStart);
  });

  it('stops bootstrap when the fail-closed CSP boundary refuses the main window', () => {
    const source = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf-8');
    const windowAttempt = source.indexOf(
      'const mainWindow = createMainWindow({ deferRendererLoad: true });',
    );
    const failedGuard = source.indexOf('if (!mainWindow)', windowAttempt);
    const quit = source.indexOf('app.quit();', failedGuard);
    const bootstrap = source.indexOf('await bootstrap();', windowAttempt);

    expect(windowAttempt).toBeGreaterThanOrEqual(0);
    expect(failedGuard).toBeGreaterThan(windowAttempt);
    expect(quit).toBeGreaterThan(failedGuard);
    expect(bootstrap).toBeGreaterThan(quit);
    expect(source.slice(failedGuard, bootstrap)).toContain('return;');
  });

  it('installs the packaged renderer protocol before the first window navigates', () => {
    const source = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf-8');
    const readyStart = source.indexOf('app.whenReady().then(async () => {');
    const protocolInstall = source.indexOf(
      'installRendererProtocol(',
      readyStart,
    );
    const windowAttempt = source.indexOf(
      'const mainWindow = createMainWindow({ deferRendererLoad: true });',
      readyStart,
    );

    expect(readyStart).toBeGreaterThanOrEqual(0);
    expect(protocolInstall).toBeGreaterThan(readyStart);
    expect(protocolInstall).toBeLessThan(windowAttempt);
  });

  it('keeps the native window explicitly visible on launch', () => {
    const source = fs.readFileSync(path.join(__dirname, 'window.ts'), 'utf-8');
    expect(source).toContain('show: false');
    expect(source).toContain('showNativeWindow();');
    expect(source).toContain('ensureRegularMacOSActivation();');
    expect(source).toContain(
      "wc.once('did-finish-load', ensureMacDockPresence)",
    );
  });

  it('keeps mount recovery on a Main-owned deadline across renderer lifecycle changes', () => {
    const source = fs.readFileSync(path.join(__dirname, 'window.ts'), 'utf-8');
    const mountedStart = source.indexOf('const onMounted =');
    const mountedEnd = source.indexOf(
      'ipcMain.on(WINDOW_CHANNELS.mounted',
      mountedStart,
    );
    const destroyedStart = source.indexOf("wc.once('destroyed'", mountedEnd);
    const destroyedEnd = source.indexOf('// Dev only:', destroyedStart);
    const finishedStart = source.indexOf("wc.on('did-finish-load'");
    const pollStart = source.indexOf('const poll = setInterval', finishedStart);
    const navigationStart = source.indexOf(
      "wc.on('did-start-navigation'",
      pollStart,
    );

    expect(source.slice(mountedStart, mountedEnd)).toContain(
      'commitRendererBoot();',
    );
    const commitStart = source.indexOf('const commitRendererBoot =');
    const commitEnd = source.indexOf('// Renderer → main mount signal', commitStart);
    expect(source.slice(commitStart, commitEnd)).toContain(
      'stopMountMonitoring();',
    );
    expect(source.slice(destroyedStart, destroyedEnd)).toContain(
      'stopMountMonitoring();',
    );
    expect(source.slice(finishedStart, pollStart)).toContain(
      'if (mounted) return;',
    );
    expect(source.slice(finishedStart, pollStart)).toContain(
      'mountWatchdog.arm();',
    );
    const navigationBlock = source.slice(navigationStart);
    expect(navigationBlock).toContain('details.isMainFrame');
    expect(navigationBlock).toContain('details.isSameDocument');
    expect(navigationBlock).toContain('stopMountMonitoring();');
    expect(navigationBlock).toContain('startLoadWatchdog();');
    expect(source.slice(finishedStart, pollStart)).not.toContain(
      'clearInterval(loadWatchdog)',
    );
  });

  it('sets regular macOS activation before creating the first window', () => {
    const source = fs.readFileSync(path.join(__dirname, 'window.ts'), 'utf-8');
    // ensureMacDockPresence → reassertMacOSDockPresence → setActivationPolicy
    const policyStart = source.indexOf('ensureMacDockPresence();');
    const windowStart = source.indexOf('const win = new BrowserWindow({');

    expect(policyStart).toBeGreaterThanOrEqual(0);
    expect(policyStart).toBeLessThan(windowStart);
  });

  it('configures regular activation synchronously before app ready', () => {
    const source = fs.readFileSync(
      path.join(__dirname, 'macos-activation-policy.ts'),
      'utf-8',
    );
    const policyStart = source.indexOf("app.setActivationPolicy('regular')");
    const sideEffectStart = source.indexOf('ensureRegularMacOSActivation();', policyStart);

    expect(policyStart).toBeGreaterThanOrEqual(0);
    expect(sideEffectStart).toBeGreaterThan(policyStart);
  });

  it('uses a tiny bootstrap before loading the runtime graph', () => {
    const source = fs.readFileSync(
      path.join(__dirname, 'main-bootstrap.ts'),
      'utf-8',
    );
    expect(source.indexOf("import { app } from 'electron';")).toBeGreaterThanOrEqual(0);
    const policyCall = source.indexOf('ensureRegularMacOSActivation();');
    const runtimeImport = source.indexOf("import('./main')");

    expect(policyCall).toBeGreaterThanOrEqual(0);
    expect(runtimeImport).toBeGreaterThan(policyCall);
  });

  it('does not let the desktop pet hide the whole app from the macOS Dock', () => {
    const source = fs.readFileSync(
      path.join(__dirname, 'pet', 'pet-window.ts'),
      'utf-8',
    );

    expect(source).toContain("skipTaskbar: process.platform !== 'darwin'");
    expect(source).toContain('skipTransformProcessType: true');
    expect(source).not.toContain('skipTaskbar: true');
    // Hot path must NOT spam dock.show() (creates 12×0 ghost tiles).
    expect(source).not.toContain('reassertMacOSDockPresence();');
  });

  it('applies the product Dock icon and avoids show() spam', () => {
    const policy = fs.readFileSync(
      path.join(__dirname, 'macos-activation-policy.ts'),
      'utf-8',
    );
    expect(policy).toContain('app.dock.setIcon');
    expect(policy).toContain('isVisible');
    expect(policy).toContain('electron.icns');
  });

  it('creates a window only while the app runtime is live', () => {
    expect(
      shouldCreateWindowOnActivate({
        isShutdownInProgress: false,
        isShutdownComplete: false,
        windowCount: 0,
      }),
    ).toBe(true);
    expect(
      shouldCreateWindowOnActivate({
        isShutdownInProgress: true,
        isShutdownComplete: false,
        windowCount: 0,
      }),
    ).toBe(false);
    expect(
      shouldCreateWindowOnActivate({
        isShutdownInProgress: false,
        isShutdownComplete: true,
        windowCount: 0,
      }),
    ).toBe(false);
    expect(
      shouldCreateWindowOnActivate({
        isShutdownInProgress: false,
        isShutdownComplete: false,
        windowCount: 1,
      }),
    ).toBe(false);
  });

  it('restores and focuses an existing hidden main window on activate', () => {
    const calls: string[] = [];
    const window = {
      isDestroyed: () => false,
      isMinimized: () => true,
      restore: () => calls.push('restore'),
      show: () => calls.push('show'),
      focus: () => calls.push('focus-window'),
    };

    expect(
      restoreMainWindowOnActivate(
        {
          isShutdownInProgress: false,
          isShutdownComplete: false,
        },
        window,
        () => calls.push('focus-app'),
      ),
    ).toBe(true);
    expect(calls).toEqual([
      'restore',
      'show',
      'focus-app',
      'focus-window',
    ]);
  });

  it('never restores a window after shutdown starts or after destruction', () => {
    const calls: string[] = [];
    const window = {
      isDestroyed: () => false,
      isMinimized: () => false,
      restore: () => calls.push('restore'),
      show: () => calls.push('show'),
      focus: () => calls.push('focus-window'),
    };

    expect(
      restoreMainWindowOnActivate(
        {
          isShutdownInProgress: true,
          isShutdownComplete: false,
        },
        window,
        () => calls.push('focus-app'),
      ),
    ).toBe(false);
    expect(
      restoreMainWindowOnActivate(
        {
          isShutdownInProgress: false,
          isShutdownComplete: false,
        },
        { ...window, isDestroyed: () => true },
        () => calls.push('focus-app'),
      ),
    ).toBe(false);
    expect(calls).toEqual([]);
  });

  it('does not dispose keep-awake before the user confirms quit', () => {
    const source = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf-8');
    const beforeQuit = source.indexOf('app.on("before-quit"');
    const confirmation = source.indexOf('closeNeedsConfirmation', beforeQuit);
    expect(beforeQuit).toBeGreaterThanOrEqual(0);
    expect(confirmation).toBeGreaterThan(beforeQuit);
    expect(source.slice(beforeQuit, confirmation)).not.toContain(
      'disposeAgentAwakeService()',
    );
  });

  it('proves every PTY tree before declaring quit complete', () => {
    const source = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf-8');
    const shutdownStart = source.indexOf('function shutdown(): Promise<void>');
    const physicalFence = source.indexOf(
      'await shutdownOrchestrationRuntimesRecordingStragglers(',
      shutdownStart,
    );
    const completion = source.indexOf(
      'shutdownComplete = true;',
      physicalFence,
    );

    expect(shutdownStart).toBeGreaterThanOrEqual(0);
    expect(physicalFence).toBeGreaterThan(shutdownStart);
    expect(completion).toBeGreaterThan(physicalFence);
    expect(source).not.toContain('killAllSessions();');
    // The graceful shutdown lane never force-exits — it proves every PTY tree
    // and then app.quit()s. app.exit is reserved for the hard-ceiling backstop
    // below, never reachable on the provable success path.
    const shutdownBody = source.slice(shutdownStart, completion);
    expect(shutdownBody).not.toContain('app.exit(');
  });

  // TOMBSTONE (06/08): o backstop era cancelado pelo próprio caminho de erro
  // que ele cobria — o .catch limpava o timer de app.exit. O teto agora é
  // INARREDÁVEL: armado antes do shutdown e sem nenhuma API de clear; só a
  // decisão explícita do operador de manter o app aberto (nos avisos) desarma.
  it('bounds quit with an UNCLEARABLE hard ceiling — no catch can remove it', () => {
    const source = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf-8');
    const beforeQuit = source.indexOf('app.on("before-quit"');
    const armIdx = source.indexOf('quitCeiling.arm();', beforeQuit);
    const shutdownCall = source.indexOf('void shutdown()', beforeQuit);

    expect(beforeQuit).toBeGreaterThanOrEqual(0);
    // Armado ANTES do shutdown ser aguardado: um wedge interno nunca corre
    // mais rápido que o teto.
    expect(armIdx).toBeGreaterThan(beforeQuit);
    expect(armIdx).toBeLessThan(shutdownCall);
    // O timer clearável antigo não existe mais em NENHUMA forma.
    expect(source).not.toContain('forceQuitDeadline');
    // Nenhuma linha do fluxo de quit toca o teto depois de armado — o único
    // desarme vive no controller de avisos, atrás da escolha do operador.
    const afterArm = source.slice(armIdx + 'quitCeiling.arm();'.length);
    expect(afterArm).not.toContain('quitCeiling.abandonQuitByUser');
    // O construtor do teto entrega app.exit como última instância.
    const ceilingDeps = source.indexOf('createUnclearableQuitCeiling({');
    expect(ceilingDeps).toBeGreaterThanOrEqual(0);
    expect(
      source.slice(ceilingDeps, source.indexOf('});', ceilingDeps)),
    ).toContain('app.exit(0)');
  });

  it('keeps the app open with an actionable retry when safe shutdown fails', () => {
    const source = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf-8');
    const shutdownUiSource = fs.readFileSync(
      path.join(__dirname, 'app-shutdown-ui.ts'),
      'utf-8',
    );
    const beforeQuit = source.indexOf('app.on("before-quit"');
    const failure = source.indexOf(
      'shutdownNotices.showFailure(error);',
      beforeQuit,
    );

    expect(failure).toBeGreaterThan(beforeQuit);
    expect(source.slice(beforeQuit, failure)).toContain(
      'shutdownPromise = null;',
    );
    // Falha nunca é beco: forçar (registro), tentar de novo, ou — a ÚNICA
    // revogação do quit — manter aberto por decisão explícita do operador.
    const quitGuaranteeSource = fs.readFileSync(
      path.join(__dirname, 'app-quit-guarantee.ts'),
      'utf-8',
    );
    expect(quitGuaranteeSource).toContain('"Forçar encerramento agora"');
    expect(quitGuaranteeSource).toContain('"Tentar novamente"');
    expect(quitGuaranteeSource).toContain('"Manter o NexusIDE aberto"');
    expect(shutdownUiSource).toContain('buildFailureQuitNotice');
    expect(shutdownUiSource).toContain('deps.forceExit("failure-notice")');
    expect(shutdownUiSource).toContain('deps.revokeQuitAuthorization();');
    expect(shutdownUiSource).toContain('deps.abandonQuit();');
  });

  it('routes confirmed process-bearing window close through the physical app shutdown lane', () => {
    const windowSource = fs.readFileSync(
      path.join(__dirname, 'window.ts'),
      'utf-8',
    );
    const closeSource = fs.readFileSync(
      path.join(__dirname, 'close-authorization.ts'),
      'utf-8',
    );
    const mainSource = fs.readFileSync(
      path.join(__dirname, 'main.ts'),
      'utf-8',
    );

    const confirmation = windowSource.indexOf(
      'completeConfirmedWindowClose({',
    );
    const closeHandler = windowSource.indexOf("win.on('close'");
    const globalInventory = windowSource.indexOf(
      'const summary = liveRuntimeProcessSummary();',
      closeHandler,
    );
    const appQuit = windowSource.indexOf(
      'quitApp: () => app.quit()',
      confirmation,
    );
    expect(globalInventory).toBeGreaterThan(closeHandler);
    expect(confirmation).toBeGreaterThanOrEqual(0);
    expect(appQuit).toBeGreaterThan(confirmation);
    expect(windowSource).not.toContain('windowCloseAuthorized');
    const admissionSeal = closeSource.indexOf('deps.sealRuntimeAdmission();');
    const authorization = closeSource.indexOf('authorizeAppQuit();');
    const quit = closeSource.indexOf('deps.quitApp();');
    expect(admissionSeal).toBeLessThan(authorization);
    expect(authorization).toBeLessThan(quit);
    const zeroSnapshot = windowSource.indexOf(
      '// Even a zero snapshot can have queued orchestration.',
      closeHandler,
    );
    expect(windowSource.indexOf('beginSafeAppShutdown();', zeroSnapshot))
      .toBeGreaterThan(zeroSnapshot);
    const cancelGuard = windowSource.indexOf(
      'if (response !== 1 || win.isDestroyed()) return;',
      confirmation,
    );
    expect(windowSource.indexOf('beginSafeAppShutdown();', cancelGuard))
      .toBeGreaterThan(cancelGuard);

    const shutdownFunction = mainSource.indexOf(
      'function shutdown(): Promise<void>',
    );
    const beforeQuit = mainSource.indexOf('app.on("before-quit"');
    const physicalProof = mainSource.indexOf(
      'await shutdownOrchestrationRuntimesRecordingStragglers(',
      shutdownFunction,
    );
    const completion = mainSource.indexOf(
      'shutdownComplete = true;',
      physicalProof,
    );
    const shutdownCall = mainSource.indexOf('void shutdown()', beforeQuit);
    const sealBeforeShutdown = mainSource.indexOf(
      'sealRuntimeProcessAdmissionForShutdown();',
      beforeQuit,
    );
    expect(physicalProof).toBeGreaterThan(shutdownFunction);
    expect(physicalProof).toBeLessThan(beforeQuit);
    expect(completion).toBeGreaterThan(physicalProof);
    expect(sealBeforeShutdown).toBeGreaterThan(beforeQuit);
    expect(sealBeforeShutdown).toBeLessThan(shutdownCall);
    expect(shutdownCall).toBeGreaterThan(beforeQuit);
  });
});
