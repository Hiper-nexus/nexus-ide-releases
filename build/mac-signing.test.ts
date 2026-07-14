import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  createMacSignOptions,
  entitlementProfileForMacTarget,
  EXPECTED_DEVELOPER_ID_IDENTITY,
  isAppleReleaseSigning,
  shouldIgnoreMacSigningFile,
} from './mac-signing';
import {
  createMacDmgMakerConfig,
  createMacNotarizeCredentials,
  createWindowsSignOptions,
  notarizeMacDmgArtifacts,
  shouldPackageFile,
} from '../forge.config';

describe('macOS signing modes', () => {
  it('signs and notarizes the distributed DMG in release mode', async () => {
    const environment = {
      APPLE_TEAM_ID: '35P5XL3JN6',
      APPLE_KEYCHAIN_PROFILE: 'nexus-notary',
    };
    expect(createMacDmgMakerConfig(environment)).toMatchObject({
      additionalDMGOptions: {
        'code-sign': {
          'signing-identity': `${EXPECTED_DEVELOPER_ID_IDENTITY} (35P5XL3JN6)`,
          identifier: 'com.nexuside.app',
        },
      },
    });
    expect(createMacNotarizeCredentials(environment)).toEqual({
      keychainProfile: 'nexus-notary',
    });
    const notarizeArtifact = vi.fn(async () => undefined);
    const makeResults = [{
      artifacts: ['/tmp/NexusIDE.dmg', '/tmp/NexusIDE.zip'],
      packageJSON: {},
      platform: 'darwin' as const,
      arch: 'arm64' as const,
    }];

    await expect(
      notarizeMacDmgArtifacts(makeResults, environment, notarizeArtifact),
    ).resolves.toBe(makeResults);
    expect(notarizeArtifact).toHaveBeenCalledWith({
      appPath: '/tmp/NexusIDE.dmg',
      keychainProfile: 'nexus-notary',
    });
  });

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

  it('does not send packaged data resources through codesign', () => {
    expect(
      shouldIgnoreMacSigningFile(
        '/tmp/NexusIDE.app/Contents/Resources/pets/sheets/nexo.webp',
      ),
    ).toBe(true);
    expect(
      shouldIgnoreMacSigningFile(
        '/tmp/NexusIDE.app/Contents/Frameworks/Electron Framework.framework/Resources/en.lproj/locale.pak',
      ),
    ).toBe(true);
    expect(
      shouldIgnoreMacSigningFile(
        '/tmp/NexusIDE.app/Contents/Resources/app.asar.unpacked/native.node',
      ),
    ).toBe(false);
    expect(
      createMacSignOptions('35P5XL3JN6').ignore(
        '/tmp/NexusIDE.app/Contents/Resources/wake/custom.onnx',
      ),
    ).toBe(true);
  });

  it('rejects malformed non-empty Team IDs instead of downgrading the build', () => {
    expect(isAppleReleaseSigning('not-a-team')).toBe(false);
    expect(() => createMacSignOptions('not-a-team')).toThrow(/Team ID/i);
    expect(() => createMacSignOptions('          ')).toThrow(/Team ID/i);
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
    [
      '/tmp/NexusIDE.app/Contents/Frameworks/NexusIDE Helper (Renderer).app/Contents/Frameworks/libinternal.dylib',
      'build/entitlements.mac.none.plist',
    ],
    [
      '/tmp/NexusIDE.app/Contents/Frameworks/NexusIDE Helper.app/Contents/Resources/native.node',
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

describe('Windows release signing mode', () => {
  it('keeps local Windows packages unsigned only outside release mode', () => {
    expect(createWindowsSignOptions({})).toBeUndefined();
  });

  it('fails closed when release signing configuration is incomplete', () => {
    expect(() => createWindowsSignOptions({
      NEXUS_WINDOWS_RELEASE_SIGNING: 'yes',
    })).toThrow(/NEXUS_WINDOWS_RELEASE_SIGNING/);
    expect(() => createWindowsSignOptions({
      NEXUS_WINDOWS_RELEASE_SIGNING: '1',
    })).toThrow(/WINDOWS_CERTIFICATE_FILE/);
    expect(() => createWindowsSignOptions({
      NEXUS_WINDOWS_RELEASE_SIGNING: '1',
      WINDOWS_CERTIFICATE_FILE: 'C:\\release.pfx',
    })).toThrow(/WINDOWS_CERTIFICATE_PASSWORD/);
  });

  it('uses one SHA-256 PFX signing policy for app payload and Squirrel', () => {
    expect(createWindowsSignOptions({
      NEXUS_WINDOWS_RELEASE_SIGNING: '1',
      WINDOWS_CERTIFICATE_FILE: ' C:\\release.pfx ',
      WINDOWS_CERTIFICATE_PASSWORD: 'secret with spaces',
    })).toEqual({
      certificateFile: 'C:\\release.pfx',
      certificatePassword: 'secret with spaces',
      continueOnError: false,
      hashes: ['sha256'],
      timestampServer: 'http://timestamp.digicert.com',
    });
  });
});

describe('packaged legal notices', () => {
  it('ships license and third-party notices without broadening app contents', () => {
    expect(shouldPackageFile('/LICENSE')).toBe(true);
    expect(shouldPackageFile('/THIRD_PARTY_NOTICES.md')).toBe(true);
    expect(shouldPackageFile('/third_party')).toBe(true);
    expect(shouldPackageFile('/third_party/licenses')).toBe(true);
    expect(shouldPackageFile('/third_party/licenses/Apache-2.0.txt')).toBe(true);
    expect(shouldPackageFile('/third_party/licenses/OFL-1.1.txt')).toBe(true);
    // Orca MIT attribution must ship in closed-source packages.
    expect(shouldPackageFile('/third_party/licenses/orca-MIT.txt')).toBe(true);
    expect(shouldPackageFile('/src/main/main.ts')).toBe(false);
    // Provenance ledger is for engineers; not required in the app bundle.
    expect(shouldPackageFile('/third_party/provenance/orca-143c36e.json')).toBe(
      false,
    );
  });

  it('attributes the vendored Onlook translator in the packaged notice', () => {
    const notice = readFileSync(
      path.resolve('THIRD_PARTY_NOTICES.md'),
      'utf8',
    );
    expect(notice).toContain('Onlook CSS-to-Tailwind translator');
    expect(notice).toContain('onlook-dev/onlook');
    expect(notice).toContain('Apache License 2.0');
    expect(notice).toContain('hymhub/css-to-tailwind');
  });

  it('attributes Orca MIT harvest in the packaged notice', () => {
    const notice = readFileSync(
      path.resolve('THIRD_PARTY_NOTICES.md'),
      'utf8',
    );
    expect(notice).toContain('stablyai/orca');
    expect(notice).toContain('third_party/licenses/orca-MIT.txt');
    expect(
      existsSync(path.resolve('third_party/licenses/orca-MIT.txt')),
    ).toBe(true);
  });
});
