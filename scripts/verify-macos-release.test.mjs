import { describe, expect, it } from 'vitest';

import {
  assertPackagedSmokeOutput,
  assertMatchingReleaseArchitectures,
  assertReleaseArtifacts,
  assertSignatureMetadata,
  buildFusesReadInvocation,
  expectedEntitlementKeysForPath,
  parseCodesignMetadata,
  parseLipoArchitectures,
} from './verify-macos-release.mjs';

describe('macOS release artifact contract', () => {
  it('requires exactly one DMG and one ZIP because Squirrel uses the ZIP', () => {
    expect(() => assertReleaseArtifacts(['/tmp/NexusIDE.dmg'])).toThrow(/ZIP/i);
    expect(() => assertReleaseArtifacts([
      '/tmp/NexusIDE.dmg',
      '/tmp/NexusIDE.zip',
      '/tmp/NexusIDE-copy.zip',
    ])).toThrow(/exactly one ZIP/i);

    expect(assertReleaseArtifacts([
      '/tmp/NexusIDE.dmg',
      '/tmp/NexusIDE.zip',
    ])).toEqual({
      dmg: '/tmp/NexusIDE.dmg',
      zip: '/tmp/NexusIDE.zip',
    });
  });

  it('requires the expected Developer ID leaf and exact Apple Team ID', () => {
    const metadata = parseCodesignMetadata([
      'Authority=Developer ID Application: Cleofas Pereira rocha (35P5XL3JN6)',
      'Authority=Developer ID Certification Authority',
      'Timestamp=23 Jul 2026 at 08:49:41',
      'TeamIdentifier=35P5XL3JN6',
    ].join('\n'));

    expect(() => assertSignatureMetadata(
      metadata,
      'OTHERTEAM1',
      'Developer ID Application: Cleofas Pereira rocha',
    )).toThrow(/TeamIdentifier/);
    expect(() => assertSignatureMetadata(
      metadata,
      '35P5XL3JN6',
      'Developer ID Application: Mallory',
    )).toThrow(/Authority/);
    expect(() => assertSignatureMetadata(
      metadata,
      '35P5XL3JN6',
      'Developer ID Application: Cleofas Pereira rocha',
    )).not.toThrow();
  });

  it('requires a secure Timestamp and rejects Signed Time as a substitute', () => {
    const signatureLines = [
      'Authority=Developer ID Application: Cleofas Pereira rocha (35P5XL3JN6)',
      'Authority=Developer ID Certification Authority',
      'TeamIdentifier=35P5XL3JN6',
    ];
    const secure = parseCodesignMetadata([
      ...signatureLines,
      'Timestamp=23 Jul 2026 at 08:49:41',
    ].join('\n'));
    const localOnly = parseCodesignMetadata([
      ...signatureLines,
      'Signed Time=23 Jul 2026 at 08:49:41',
    ].join('\n'));
    const missing = parseCodesignMetadata(signatureLines.join('\n'));

    expect(secure).toMatchObject({
      secureTimestamp: '23 Jul 2026 at 08:49:41',
      signedTime: '',
    });
    expect(localOnly).toMatchObject({
      secureTimestamp: '',
      signedTime: '23 Jul 2026 at 08:49:41',
    });
    expect(() => assertSignatureMetadata(
      secure,
      '35P5XL3JN6',
      'Developer ID Application: Cleofas Pereira rocha',
    )).not.toThrow();
    expect(() => assertSignatureMetadata(
      localOnly,
      '35P5XL3JN6',
      'Developer ID Application: Cleofas Pereira rocha',
    )).toThrow(/secure Timestamp.*Signed Time/);
    expect(() => assertSignatureMetadata(
      missing,
      '35P5XL3JN6',
      'Developer ID Application: Cleofas Pereira rocha',
    )).toThrow(/secure Timestamp/);
  });

  it('maps Mach-O classes to the least-privilege entitlement allowlist', () => {
    const app = '/tmp/NexusIDE.app';
    expect(expectedEntitlementKeysForPath(
      `${app}/Contents/MacOS/nexus-ide`,
      app,
    )).toEqual([
      'com.apple.security.cs.allow-jit',
      'com.apple.security.device.audio-input',
    ]);
    expect(expectedEntitlementKeysForPath(
      `${app}/Contents/Frameworks/NexusIDE Helper (Renderer).app/Contents/MacOS/NexusIDE Helper (Renderer)`,
      app,
    )).toEqual([
      'com.apple.security.cs.allow-jit',
      'com.apple.security.device.audio-input',
    ]);
    expect(expectedEntitlementKeysForPath(
      `${app}/Contents/Frameworks/NexusIDE Helper (Plugin).app/Contents/MacOS/NexusIDE Helper (Plugin)`,
      app,
    )).toEqual(['com.apple.security.cs.allow-unsigned-executable-memory']);
    expect(expectedEntitlementKeysForPath(
      `${app}/Contents/Resources/app.asar.unpacked/native.node`,
      app,
    )).toEqual([]);
    expect(expectedEntitlementKeysForPath(
      `${app}/Contents/Frameworks/NexusIDE Helper (Renderer).app/Contents/Frameworks/libinternal.dylib`,
      app,
    )).toEqual([]);
  });

  it('requires both renderer and functional readiness proof from the real app', () => {
    expect(() => assertPackagedSmokeOutput('[smoke] renderer-mounted\n')).toThrow(
      /functional-ready/,
    );
    expect(() => assertPackagedSmokeOutput('[smoke] functional-ready\n')).toThrow(
      /renderer-mounted/,
    );
    expect(() => assertPackagedSmokeOutput([
      '[smoke] renderer-mounted',
      '[smoke] functional-ready',
    ].join('\n'))).not.toThrow();
  });

  it('reads Electron fuses with the locked local CLI and current Node', () => {
    const invocation = buildFusesReadInvocation(
      '/tmp/NexusIDE.app',
      '/repo',
    );
    expect(invocation.command).toBe(process.execPath);
    expect(invocation.args).toEqual([
      '/repo/node_modules/@electron/fuses/dist/bin.js',
      'read',
      '--app',
      '/tmp/NexusIDE.app',
    ]);
    expect(invocation.args).not.toContain('npx');
  });

  it('accepts one host architecture and rejects incoherent DMG/ZIP apps', () => {
    expect(parseLipoArchitectures('arm64\n')).toEqual(['arm64']);
    expect(parseLipoArchitectures('x86_64 arm64\n')).toEqual([
      'arm64',
      'x86_64',
    ]);
    expect(() =>
      assertMatchingReleaseArchitectures(['arm64'], ['arm64'], 'arm64'),
    ).not.toThrow();
    expect(() =>
      assertMatchingReleaseArchitectures(['arm64'], ['x86_64'], 'arm64'),
    ).toThrow(/DMG.*ZIP.*architecture/i);
    expect(() =>
      assertMatchingReleaseArchitectures(
        ['arm64', 'x86_64'],
        ['arm64', 'x86_64'],
        'arm64',
      ),
    ).toThrow(/single-architecture/i);
  });
});
