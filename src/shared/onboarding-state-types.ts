/**
 * Onboarding activation state (Nexus, flow v5).
 * Checklist keys are product activation facts — telemetry enum stays in sync
 * via `telemetry-onboarding-foundation-schemas.ts`.
 */

/** Subset of onboarding DiscoveryState statuses that emit telemetry. */
export type DiscoveryStatusEmitted = 'found' | 'absent' | 'imported'

export type OnboardingOutcome = 'completed' | 'dismissed'

/** Wizard steps 1..4 (keys → agents → project → use). */
export const ONBOARDING_STEP_IDS = ['keys', 'agents', 'project', 'use'] as const
export type OnboardingStepId = (typeof ONBOARDING_STEP_IDS)[number]

export type OnboardingChecklistState = {
  /** Conta CLI viva ou chave de API configurada em algum provider. */
  connectedAccount: boolean
  /** Workspace/projeto aberto. */
  openedProject: boolean
  /** Usou o hold-to-talk do Space (ditado). */
  dictatedWithSpace: boolean
  /** Abriu o picker do + Pane. */
  openedPlusPane: boolean
  /** Criou a primeira missão. */
  createdMission: boolean
  /** UI-only: painel residual dispensado pelo operador. */
  dismissed: boolean
}

export type OnboardingState = {
  /** Step meanings change when pages are removed; version marker prevents migration re-running on new progress. */
  flowVersion: number
  closedAt: number | null
  outcome: OnboardingOutcome | null
  /** Sentinel -1 = not started; 1..4 = highest finished wizard step. */
  lastCompletedStep: number
  checklist: OnboardingChecklistState
}

export function isActivationChecklistComplete(
  checklist: OnboardingChecklistState,
): boolean {
  return (
    checklist.connectedAccount &&
    checklist.openedProject &&
    checklist.dictatedWithSpace &&
    checklist.openedPlusPane &&
    checklist.createdMission
  )
}
