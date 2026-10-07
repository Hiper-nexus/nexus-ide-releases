import { Platform } from 'react-native'
import * as Notifications from 'expo-notifications'
import { canPresentForegroundPush } from './push-receive'
import { readOrcaPushPayload } from './push-payload'
import { classifyForegroundNotification } from './foreground-notification-policy'
import { foregroundPresentationChannel } from './agent-notification-channels'

export function startAndroidForegroundPushPresentation(): () => void {
  if (Platform.OS !== 'android') {
    return () => {}
  }

  const subscription = Notifications.addNotificationReceivedListener((notification) => {
    const { trigger, content, identifier } = notification.request
    // Expo emits foreground data pushes but only auto-presents them in the background.
    if (
      !trigger ||
      !('type' in trigger) ||
      trigger.type !== 'push' ||
      trigger.remoteMessage?.notification !== null
    ) {
      return
    }
    const payload = readOrcaPushPayload(content.data)
    if (!payload || payload.kind === 'dismiss' || (!content.title && !content.body)) {
      return
    }

    void present().catch((error: unknown) => {
      console.warn('[push] Foreground notification presentation failed', error)
    })

    async function present(): Promise<void> {
      if (!payload || !(await canPresentForegroundPush(payload))) {
        return
      }
      const kind = classifyForegroundNotification(payload)
      await Notifications.scheduleNotificationAsync({
        identifier,
        content: {
          title: content.title,
          body: content.body,
          data: content.data,
          sound: kind === 'alert' && content.sound === 'default' ? 'default' : false
        },
        trigger: { channelId: foregroundPresentationChannel(kind, content.data?.channelId) }
      })
    }
  })
  return () => subscription.remove()
}
