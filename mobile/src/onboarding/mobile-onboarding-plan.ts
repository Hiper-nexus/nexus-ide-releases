import { shouldPresentNotificationOptIn } from '../notifications/notification-opt-in-gate'
import { shouldPresentSessionViewOptIn } from '../session/session-view-opt-in-gate'
import { NEXUS_BRIDGE_HOST_KIND } from '../transport/types'

export const MOBILE_ONBOARDING_STEPS = ['session-view', 'notifications'] as const
export type MobileOnboardingStep = (typeof MOBILE_ONBOARDING_STEPS)[number]
export type MobileOnboardingDestination =
  | '/'
  | `/h/${string}`
  | {
      pathname: '/mobile-onboarding'
      params: { steps: string; hostId?: string }
    }

/** Loads every outstanding decision in the order the wizard presents them. */
export async function loadMobileOnboardingSteps(): Promise<MobileOnboardingStep[]> {
  // Why: the wizard needs the complete plan for accurate progress dots; run the
  // independent gates together so adding the second decision does not add latency.
  const [showSessionView, showNotifications] = await Promise.all([
    shouldPresentSessionViewOptIn(),
    shouldPresentNotificationOptIn()
  ])
  return MOBILE_ONBOARDING_STEPS.filter(
    (step) =>
      (step === 'session-view' && showSessionView) ||
      (step === 'notifications' && showNotifications)
  )
}

/**
 * F-1037: o desktop Nexus não tem a UI de chat, então "como as sessões abrem" não se
 * aplica quando todos os hosts em jogo são Nexus. Sem host (lista vazia), nada muda.
 */
export function mobileOnboardingStepsForHosts(
  steps: readonly MobileOnboardingStep[],
  hostKinds: readonly (string | undefined)[]
): MobileOnboardingStep[] {
  const nexusOnly =
    hostKinds.length > 0 && hostKinds.every((kind) => kind === NEXUS_BRIDGE_HOST_KIND)
  return nexusOnly ? steps.filter((step) => step !== 'session-view') : [...steps]
}

/** Preserves a paired host while routing through outstanding decisions. */
export function mobileOnboardingDestination(
  steps: readonly MobileOnboardingStep[],
  hostId?: string
): MobileOnboardingDestination {
  if (steps.length === 0) {
    return hostId ? `/h/${hostId}` : '/'
  }
  return {
    pathname: '/mobile-onboarding',
    params: { steps: steps.join(','), ...(hostId ? { hostId } : {}) }
  }
}

/** Restores the canonical order and ignores duplicate or unknown route values. */
export function parseMobileOnboardingSteps(raw: string | undefined): MobileOnboardingStep[] {
  if (!raw) {
    return [...MOBILE_ONBOARDING_STEPS]
  }
  const requested = new Set(raw.split(','))
  const steps = MOBILE_ONBOARDING_STEPS.filter((step) => requested.has(step))
  return steps.length > 0 ? steps : [...MOBILE_ONBOARDING_STEPS]
}
