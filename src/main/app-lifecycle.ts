export interface ActivateWindowState {
  readonly isShutdownInProgress: boolean;
  readonly isShutdownComplete: boolean;
  readonly windowCount: number;
}

export function shouldCreateWindowOnActivate(
  state: ActivateWindowState,
): boolean {
  return (
    !state.isShutdownInProgress &&
    !state.isShutdownComplete &&
    state.windowCount === 0
  );
}
