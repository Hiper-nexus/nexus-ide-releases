import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { removeUnusedMacPrivacyDescriptions } from './macos-info-plist';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { buildPath: string; plistPath: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nexus-mac-info-'));
  roots.push(root);
  const app = path.join(root, 'NexusIDE.app');
  const plistPath = path.join(app, 'Contents', 'Info.plist');
  mkdirSync(path.dirname(plistPath), { recursive: true });
  mkdirSync(path.join(app, 'Contents', 'Resources', 'app'), { recursive: true });
  writeFileSync(
    plistPath,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>NexusIDE</string>
  <key>NSCameraUsageDescription</key><string>camera</string>
  <key>NSBluetoothAlwaysUsageDescription</key><string>bluetooth</string>
  <key>NSBluetoothPeripheralUsageDescription</key><string>bluetooth peripheral</string>
  <key>NSAudioCaptureUsageDescription</key><string>system audio</string>
  <key>NSMicrophoneUsageDescription</key><string>microphone</string>
  <key>NSScreenCaptureUsageDescription</key><string>screen</string>
</dict></plist>`,
  );
  return { buildPath: path.join(app, 'Contents', 'Resources', 'app'), plistPath };
}

function readPlist(plistPath: string): Record<string, unknown> {
  return JSON.parse(
    execFileSync('plutil', ['-convert', 'json', '-o', '-', plistPath], {
      encoding: 'utf8',
    }),
  ) as Record<string, unknown>;
}

describe('removeUnusedMacPrivacyDescriptions', () => {
  it('removes only unused Electron template privacy declarations', () => {
    const { buildPath, plistPath } = fixture();

    expect(removeUnusedMacPrivacyDescriptions(buildPath, 'darwin')).toEqual([
      'NSCameraUsageDescription',
      'NSBluetoothAlwaysUsageDescription',
      'NSBluetoothPeripheralUsageDescription',
      'NSAudioCaptureUsageDescription',
    ]);

    const info = readPlist(plistPath);
    expect(info).not.toHaveProperty('NSCameraUsageDescription');
    expect(info).not.toHaveProperty('NSBluetoothAlwaysUsageDescription');
    expect(info).not.toHaveProperty('NSBluetoothPeripheralUsageDescription');
    expect(info).not.toHaveProperty('NSAudioCaptureUsageDescription');
    expect(info).toMatchObject({
      NSMicrophoneUsageDescription: 'microphone',
      NSScreenCaptureUsageDescription: 'screen',
    });
  });

  it('does not mutate non-macOS builds', () => {
    const { buildPath, plistPath } = fixture();

    expect(removeUnusedMacPrivacyDescriptions(buildPath, 'linux')).toEqual([]);
    expect(readPlist(plistPath)).toHaveProperty('NSCameraUsageDescription');
  });

  it('accepts Electron templates that omit some or all unused keys', () => {
    const { buildPath } = fixture();

    removeUnusedMacPrivacyDescriptions(buildPath, 'darwin');

    expect(removeUnusedMacPrivacyDescriptions(buildPath, 'darwin')).toEqual([]);
  });
});
