/**
 * Cross-module handle for the work-narration queue owned by voice-controller.
 * powerOffJarvis must clear pending narrations so idle-status kicks do not
 * restart speech after the user powers off.
 */

export interface NarrationControl {
  clear(): void;
  /** Stop draining and drop pending + active. */
  halt(): void;
}

let control: NarrationControl | null = null;
/** User powered off — block narrations until the next wake/PTT. */
let outputHalted = false;

export function registerNarrationControl(next: NarrationControl | null): void {
  control = next;
}

export function clearJarvisNarration(): void {
  control?.clear();
}

export function haltJarvisNarration(): void {
  outputHalted = true;
  control?.halt();
}

/** Call on wake / PTT / explicit user re-engagement so she can speak again. */
export function resumeJarvisNarration(): void {
  outputHalted = false;
}

export function isJarvisNarrationHalted(): boolean {
  return outputHalted;
}
