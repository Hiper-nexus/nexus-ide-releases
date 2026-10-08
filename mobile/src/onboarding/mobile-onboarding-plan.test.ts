import { beforeEach, describe, expect, it, vi } from 'vitest'
import { shouldPresentNotificationOptIn } from '../notifications/notification-opt-in-gate'
import { shouldPresentSessionViewOptIn } from '../session/session-view-opt-in-gate'
import {
  loadMobileOnboardingSteps,
  mobileOnboardingDestination,
  mobileOnboardingStepsForHosts,
  parseMobileOnboardingSteps
} from './mobile-onboarding-plan'

vi.mock('../notifications/notification-opt-in-gate', () => ({
  shouldPresentNotificationOptIn: vi.fn()
}))
vi.mock('../session/session-view-opt-in-gate', () => ({
  shouldPresentSessionViewOptIn: vi.fn()
}))

describe('mobile onboarding plan', () => {
  beforeEach(() => {
    vi.mocked(shouldPresentNotificationOptIn).mockReset().mockResolvedValue(false)
    vi.mocked(shouldPresentSessionViewOptIn).mockReset().mockResolvedValue(false)
  })

  it.each([
    [true, true, ['session-view', 'notifications']],
    [true, false, ['session-view']],
    [false, true, ['notifications']],
    [false, false, []]
  ] as const)(
    'builds the exact plan for session=%s notifications=%s',
    async (showSession, showNotifications, expected) => {
      vi.mocked(shouldPresentSessionViewOptIn).mockResolvedValue(showSession)
      vi.mocked(shouldPresentNotificationOptIn).mockResolvedValue(showNotifications)

      await expect(loadMobileOnboardingSteps()).resolves.toEqual(expected)
      expect(shouldPresentSessionViewOptIn).toHaveBeenCalledOnce()
      expect(shouldPresentNotificationOptIn).toHaveBeenCalledOnce()
    }
  )

  it.each([
    [[], undefined, '/'],
    [[], 'paired-host', '/h/paired-host'],
    [
      ['session-view', 'notifications'],
      undefined,
      {
        pathname: '/mobile-onboarding',
        params: { steps: 'session-view,notifications' }
      }
    ],
    [
      ['notifications'],
      'paired-host',
      {
        pathname: '/mobile-onboarding',
        params: { steps: 'notifications', hostId: 'paired-host' }
      }
    ]
  ] as const)('maps %j with host %s to the correct destination', (steps, hostId, destination) => {
    expect(mobileOnboardingDestination(steps, hostId)).toEqual(destination)
  })

  it('parses route steps in canonical order without duplicates', () => {
    expect(parseMobileOnboardingSteps('notifications,unknown,session-view,notifications')).toEqual([
      'session-view',
      'notifications'
    ])
    expect(parseMobileOnboardingSteps('notifications')).toEqual(['notifications'])
  })

  // F-1037: host Nexus não tem a UI de chat; o onboarding não pergunta o modo de sessão.
  it('drops the Chat UI question only when every host is Nexus', () => {
    const all = ['session-view', 'notifications'] as const
    expect(mobileOnboardingStepsForHosts(all, ['nexus-bridge'])).toEqual(['notifications'])
    expect(mobileOnboardingStepsForHosts(all, ['nexus-bridge', 'nexus-bridge'])).toEqual([
      'notifications'
    ])
    expect(mobileOnboardingStepsForHosts(all, ['nexus-bridge', undefined])).toEqual([...all])
    expect(mobileOnboardingStepsForHosts(all, [undefined])).toEqual([...all])
    expect(mobileOnboardingStepsForHosts(all, [])).toEqual([...all])
  })

  it('defaults missing or invalid route state to the complete wizard', () => {
    expect(parseMobileOnboardingSteps(undefined)).toEqual(['session-view', 'notifications'])
    expect(parseMobileOnboardingSteps('unknown')).toEqual(['session-view', 'notifications'])
  })
})
