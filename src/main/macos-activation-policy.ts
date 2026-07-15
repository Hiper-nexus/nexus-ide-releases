import { existsSync } from 'node:fs';
import path from 'node:path';
import { app, nativeImage } from 'electron';

const dockReassertTimers: NodeJS.Timeout[] = [];
let dockIconApplied = false;

/**
 * Keep NexusIDE classified as a normal foreground macOS application.
 *
 * This module is imported before the rest of the main-process graph. Keeping
 * the first policy call here matters: importing the large native/runtime graph
 * first can let AppKit launch Electron as an accessory/UIElement process.
 */
export function ensureRegularMacOSActivation(): void {
  if (process.platform !== 'darwin') return;
  try {
    app.setActivationPolicy('regular');
  } catch (error) {
    console.warn('[macos] activation policy unavailable:', error);
  }
}

/**
 * Pin the product icon onto the Dock tile once.
 *
 * After an UIElement → regular thrash, AppKit can leave a zero-height Dock
 * tile (AX size 12x0) that stays listed as "NexusIDE" but is invisible until
 * the Dock process restarts. Re-applying the bundle icon after we are regular
 * forces a real tile to materialize without `killall Dock`.
 */
export function applyMacOSDockIcon(): void {
  if (process.platform !== 'darwin' || dockIconApplied) return;
  if (!app.dock) return;

  const candidates = [
    // electron-packager ships the product icns under this fixed name.
    path.join(process.resourcesPath, 'electron.icns'),
    path.join(process.resourcesPath, 'icon.icns'),
    path.join(process.resourcesPath, 'icon.png'),
    // Dev / unpackaged.
    path.join(app.getAppPath(), 'assets', 'icon.png'),
    path.join(app.getAppPath(), 'assets', 'icon.icns'),
    path.join(process.cwd(), 'assets', 'icon.png'),
    path.join(process.cwd(), 'assets', 'icon.icns'),
  ];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const image = nativeImage.createFromPath(candidate);
      if (image.isEmpty()) continue;
      app.dock.setIcon(image);
      dockIconApplied = true;
      return;
    } catch (error) {
      console.warn('[macos] dock setIcon failed for', candidate, error);
    }
  }
}

/**
 * Restore Dock presence after policy races.
 *
 * Empirically (Electron 43 / macOS):
 * - setVisibleOnAllWorkspaces(true) without skipTransformProcessType flips the
 *   process to UIElement (pet fixes that at the call site).
 * - Repeated dock.show() while the policy is thrashing can leave a ghost tile
 *   with AX size 12×0 — listed in the Dock but invisible. Only call show()
 *   when the Dock item is actually hidden, and always re-apply the icon.
 */
export function reassertMacOSDockPresence(): void {
  if (process.platform !== 'darwin') return;
  ensureRegularMacOSActivation();
  applyMacOSDockIcon();
  try {
    if (!app.dock) return;
    // Avoid show() spam: it re-triggers activation and can re-corrupt the tile.
    if (typeof app.dock.isVisible === 'function' && app.dock.isVisible()) {
      return;
    }
    void app.dock.show()?.catch((error) => {
      console.warn('[macos] Dock item unavailable:', error);
    });
  } catch (error) {
    console.warn('[macos] Dock policy unavailable:', error);
  }
}

/**
 * AppKit can briefly re-apply the launch policy while auxiliary windows or the
 * renderer are created. Reassert during the boot window only; a permanent
 * timer makes AppKit repeatedly recompute the activation state and can make the
 * whole window visibly blink.
 */
export function startMacOSDockWatchdog(): void {
  if (process.platform !== 'darwin' || dockReassertTimers.length > 0) return;

  reassertMacOSDockPresence();
  for (const delayMs of [250, 1_000, 2_500]) {
    dockReassertTimers.push(
      setTimeout(() => {
        reassertMacOSDockPresence();
        if (delayMs === 2_500) dockReassertTimers.length = 0;
      }, delayMs),
    );
  }
}

export function stopMacOSDockWatchdog(): void {
  while (dockReassertTimers.length > 0) {
    const timer = dockReassertTimers.pop();
    if (timer) clearTimeout(timer);
  }
}

// This must be a side-effect import at the entrypoint so the policy is applied
// before the remaining main-process modules are evaluated.
ensureRegularMacOSActivation();
