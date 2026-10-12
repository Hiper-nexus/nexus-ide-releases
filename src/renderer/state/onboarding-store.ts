import { create } from 'zustand';
import {
  getDefaultOnboardingState,
} from '../../shared/constants';
import {
  isActivationChecklistComplete,
  ONBOARDING_STEP_IDS,
  type OnboardingChecklistState,
  type OnboardingState,
  type OnboardingStepId,
} from '../../shared/onboarding-state-types';
import { ONBOARDING_FLOW_VERSION } from '../../shared/constants';

const STORAGE_KEY = 'nexus.onboarding.v5';

export type ActivationChecklistKey = Exclude<
  keyof OnboardingChecklistState,
  'dismissed'
>;

function readStored(): OnboardingState | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<OnboardingState> | null;
    if (!parsed || typeof parsed !== 'object') return null;
    const base = getDefaultOnboardingState();
    const checklist: OnboardingChecklistState = {
      ...base.checklist,
      ...(parsed.checklist && typeof parsed.checklist === 'object'
        ? parsed.checklist
        : {}),
    };
    return {
      flowVersion:
        typeof parsed.flowVersion === 'number'
          ? parsed.flowVersion
          : base.flowVersion,
      closedAt: typeof parsed.closedAt === 'number' ? parsed.closedAt : null,
      outcome:
        parsed.outcome === 'completed' || parsed.outcome === 'dismissed'
          ? parsed.outcome
          : null,
      lastCompletedStep:
        typeof parsed.lastCompletedStep === 'number'
          ? parsed.lastCompletedStep
          : base.lastCompletedStep,
      checklist,
    };
  } catch {
    return null;
  }
}

function writeStored(state: OnboardingState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage unavailable — wizard still works for this session.
  }
}

/** Wizard should open only for a fresh flow (never re-open a dismissed/completed one). */
export function shouldShowFirstRunWizard(state: OnboardingState): boolean {
  if (state.flowVersion !== ONBOARDING_FLOW_VERSION) return false;
  if (state.closedAt != null) return false;
  return state.lastCompletedStep < 1;
}

export function stepIdForIndex(index: number): OnboardingStepId {
  const clamped = Math.min(
    ONBOARDING_STEP_IDS.length - 1,
    Math.max(0, index),
  );
  return ONBOARDING_STEP_IDS[clamped]!;
}

export interface OnboardingStore {
  state: OnboardingState;
  hydrated: boolean;
  wizardOpen: boolean;
  /** 0-based UI step index. */
  stepIndex: number;
  hydrate(): void;
  openWizard(): void;
  closeWizard(outcome: 'completed' | 'dismissed'): void;
  setStepIndex(index: number): void;
  completeStep(step: number): void;
  markChecklist(key: ActivationChecklistKey): void;
  setChecklist(key: ActivationChecklistKey, value: boolean): void;
  dismissChecklist(): void;
  /** Derive auto flags from live product facts (providers / workspace / mission). */
  syncDerivedFlags(facts: {
    hasLiveAccountOrKey: boolean;
    hasWorkspace: boolean;
    hasMission: boolean;
  }): void;
  reset(): void;
}

function persist(state: OnboardingState): OnboardingState {
  writeStored(state);
  return state;
}

export const useOnboardingStore = create<OnboardingStore>()((set, get) => ({
  state: getDefaultOnboardingState(),
  hydrated: false,
  wizardOpen: false,
  stepIndex: 0,

  hydrate: () => {
    const stored = readStored();
    const state = stored ?? getDefaultOnboardingState();
    set({
      state,
      hydrated: true,
      wizardOpen: shouldShowFirstRunWizard(state),
      stepIndex: 0,
    });
  },

  openWizard: () => set({ wizardOpen: true, stepIndex: 0 }),

  closeWizard: (outcome) => {
    const prev = get().state;
    const next = persist({
      ...prev,
      closedAt: Date.now(),
      outcome,
      lastCompletedStep:
        outcome === 'completed'
          ? ONBOARDING_STEP_IDS.length
          : prev.lastCompletedStep,
    });
    set({ state: next, wizardOpen: false });
  },

  setStepIndex: (index) => set({ stepIndex: index }),

  completeStep: (step) => {
    const prev = get().state;
    const last = Math.max(prev.lastCompletedStep, step);
    const next = persist({ ...prev, lastCompletedStep: last });
    set({ state: next });
  },

  markChecklist: (key) => get().setChecklist(key, true),

  setChecklist: (key, value) => {
    const prev = get().state;
    if (prev.checklist[key] === value) return;
    const checklist = { ...prev.checklist, [key]: value };
    const next = persist({ ...prev, checklist });
    set({ state: next });
  },

  dismissChecklist: () => {
    const prev = get().state;
    const next = persist({
      ...prev,
      checklist: { ...prev.checklist, dismissed: true },
    });
    set({ state: next });
  },

  syncDerivedFlags: (facts) => {
    const prev = get().state;
    const checklist = { ...prev.checklist };
    if (facts.hasLiveAccountOrKey) checklist.connectedAccount = true;
    if (facts.hasWorkspace) checklist.openedProject = true;
    if (facts.hasMission) checklist.createdMission = true;
    const changed =
      checklist.connectedAccount !== prev.checklist.connectedAccount ||
      checklist.openedProject !== prev.checklist.openedProject ||
      checklist.createdMission !== prev.checklist.createdMission;
    if (!changed) return;
    set({ state: persist({ ...prev, checklist }) });
  },

  reset: () =>
    set({
      state: persist(getDefaultOnboardingState()),
      wizardOpen: false,
      stepIndex: 0,
    }),
}));

export function activationChecklistRemaining(
  checklist: OnboardingChecklistState,
): ActivationChecklistKey[] {
  const keys: ActivationChecklistKey[] = [
    'connectedAccount',
    'openedProject',
    'dictatedWithSpace',
    'openedPlusPane',
    'createdMission',
  ];
  return keys.filter((k) => !checklist[k]);
}

export { isActivationChecklistComplete };
