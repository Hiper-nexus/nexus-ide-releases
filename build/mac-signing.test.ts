import {
  existsSync,
  readFileSync,
} from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  APPLE_TIMESTAMP_AUTHORITY_URL,
  createMacSignOptions,
  DARWIN_PTY_SUPERVISOR_IDENTIFIER,
  NEXUS_REDLINE_IDENTIFIER,
  entitlementProfileForMacTarget,
  EXPECTED_DEVELOPER_ID_IDENTITY,
  assertMacPublishReleaseEnvironment,
  isAppleReleaseSigning,
  macTimestampAuthority,
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
      NEXUS_MAC_PUBLISH_RELEASE: '1',
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

    const signDmg = vi.fn(async () => undefined);
    await expect(
      notarizeMacDmgArtifacts(makeResults, environment, notarizeArtifact, signDmg),
    ).resolves.toBe(makeResults);
    expect(notarizeArtifact).toHaveBeenCalledWith({
      appPath: '/tmp/NexusIDE.dmg',
      keychainProfile: 'nexus-notary',
    });
    expect(signDmg).not.toHaveBeenCalled();
  });

  it('com autoridade de carimbo alternativa, assina o DMG antes de notarizar (F-652)', async () => {
    const environment = {
      APPLE_TEAM_ID: '35P5XL3JN6',
      APPLE_KEYCHAIN_PROFILE: 'nexus-notary',
      NEXUS_MAC_PUBLISH_RELEASE: '1',
      NEXUS_MAC_TIMESTAMP_URL: 'http://17.32.213.161/ts01',
    };
    // O codesign do appdmg não aceita URL de carimbo; nesse modo ele não assina.
    expect(createMacDmgMakerConfig(environment)).not.toHaveProperty(
      'additionalDMGOptions',
    );
    const order: string[] = [];
    const signDmg = vi.fn(async () => {
      order.push('sign');
    });
    const notarizeArtifact = vi.fn(async () => {
      order.push('notarize');
    });
    const makeResults = [{
      artifacts: ['/tmp/NexusIDE.dmg', '/tmp/NexusIDE.zip'],
      packageJSON: {},
      platform: 'darwin' as const,
      arch: 'arm64' as const,
    }];

    await notarizeMacDmgArtifacts(makeResults, environment, notarizeArtifact, signDmg);

    expect(signDmg).toHaveBeenCalledWith({
      path: '/tmp/NexusIDE.dmg',
      identity: `${EXPECTED_DEVELOPER_ID_IDENTITY} (35P5XL3JN6)`,
      identifier: 'com.nexuside.app',
      timestamp: 'http://17.32.213.161/ts01',
    });
    expect(order).toEqual(['sign', 'notarize']);
  });

  it('makes the publish release mode impossible without the exact local identity contract', () => {
    expect(() => assertMacPublishReleaseEnvironment({})).toThrow(
      /NEXUS_MAC_PUBLISH_RELEASE/,
    );
    expect(() => assertMacPublishReleaseEnvironment({
      NEXUS_MAC_PUBLISH_RELEASE: '1',
      APPLE_TEAM_ID: '35P5XL3JN6',
      APPLE_KEYCHAIN_PROFILE: 'nexus_notary',
    })).toThrow(/nexus-notary/);
    expect(() => assertMacPublishReleaseEnvironment({
      NEXUS_MAC_PUBLISH_RELEASE: '1',
      APPLE_TEAM_ID: '35P5XL3JN6',
      APPLE_KEYCHAIN_PROFILE: 'nexus-notary',
      APPLE_ID: 'must-not-be-in-env',
    })).toThrow(/APPLE_ID/);
    expect(assertMacPublishReleaseEnvironment({
      NEXUS_MAC_PUBLISH_RELEASE: '1',
      APPLE_TEAM_ID: '35P5XL3JN6',
      APPLE_KEYCHAIN_PROFILE: 'nexus-notary',
    })).toEqual({
      teamId: '35P5XL3JN6',
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
    expect(options.optionsForFile('/tmp/NexusIDE').timestamp).toBe(
      APPLE_TIMESTAMP_AUTHORITY_URL,
    );
    expect(options.identityValidation).toBeUndefined();
  });

  it('troca a autoridade de carimbo só por URL (rota IPv6 quebrada, 26/09)', () => {
    expect(macTimestampAuthority({})).toBe(APPLE_TIMESTAMP_AUTHORITY_URL);
    expect(
      macTimestampAuthority({ NEXUS_MAC_TIMESTAMP_URL: ' http://17.32.213.161/ts01 ' }),
    ).toBe('http://17.32.213.161/ts01');
    // Desligar o carimbo quebraria a notarização: não é uma troca aceita.
    expect(macTimestampAuthority({ NEXUS_MAC_TIMESTAMP_URL: 'none' })).toBe(
      APPLE_TIMESTAMP_AUTHORITY_URL,
    );
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
      shouldIgnoreMacSigningFile(
        '/tmp/NexusIDE.app/Contents/Resources/nexus-pty-supervisor',
      ),
    ).toBe(false);
    expect(
      shouldIgnoreMacSigningFile(
        '/tmp/NexusIDE.app/Contents/Resources/nexus-redline/Nexus Redline.app',
      ),
    ).toBe(false);
    expect(
      shouldIgnoreMacSigningFile(
        '/tmp/NexusIDE.app/Contents/Resources/nexus-redline/Nexus Redline.app/Contents/MacOS/NexusRedline',
      ),
    ).toBe(false);
    expect(
      shouldIgnoreMacSigningFile(
        '/tmp/NexusIDE.app/Contents/Resources/nexus-redline/Nexus Redline.app/Contents/Resources/AppIcon.icns',
      ),
    ).toBe(true);
    expect(
      shouldIgnoreMacSigningFile(
        '/tmp/NexusIDE.app/Contents/Resources/nexus-redline/Nexus Redline.app/Contents/Info.plist',
      ),
    ).toBe(true);
    expect(
      createMacSignOptions('35P5XL3JN6').ignore(
        '/tmp/NexusIDE.app/Contents/Resources/wake/custom.onnx',
      ),
    ).toBe(true);
  });

  it.each([
    [undefined, false],
    ['35P5XL3JN6', true],
  ])(
    'preserves the exact PTY supervisor identifier in %s signing mode',
    (teamId, hardenedRuntime) => {
      const options = createMacSignOptions(teamId);
      const helper =
        '/tmp/NexusIDE.app/Contents/Resources/nexus-pty-supervisor';

      expect(options.optionsForFile(helper)).toMatchObject({
        additionalArguments: [
          '--identifier',
          DARWIN_PTY_SUPERVISOR_IDENTIFIER,
        ],
        hardenedRuntime,
      });
      expect(
        options.optionsForFile(helper.replaceAll('/', '\\')),
      ).toMatchObject({
        additionalArguments: [
          '--identifier',
          DARWIN_PTY_SUPERVISOR_IDENTIFIER,
        ],
      });
      for (const otherTarget of [
        '/tmp/NexusIDE.app/Contents/Resources/nexus-pty-supervisor-copy',
        '/tmp/NexusIDE.app/Contents/Resources/bin/nexus-pty-supervisor',
        '/tmp/NexusIDE.app/Contents/MacOS/nexus-pty-supervisor',
        '/tmp/nexus-pty-supervisor',
      ]) {
        expect(
          options.optionsForFile(otherTarget).additionalArguments,
        ).toBeUndefined();
      }
    },
  );

  it.each([
    [undefined, false],
    ['35P5XL3JN6', true],
  ])(
    're-signs the nested Redline companion with a fixed identifier in %s signing mode',
    (teamId, hardenedRuntime) => {
      const options = createMacSignOptions(teamId);
      const companion =
        '/tmp/NexusIDE.app/Contents/Resources/nexus-redline/Nexus Redline.app/Contents/MacOS/NexusRedline';
      const bundle =
        '/tmp/NexusIDE.app/Contents/Resources/nexus-redline/Nexus Redline.app';

      expect(options.optionsForFile(companion)).toMatchObject({
        additionalArguments: ['--identifier', NEXUS_REDLINE_IDENTIFIER],
        entitlements: 'build/entitlements.mac.none.plist',
        hardenedRuntime,
      });
      expect(options.optionsForFile(bundle)).toMatchObject({
        additionalArguments: ['--identifier', NEXUS_REDLINE_IDENTIFIER],
        entitlements: 'build/entitlements.mac.none.plist',
        hardenedRuntime,
      });
    },
  );

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
      '/tmp/NexusIDE.app/Contents/Resources/nexus-pty-supervisor',
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

  it('fails closed when the retired eSigner switch is set', () => {
    expect(() => createWindowsSignOptions({
      NEXUS_WINDOWS_RELEASE_SIGNING: 'yes',
    })).toThrow(/NEXUS_WINDOWS_RELEASE_SIGNING was retired/);
    expect(() => createWindowsSignOptions({
      NEXUS_WINDOWS_RELEASE_SIGNING: '1',
    })).toThrow(/NEXUS_WINDOWS_RELEASE_SIGNING was retired/);
    expect(() => createWindowsSignOptions({
      NEXUS_WINDOWS_RELEASE_SIGNING: '1',
      WINDOWS_CERTIFICATE_FILE: 'C:\\release.pfx',
      WINDOWS_CERTIFICATE_PASSWORD: 'secret',
    })).toThrow(/NEXUS_WINDOWS_RELEASE_SIGNING was retired/);
  });

  it('does not sign from a PFX path left in the environment', () => {
    expect(createWindowsSignOptions({
      WINDOWS_CERTIFICATE_FILE: ' C:\\release.pfx ',
      WINDOWS_CERTIFICATE_PASSWORD: 'secret with spaces',
    })).toBeUndefined();
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
    expect(shouldPackageFile('\\.vite\\build\\main.js')).toBe(true);
    expect(shouldPackageFile('C:\\work\\nexus\\.vite\\build\\main.js')).toBe(true);
    expect(shouldPackageFile('\\node_modules\\better-sqlite3\\build\\Release\\better_sqlite3.node')).toBe(true);
    expect(shouldPackageFile('C:\\work\\nexus\\node_modules\\onnxruntime-node\\bin\\napi-v3\\win32\\x64\\onnxruntime.dll')).toBe(true);
    // Renderer chunks already contain these. typescript stays: Main runs tsc.
    expect(shouldPackageFile('/node_modules/mermaid/dist/mermaid.js')).toBe(false);
    expect(shouldPackageFile('/node_modules/@mermaid-js/parser/dist/index.js')).toBe(false);
    expect(shouldPackageFile('/node_modules/@shikijs/langs/dist/index.mjs')).toBe(false);
    expect(shouldPackageFile('/node_modules/shiki/dist/index.mjs')).toBe(false);
    expect(shouldPackageFile('/node_modules/katex/dist/katex.js')).toBe(false);
    expect(shouldPackageFile('/node_modules/cytoscape/dist/cytoscape.cjs')).toBe(false);
    expect(shouldPackageFile('/node_modules/cytoscape-fcose/index.js')).toBe(false);
    expect(shouldPackageFile('/node_modules/foo/node_modules/katex/dist/katex.js')).toBe(false);
    expect(shouldPackageFile('/node_modules/typescript/lib/typescript.js')).toBe(true);
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

  it('attributes the T3 Code harvest and Ghostty libghostty-vt in the packaged notice', () => {
    const notice = readFileSync(
      path.resolve('THIRD_PARTY_NOTICES.md'),
      'utf8',
    );
    expect(notice).toContain('pingdotgg/t3code');
    expect(notice).toContain('Copyright (c) 2026 T3 Tools Inc.');
    expect(notice).toContain('third_party/licenses/t3code-MIT.txt');
    expect(notice).toContain('Mitchell Hashimoto, Ghostty contributors');
    expect(shouldPackageFile('/third_party/licenses/t3code-MIT.txt')).toBe(true);
    expect(
      existsSync(path.resolve('third_party/licenses/t3code-MIT.txt')),
    ).toBe(true);
    expect(existsSync(path.resolve('resources/ghostty/LICENSE'))).toBe(true);
  });
});

describe('createMacNotarizeCredentials — ambiente de dev não é release', () => {
  it('APPLE_TEAM_ID no perfil do shell não quebra o dev', () => {
    // Regressão: com APPLE_TEAM_ID exportado no ~/.zshrc, `npm start` e três
    // suítes morriam em "NEXUS_MAC_PUBLISH_RELEASE must be exactly 1".
    expect(
      createMacNotarizeCredentials({
        APPLE_TEAM_ID: '35P5XL3JN6',
        APPLE_KEYCHAIN_PROFILE: 'nexus-notary',
      }),
    ).toBeUndefined();
  });

  it('mas opt-in de release COM valor errado continua explodindo', () => {
    expect(() =>
      createMacNotarizeCredentials({
        APPLE_TEAM_ID: '35P5XL3JN6',
        APPLE_KEYCHAIN_PROFILE: 'nexus-notary',
        NEXUS_MAC_PUBLISH_RELEASE: '0',
      }),
    ).toThrow('NEXUS_MAC_PUBLISH_RELEASE must be exactly "1"');
  });

  it('release bem configurado segue devolvendo o profile', () => {
    expect(
      createMacNotarizeCredentials({
        APPLE_TEAM_ID: '35P5XL3JN6',
        APPLE_KEYCHAIN_PROFILE: 'nexus-notary',
        NEXUS_MAC_PUBLISH_RELEASE: '1',
      }),
    ).toEqual({ keychainProfile: 'nexus-notary' });
  });
});
