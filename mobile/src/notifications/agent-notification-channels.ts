// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: canais criados via expo-notifications (sem Effect/Kotlin), alerta HIGH + atividade LOW separados, ids novos sem tocar nos canais orca-desktop; escolha do canal na reapresentação em foreground.
import * as Notifications from 'expo-notifications'
import { Platform } from 'react-native'

// Why new ids instead of reusing 'orca-desktop': Android freezes a channel's importance,
// sound and vibration once it exists, so a different behaviour needs a different id.
// The legacy channels stay as they are because gateway payloads already name them.
export const AGENT_ALERT_CHANNEL_ID = 'agent-alerts'
export const AGENT_ACTIVITY_CHANNEL_ID = 'agent-activity'

/** Android channel a foreground re-presentation posts to. Activity never borrows the alert channel. */
export function foregroundPresentationChannel(
  kind: 'alert' | 'activity',
  requestedChannelId: unknown
): string {
  if (kind === 'activity') {
    return AGENT_ACTIVITY_CHANNEL_ID
  }
  return typeof requestedChannelId === 'string' && requestedChannelId.length > 0
    ? requestedChannelId
    : AGENT_ALERT_CHANNEL_ID
}

/** Idempotent on Android (the OS keeps the first settings); a no-op elsewhere. */
export async function ensureAgentNotificationChannels(): Promise<void> {
  if (Platform.OS !== 'android') {
    return
  }
  // Alerts interrupt: an agent finished, failed or is waiting on the user.
  await Notifications.setNotificationChannelAsync(AGENT_ALERT_CHANNEL_ID, {
    name: 'Agent alerts',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250]
  })
  // Activity is status, not an interruption: no heads-up, sound or vibration.
  await Notifications.setNotificationChannelAsync(AGENT_ACTIVITY_CHANNEL_ID, {
    name: 'Agent activity',
    importance: Notifications.AndroidImportance.LOW,
    sound: null,
    enableVibrate: false,
    showBadge: false
  })
}
