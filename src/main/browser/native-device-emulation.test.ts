import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  canDriveNativeDeviceEmulation,
  disableNativeDeviceEmulation,
  enableNativeDeviceEmulation,
} from './native-device-emulation';

const PARAMS = {
  screenPosition: 'mobile' as const,
  screenSize: { width: 390, height: 844 },
  viewPosition: { x: 0, y: 0 },
  viewSize: { width: 390, height: 844 },
  deviceScaleFactor: 0,
  scale: 1,
};

function target(state: { destroyed?: boolean; crashed?: boolean } = {}) {
  return {
    isDestroyed: vi.fn(() => state.destroyed ?? false),
    isCrashed: vi.fn(() => state.crashed ?? false),
    enableDeviceEmulation: vi.fn(),
    disableDeviceEmulation: vi.fn(),
  };
}

describe('native device emulation fence (F-1656, F-1659)', () => {
  it('drives the native emulation only on a live renderer that committed a document', () => {
    const wc = target();
    expect(enableNativeDeviceEmulation(wc, true, PARAMS)).toBe(true);
    expect(wc.enableDeviceEmulation).toHaveBeenCalledWith(PARAMS);
    expect(disableNativeDeviceEmulation(wc, true)).toBe(true);
    expect(wc.disableDeviceEmulation).toHaveBeenCalledOnce();
  });

  it('refuses before the first commit: there is no RenderWidgetHostView yet', () => {
    const wc = target();
    expect(canDriveNativeDeviceEmulation(wc, false)).toBe(false);
    expect(enableNativeDeviceEmulation(wc, false, PARAMS)).toBe(false);
    expect(disableNativeDeviceEmulation(wc, false)).toBe(false);
    expect(wc.enableDeviceEmulation).not.toHaveBeenCalled();
    expect(wc.disableDeviceEmulation).not.toHaveBeenCalled();
  });

  it('refuses a dead renderer even before render-process-gone reached the Main', () => {
    // Electron 43 destrói o RenderWidgetHostView quando o renderer morre; o
    // `isCrashed()` já vale antes de o evento chegar ao listener do Main.
    const wc = target({ crashed: true });
    expect(enableNativeDeviceEmulation(wc, true, PARAMS)).toBe(false);
    expect(disableNativeDeviceEmulation(wc, true)).toBe(false);
    expect(wc.enableDeviceEmulation).not.toHaveBeenCalled();
    expect(wc.disableDeviceEmulation).not.toHaveBeenCalled();
  });

  it('refuses a destroyed WebContents without asking it anything else', () => {
    const wc = target({ destroyed: true });
    expect(enableNativeDeviceEmulation(wc, true, PARAMS)).toBe(false);
    expect(disableNativeDeviceEmulation(wc, true)).toBe(false);
    expect(wc.isCrashed).not.toHaveBeenCalled();
    expect(wc.enableDeviceEmulation).not.toHaveBeenCalled();
  });
});

const SOURCE_ROOT = path.resolve(__dirname, '../..');
const NATIVE_CALL = /\.(?:enable|disable)DeviceEmulation\s*\(/;

function productionSources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return productionSources(full);
    if (!/\.(?:ts|tsx|js|mjs|cjs)$/.test(entry.name)) return [];
    if (/\.test\.[a-z]+$/.test(entry.name)) return [];
    return [full];
  });
}

describe('native device emulation has a single caller', () => {
  it('no production file outside the fence calls enable/disableDeviceEmulation directly', () => {
    // Uma chamada direta nova reabre o SIGSEGV em null+0xf8 do Main. Passe por
    // enableNativeDeviceEmulation/disableNativeDeviceEmulation.
    const fence = path.join(SOURCE_ROOT, 'main/browser/native-device-emulation.ts');
    const offenders = productionSources(SOURCE_ROOT)
      .filter((file) => file !== fence)
      .filter((file) => NATIVE_CALL.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(SOURCE_ROOT, file));
    expect(offenders).toEqual([]);
    expect(NATIVE_CALL.test(fs.readFileSync(fence, 'utf8'))).toBe(true);
  });
});
