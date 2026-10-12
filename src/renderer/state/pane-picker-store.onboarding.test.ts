/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from 'vitest';
import { usePanePickerStore } from './pane-picker-store';
import { useOnboardingStore } from './onboarding-store';

describe('pane-picker-store onboarding hook', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useOnboardingStore.getState().reset();
    usePanePickerStore.getState().consumePendingOpen();
  });

  it('marks openedPlusPane when + Pane is requested', () => {
    expect(useOnboardingStore.getState().state.checklist.openedPlusPane).toBe(
      false,
    );
    usePanePickerStore.getState().requestOpen();
    expect(usePanePickerStore.getState().pendingOpen).toBe(true);
    expect(useOnboardingStore.getState().state.checklist.openedPlusPane).toBe(
      true,
    );
  });
});
