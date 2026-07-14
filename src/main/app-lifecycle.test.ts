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
    expect(source).toContain('show: true');
    expect(source).toContain('win.show();');
    expect(source).toContain("app.setActivationPolicy?.('regular')");
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
