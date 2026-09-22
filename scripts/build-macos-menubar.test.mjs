import { describe, expect, it } from 'vitest';

import {
  REDLINE_MINIMUM_SYSTEM_VERSION,
  REDLINE_SWIFT_TARGET,
  assertRedlineDeploymentTarget,
  redlineSwiftcArgs,
} from './build-macos-menubar.mjs';

describe('Redline deployment target', () => {
  it('pins swiftc to the same macOS floor as LSMinimumSystemVersion', () => {
    expect(REDLINE_MINIMUM_SYSTEM_VERSION).toBe('14.0');
    expect(REDLINE_SWIFT_TARGET).toBe('arm64-apple-macosx14.0');
    expect(redlineSwiftcArgs('/tmp/NexusRedline', ['main.swift', 'quota-panel.swift'])).toEqual([
      '-O',
      '-swift-version',
      '5',
      '-target',
      'arm64-apple-macosx14.0',
      '-o',
      '/tmp/NexusRedline',
      'main.swift',
      'quota-panel.swift',
    ]);
  });

  it('rejects a Mach-O minos above the running floor', () => {
    expect(() => assertRedlineDeploymentTarget('/unused', '    minos 27.2\n      sdk 27.0\n')).toThrow(
      /minos 27\.2 != 14\.0/,
    );
    expect(() => assertRedlineDeploymentTarget('/unused', '    minos 14.0\n      sdk 27.0\n')).not.toThrow();
  });
});
