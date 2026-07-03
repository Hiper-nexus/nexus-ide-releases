import { globalShortcut } from 'electron';
import type { HotkeyMode } from '../../shared/voice-ipc';

/**
 * Global push-to-talk hotkey. Electron's `globalShortcut` fires on keydown only
 * (no keyup), so true hold-to-talk needs `uiohook-napi` for the release edge.
 * That native module is optional: when it is absent (or fails to load) we fall
 * back to TOGGLE mode — each accelerator press flips listening on/off — so the
 * feature degrades gracefully instead of breaking the build.
 *
 * Lifecycle mirrors the app's destroyed-safe listener discipline: everything
 * registered here (the accelerator + any uiohook hook) is torn down in dispose(),
 * which the main process calls on before-quit.
 */

export interface HotkeyCallbacks {
  onStart: () => void;
  onStop: () => void;
}

interface UiohookLike {
  on: (event: 'keyup' | 'keydown', cb: (e: { keycode: number }) => void) => void;
  removeAllListeners: (event?: string) => void;
  start: () => void;
  stop: () => void;
}

interface UiohookModule {
  uIOhook: UiohookLike;
  UiohookKey: Record<string, number>;
}

let registeredAccel: string | null = null;
let uiohook: UiohookLike | null = null;
let mode: HotkeyMode = 'toggle';
let toggleActive = false;

/** Best-effort load of the optional native uiohook module. */
function tryLoadUiohook(): UiohookModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('uiohook-napi') as UiohookModule;
    if (mod && mod.uIOhook && typeof mod.uIOhook.start === 'function') return mod;
    return null;
  } catch {
    return null;
  }
}

/** Map a config key code (e.g. "Space") to a uiohook keycode, if resolvable. */
function resolveUiohookKeycode(mod: UiohookModule, code: string): number | null {
  const key = code === 'Space' ? 'Space' : code;
  const val = mod.UiohookKey[key];
  return typeof val === 'number' ? val : null;
}

export function currentHotkeyMode(): HotkeyMode {
  return mode;
}

/**
 * Register the PTT accelerator. `mainKeyCode` is the bare key (e.g. "Space") used
 * to detect release under uiohook. Returns the resolved HotkeyMode.
 */
export function registerVoiceHotkey(
  accelerator: string,
  mainKeyCode: string,
  callbacks: HotkeyCallbacks,
): HotkeyMode {
  disposeVoiceHotkey();

  const mod = tryLoadUiohook();
  const upKeycode = mod ? resolveUiohookKeycode(mod, mainKeyCode) : null;

  if (mod && upKeycode !== null) {
    mode = 'hold';
    uiohook = mod.uIOhook;
    uiohook.on('keyup', (e) => {
      if (e.keycode === upKeycode) callbacks.onStop();
    });
    try {
      uiohook.start();
    } catch {
      // If the native listener can't start (e.g. no accessibility perm), fall
      // back to toggle so the hotkey still works, just without hold semantics.
      uiohook = null;
      mode = 'toggle';
    }
  } else {
    mode = 'toggle';
  }

  const ok = globalShortcut.register(accelerator, () => {
    if (mode === 'hold') {
      callbacks.onStart();
    } else {
      toggleActive = !toggleActive;
      if (toggleActive) callbacks.onStart();
      else callbacks.onStop();
    }
  });

  if (ok) registeredAccel = accelerator;
  return mode;
}

export function disposeVoiceHotkey(): void {
  if (registeredAccel) {
    try {
      globalShortcut.unregister(registeredAccel);
    } catch {
      // already gone
    }
    registeredAccel = null;
  }
  if (uiohook) {
    try {
      uiohook.removeAllListeners('keyup');
      uiohook.stop();
    } catch {
      // best-effort
    }
    uiohook = null;
  }
  toggleActive = false;
  mode = 'toggle';
}
