import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { shouldCreateWindowOnActivate } from './app-lifecycle';

describe('macOS activate lifecycle', () => {
  it('constructs the native window before optional window integrations', () => {
    const source = fs.readFileSync(path.join(__dirname, 'window.ts'), 'utf-8');
    const windowStart = source.indexOf('const win = new BrowserWindow({');
    const integrationStart = source.indexOf('registerExternalLinkIpc();', windowStart);

    expect(windowStart).toBeGreaterThanOrEqual(0);
    expect(integrationStart).toBeGreaterThan(windowStart);
  });

  it('keeps the native window explicitly visible on launch', () => {
    const source = fs.readFileSync(path.join(__dirname, 'window.ts'), 'utf-8');
    expect(source).toContain('show: false');
    expect(source).toContain('showNativeWindow();');
    expect(source).toContain('ensureRegularMacOSActivation();');
    expect(source).toContain("win.webContents.once('did-finish-load', ensureMacDockPresence)");
  });

  it('sets regular macOS activation before creating the first window', () => {
    const source = fs.readFileSync(path.join(__dirname, 'window.ts'), 'utf-8');
    const policyStart = source.indexOf('ensureRegularMacOSActivation();');
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
    expect(source).not.toContain('reassertMacOSDockPresence();');
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
});
