import { trace } from './main-trace';

type BootPhase = 'whenReady' | 'window-created' | 'path-resolved' |
  'bootstrap-ready' | 'renderer-load-start' | 'did-finish-load' | 'mount';
let boot: {
  phases: Partial<Record<BootPhase, number>>;
  slowSteps: Array<{ step: string; startMs: number; durationMs: number }>;
} | undefined;

export function beginBootPhases(): void {
  boot = { phases: {}, slowSteps: [] };
}

/** Monotonic offsets from process start; never include paths, env or user text. */
export function markBootPhase(phase: BootPhase): void {
  if (!boot) return;
  boot.phases[phase] ??= Math.round(performance.now());
  // React can commit before the top-level load reaches Main. Wait for both
  // signals to keep all milestones in the single event, in either order.
  if (boot.phases.mount === undefined || boot.phases['did-finish-load'] === undefined) return;
  const completed = boot;
  boot = undefined;
  trace({ kind: 'boot-phases', startedAt: performance.timeOrigin, ...completed });
}

export function startBootStep(): number | undefined {
  return boot ? performance.now() : undefined;
}

export function finishBootStep(step: string, start: number | undefined): void {
  if (!boot || start === undefined) return;
  const durationMs = performance.now() - start;
  if (durationMs > 20) boot.slowSteps.push({ step, startMs: Math.round(start), durationMs: Math.round(durationMs) });
}
