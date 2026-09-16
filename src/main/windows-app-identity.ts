import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Squirrel.Windows assigns this ID to the installed launcher. Reasserting the
 * exact same ID in Electron makes taskbar grouping and the window icon resolve
 * through one identity instead of relying on a stale pinned-shortcut cache.
 */
export const NEXUS_WINDOWS_APP_USER_MODEL_ID =
  'com.squirrel.nexus_ide.nexus-ide';

export function configureWindowsAppIdentity(
  platform: NodeJS.Platform,
  setAppUserModelId: (id: string) => void,
): boolean {
  if (platform !== 'win32') return false;
  setAppUserModelId(NEXUS_WINDOWS_APP_USER_MODEL_ID);
  return true;
}

export type WindowsRuntimeIconContext = {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly appPath: string;
};

/**
 * The executable embeds the ICO, but Windows can render a generic document
 * while a pinned Squirrel shortcut is being refreshed. Supplying the same ICO
 * to BrowserWindow gives the native window/taskbar a deterministic source.
 */
export function resolveWindowsRuntimeIconPath(
  context: WindowsRuntimeIconContext,
  fileExists: (candidate: string) => boolean = existsSync,
): string | undefined {
  if (context.platform !== 'win32') return undefined;
  const candidate = context.isPackaged
    ? path.join(context.resourcesPath, 'icon.ico')
    : path.join(context.appPath, 'assets', 'icon.ico');
  return fileExists(candidate) ? candidate : undefined;
}
