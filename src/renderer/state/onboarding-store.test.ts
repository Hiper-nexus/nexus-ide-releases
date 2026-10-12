/** @vitest-environment jsdom */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  activationChecklistRemaining,
  shouldShowFirstRunWizard,
  stepIdForIndex,
  useOnboardingStore,
} from './onboarding-store';
import {
  getDefaultOnboardingState,
  ONBOARDING_FLOW_VERSION,
} from '../../shared/constants';

describe('onboarding-store', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useOnboardingStore.getState().reset();
    useOnboardingStore.setState({ hydrated: false, wizardOpen: false, stepIndex: 0 });
  });

  it('opens the wizard only for a fresh current-flow state', () => {
    expect(
      shouldShowFirstRunWizard({
        ...getDefaultOnboardingState(),
        flowVersion: ONBOARDING_FLOW_VERSION,
      }),
    ).toBe(true);
    expect(
      shouldShowFirstRunWizard({
        ...getDefaultOnboardingState(),
        flowVersion: ONBOARDING_FLOW_VERSION,
        closedAt: 1,
      }),
    ).toBe(false);
    expect(
      shouldShowFirstRunWizard({
        ...getDefaultOnboardingState(),
        flowVersion: 4,
      }),
    ).toBe(false);
  });

  it('maps step indexes to keys → agents → project → use', () => {
    expect(stepIdForIndex(0)).toBe('keys');
    expect(stepIdForIndex(3)).toBe('use');
    expect(stepIdForIndex(9)).toBe('use');
    expect(stepIdForIndex(-1)).toBe('keys');
  });

  it('persists checklist marks and derives remaining work', () => {
    const store = useOnboardingStore.getState();
    store.markChecklist('dictatedWithSpace');
    expect(useOnboardingStore.getState().state.checklist.dictatedWithSpace).toBe(
      true,
    );
    const remaining = activationChecklistRemaining(
      useOnboardingStore.getState().state.checklist,
    );
    expect(remaining).not.toContain('dictatedWithSpace');
    expect(remaining).toContain('connectedAccount');
  });

  it('closes the wizard as completed and marks last step', () => {
    const store = useOnboardingStore.getState();
    store.openWizard();
    store.completeStep(1);
    store.closeWizard('completed');
    const state = useOnboardingStore.getState().state;
    expect(state.outcome).toBe('completed');
    expect(state.closedAt).toBeGreaterThan(0);
    expect(state.lastCompletedStep).toBe(4);
    expect(useOnboardingStore.getState().wizardOpen).toBe(false);
    expect(shouldShowFirstRunWizard(state)).toBe(false);
  });

  it('syncs derived activation flags from product facts', () => {
    useOnboardingStore.getState().syncDerivedFlags({
      hasLiveAccountOrKey: true,
      hasWorkspace: true,
      hasMission: false,
    });
    const checklist = useOnboardingStore.getState().state.checklist;
    expect(checklist.connectedAccount).toBe(true);
    expect(checklist.openedProject).toBe(true);
    expect(checklist.createdMission).toBe(false);
  });
});
