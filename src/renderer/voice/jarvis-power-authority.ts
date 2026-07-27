/**
 * Renderer-owned power authority for Jarvis.
 *
 * "Power off" is stronger than stopping output: no acoustic wake or capture
 * may reopen until an explicit local gesture (HUD/voice button/PTT) re-arms
 * the controller. The flag is set before teardown callbacks run so every
 * concurrent async path observes the fail-closed state.
 */

export interface JarvisPowerControl {
  stopInput(): void;
}

let poweredOff = false;
let control: JarvisPowerControl | null = null;

export function registerJarvisPowerControl(
  next: JarvisPowerControl | null,
): () => void {
  control = next;
  if (poweredOff) control?.stopInput();
  return () => {
    if (control === next) control = null;
  };
}

export function powerOffJarvisInput(): void {
  poweredOff = true;
  control?.stopInput();
}

/**
 * Returns true only for the explicit gesture that transitions off → on.
 * Acoustic wake paths must never call this function.
 */
export function reactivateJarvisInput(): boolean {
  const wasPoweredOff = poweredOff;
  poweredOff = false;
  return wasPoweredOff;
}

export function isJarvisPoweredOff(): boolean {
  return poweredOff;
}
