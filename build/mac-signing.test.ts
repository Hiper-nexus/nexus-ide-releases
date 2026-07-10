import { describe, expect, it } from 'vitest';

import {
  createMacSignOptions,
  entitlementProfileForMacTarget,
  EXPECTED_DEVELOPER_ID_IDENTITY,
  isAppleReleaseSigning,
} from './mac-signing';

describe('macOS signing modes', () => {
  it('keeps local ad-hoc packages runnable without enabling library validation', () => {
    expect(isAppleReleaseSigning(undefined)).toBe(false);
    const options = createMacSignOptions(undefined);

    expect(options.continueOnError).toBe(false);
    expect(options.identity).toBe('-');
    expect(options.optionsForFile('/tmp/NexusIDE')).toMatchObject({
      hardenedRuntime: false,
      timestamp: 'none',
    });
    expect(options.identityValidation).toBe(false);
  });

  it('uses hardened runtime for Developer ID release signing', () => {
    expect(isAppleReleaseSigning('35P5XL3JN6')).toBe(true);
    const options = createMacSignOptions('35P5XL3JN6');

    expect(options.identity).toBe(
      `${EXPECTED_DEVELOPER_ID_IDENTITY} (35P5XL3JN6)`,
    );
    expect(options.optionsForFile('/tmp/NexusIDE')).toMatchObject({
      hardenedRuntime: true,
    });
    expect(options.optionsForFile('/tmp/NexusIDE').timestamp).toBeUndefined();
    expect(options.identityValidation).toBeUndefined();
  });

  it.each([
    ['/tmp/NexusIDE.app', 'build/entitlements.mac.plist'],
    ['/tmp/NexusIDE.app/Contents/MacOS/NexusIDE', 'build/entitlements.mac.plist'],
    [
      '/tmp/NexusIDE.app/Contents/Frameworks/NexusIDE Helper.app',
      'build/entitlements.mac.helper.plist',
    ],
    [
      '/tmp/NexusIDE.app/Contents/Frameworks/NexusIDE Helper (Renderer).app/Contents/MacOS/NexusIDE Helper (Renderer)',
      'build/entitlements.mac.renderer.plist',
    ],
    [
      '/tmp/NexusIDE.app/Contents/Frameworks/NexusIDE Helper (GPU).app',
      'build/entitlements.mac.helper.plist',
    ],
    [
      '/tmp/NexusIDE.app/Contents/Frameworks/NexusIDE Helper (Plugin).app',
      'build/entitlements.mac.plugin.plist',
    ],
    [
      '/tmp/NexusIDE.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework',
      'build/entitlements.mac.none.plist',
    ],
    [
      '/tmp/NexusIDE.app/Contents/Resources/app.asar.unpacked/native.node',
      'build/entitlements.mac.none.plist',
    ],
  ])('assigns least-privilege entitlements to %s', (filePath, entitlementPath) => {
    expect(entitlementProfileForMacTarget(filePath)).toBe(entitlementPath);
    expect(
      createMacSignOptions('35P5XL3JN6').optionsForFile(filePath).entitlements,
    ).toBe(entitlementPath);
  });

  it('grants microphone capture only to the renderer helper that owns getUserMedia', () => {
    const renderer = createMacSignOptions('35P5XL3JN6').optionsForFile(
      '/tmp/NexusIDE.app/Contents/Frameworks/NexusIDE Helper (Renderer).app',
    );
    const gpu = createMacSignOptions('35P5XL3JN6').optionsForFile(
      '/tmp/NexusIDE.app/Contents/Frameworks/NexusIDE Helper (GPU).app',
    );

    expect(renderer.entitlements).toBe('build/entitlements.mac.renderer.plist');
    expect(gpu.entitlements).toBe('build/entitlements.mac.helper.plist');
  });
});
