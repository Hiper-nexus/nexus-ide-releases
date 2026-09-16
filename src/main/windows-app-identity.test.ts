import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  NEXUS_WINDOWS_APP_USER_MODEL_ID,
  configureWindowsAppIdentity,
  resolveWindowsRuntimeIconPath,
} from './windows-app-identity';

describe('Windows application identity', () => {
  it('uses the same Squirrel AUMID for the process and taskbar group', () => {
    const setAppUserModelId = vi.fn();

    expect(configureWindowsAppIdentity('win32', setAppUserModelId)).toBe(true);
    expect(setAppUserModelId).toHaveBeenCalledExactlyOnceWith(
      NEXUS_WINDOWS_APP_USER_MODEL_ID,
    );
    expect(NEXUS_WINDOWS_APP_USER_MODEL_ID).toBe(
      'com.squirrel.nexus_ide.nexus-ide',
    );
  });

  it('does not touch the taskbar identity on non-Windows platforms', () => {
    const setAppUserModelId = vi.fn();

    expect(configureWindowsAppIdentity('darwin', setAppUserModelId)).toBe(false);
    expect(setAppUserModelId).not.toHaveBeenCalled();
  });

  it('uses the explicitly packaged ICO at runtime on Windows', () => {
    expect(
      resolveWindowsRuntimeIconPath(
        {
          platform: 'win32',
          isPackaged: true,
          resourcesPath: 'C:\\NexusIDE\\resources',
          appPath: 'C:\\NexusIDE\\resources\\app.asar',
        },
        () => true,
      ),
    ).toBe(path.join('C:\\NexusIDE\\resources', 'icon.ico'));
  });

  it('falls back to the development asset only when it exists', () => {
    const options = {
      platform: 'win32' as const,
      isPackaged: false,
      resourcesPath: 'C:\\NexusIDE\\resources',
      appPath: 'C:\\source\\nexus-ide',
    };

    expect(resolveWindowsRuntimeIconPath(options, () => false)).toBeUndefined();
    expect(resolveWindowsRuntimeIconPath(options, () => true)).toBe(
      path.join('C:\\source\\nexus-ide', 'assets', 'icon.ico'),
    );
  });
});
