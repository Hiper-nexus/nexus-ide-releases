import { describe, expect, it } from 'vitest';

import {
  assertReleaseArtifacts,
  assertSignatureMetadata,
  expectedEntitlementKeysForPath,
  parseCodesignMetadata,
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

  it('maps Mach-O classes to the least-privilege entitlement allowlist', () => {
    const app = '/tmp/NexusIDE.app';
    expect(expectedEntitlementKeysForPath(
      `${app}/Contents/MacOS/NexusIDE`,
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
  });
});
