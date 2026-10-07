import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSwipeArmHaptic, triggerListActionHaptic } from './gesture-haptics'

const mocks = vi.hoisted(() => ({
  platform: { OS: 'ios' },
  impactAsync: vi.fn(() => Promise.resolve()),
  performAndroidHapticsAsync: vi.fn(() => Promise.resolve()),
  notificationAsync: vi.fn(() => Promise.resolve())
}))
vi.mock('react-native', () => ({ Platform: mocks.platform }))
vi.mock('expo-haptics', () => ({
  impactAsync: mocks.impactAsync,
  performAndroidHapticsAsync: mocks.performAndroidHapticsAsync,
  notificationAsync: mocks.notificationAsync,
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' },
  NotificationFeedbackType: { Success: 'success', Error: 'error' },
  AndroidHaptics: { Context_Click: 'context-click', Long_Press: 'long-press' }
}))

const source = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')

beforeEach(() => {
  vi.clearAllMocks()
  mocks.platform.OS = 'ios'
})

describe('createSwipeArmHaptic', () => {
  it('fires one medium impact when the swipe crosses its commit threshold', () => {
    const onArmedChange = createSwipeArmHaptic()
    onArmedChange(true)
    onArmedChange(true)
    expect(mocks.impactAsync).toHaveBeenCalledOnce()
    expect(mocks.impactAsync).toHaveBeenCalledWith('medium')
  })

  it('fires again after the user backs off and re-crosses, never on disarm', () => {
    const onArmedChange = createSwipeArmHaptic()
    onArmedChange(true)
    onArmedChange(false)
    expect(mocks.impactAsync).toHaveBeenCalledOnce()
    onArmedChange(true)
    expect(mocks.impactAsync).toHaveBeenCalledTimes(2)
  })

  it('uses the native long-press haptic on Android', () => {
    mocks.platform.OS = 'android'
    createSwipeArmHaptic()(true)
    expect(mocks.performAndroidHapticsAsync).toHaveBeenCalledWith('long-press')
    expect(mocks.impactAsync).not.toHaveBeenCalled()
  })
})

describe('triggerListActionHaptic', () => {
  it('is a light impact on iOS and a context click on Android', () => {
    triggerListActionHaptic()
    expect(mocks.impactAsync).toHaveBeenCalledWith('light')
    mocks.platform.OS = 'android'
    triggerListActionHaptic()
    expect(mocks.performAndroidHapticsAsync).toHaveBeenCalledWith('context-click')
  })
})

// Wiring only: these gestures live in Reanimated worklets and an Expo route that the
// node test env cannot drive, so assert each one reaches the helper above.
describe('gesture wiring', () => {
  it.each(['../components/RightDrawer.tsx', '../components/mounted-bottom-drawer.tsx'])(
    '%s arms the haptic from its swipe-to-dismiss threshold',
    (path) => {
      const drawer = source(path)
      expect(drawer).toContain('createSwipeArmHaptic()')
      expect(drawer).toContain('runOnJS(onDismissArmedChange)(armed)')
      expect(drawer).toMatch(/(armed = |trackDismissArm\()[^\n]*> DISMISS_THRESHOLD\b/)
    }
  )

  it('confirms a successful pairing and flags a failed one', () => {
    const pairConfirm = source('../../app/pair-confirm.tsx')
    expect(pairConfirm).toMatch(/refreshHostClient\(hostId\)\s+triggerSuccess\(\)/)
    expect(pairConfirm).toMatch(/connect failed', err\)\s+triggerError\(\)/)
  })

  it('taps once per user-picked session tab close', () => {
    expect(source('../session/use-mobile-session-bulk-close.ts')).toMatch(
      /closeSessionTabFromSheet = [^{]*\{\s+triggerListActionHaptic\(\)/
    )
    const sheets = source('../session/MobileSessionSheets.tsx')
    expect(sheets).toContain('onCloseTab={closeSessionTabFromSheet}')
    expect(sheets).toMatch(/triggerListActionHaptic\(\)\s+void handleCloseTerminal\(target\)/)
  })
})
