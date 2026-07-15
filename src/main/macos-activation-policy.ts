import { app } from 'electron';

const dockReassertTimers: NodeJS.Timeout[] = [];

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
 * AppKit can briefly re-apply the launch policy while auxiliary windows or the
 * renderer are created. Reassert during the boot window only; a permanent
 * timer makes AppKit repeatedly recompute the activation state and can make the
 * whole window visibly blink.
 */
export function startMacOSDockWatchdog(): void {
  if (process.platform !== 'darwin' || dockReassertTimers.length > 0) return;

  const reassert = (): void => {
    ensureRegularMacOSActivation();
    try {
      void app.dock?.show()?.catch((error) => {
        console.warn('[macos] Dock item unavailable:', error);
      });
    } catch (error) {
      console.warn('[macos] Dock policy unavailable:', error);
    }
  };

  reassert();
  for (const delayMs of [250, 1_000, 2_500]) {
    dockReassertTimers.push(
      setTimeout(() => {
        reassert();
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
