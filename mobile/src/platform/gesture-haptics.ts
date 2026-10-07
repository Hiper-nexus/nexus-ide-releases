// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: extraído de useThreadListActions/thread-swipe-actions para helpers sem estado de React; Android usa performAndroidHapticsAsync como o resto de platform/haptics.
import { Platform } from 'react-native'
import * as Haptics from 'expo-haptics'
import { triggerMediumImpact } from './haptics'

/** Light tap the moment a list row action (close, remove, reconnect…) is dispatched. */
export function triggerListActionHaptic(): void {
  if (Platform.OS === 'android') {
    void Haptics.performAndroidHapticsAsync(Haptics.AndroidHaptics.Context_Click).catch(() => {})
  } else {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {})
  }
}

/**
 * Tracks a swipe-to-commit gesture: a medium impact fires once each time the drag
 * crosses its commit threshold, so the user feels "release now dismisses" before
 * letting go. Re-arming after backing off fires again; staying armed does not.
 */
export function createSwipeArmHaptic(): (armed: boolean) => void {
  let wasArmed = false
  return (armed) => {
    if (armed && !wasArmed) {
      triggerMediumImpact()
    }
    wasArmed = armed
  }
}
