import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const UNUSED_PRIVACY_KEYS = [
  'NSCameraUsageDescription',
  'NSBluetoothAlwaysUsageDescription',
  'NSBluetoothPeripheralUsageDescription',
  'NSAudioCaptureUsageDescription',
] as const;

function findMacInfoPlist(buildPath: string): string | null {
  let cursor = path.resolve(buildPath);
  while (true) {
    const candidate = path.join(cursor, 'Contents', 'Info.plist');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

function hasPlistKey(plistPath: string, key: string): boolean {
  try {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plistPath], {
      stdio: 'pipe',
    });
    return true;
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? '');
    if (stderr.includes('Does Not Exist')) return false;
    throw new Error(`Não foi possível inspecionar ${key} em ${plistPath}.`, { cause: error });
  }
}

/**
 * Electron's macOS template declares several privacy capabilities Nexus does
 * not request. Remove only those template keys before the package is signed;
 * microphone and screen-recording copy remain product requirements.
 */
export function removeUnusedMacPrivacyDescriptions(
  buildPath: string,
  platform: string,
): string[] {
  if (platform !== 'darwin') return [];
  const plistPath = findMacInfoPlist(buildPath);
  if (!plistPath) return [];

  const removed: string[] = [];
  for (const key of UNUSED_PRIVACY_KEYS) {
    if (!hasPlistKey(plistPath, key)) continue;
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Delete :${key}`, plistPath], {
      stdio: 'ignore',
    });
    removed.push(key);
  }
  return removed;
}
