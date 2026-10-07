// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: classe alerta/atividade em vez de deep link de thread; a supressão "em tela" vem da política de visualização do Nexus (preferência suppressWhileViewing).
import type { NotificationBehavior } from 'expo-notifications'
import type { OrcaPushPayload } from './push-payload'

export type ForegroundNotificationKind = 'alert' | 'activity'

const SHOW: NotificationBehavior = {
  shouldShowBanner: true,
  shouldShowList: true,
  shouldPlaySound: true,
  shouldSetBadge: false
}

const SHOW_SILENT: NotificationBehavior = { ...SHOW, shouldPlaySound: false }

// Activity keeps updating the tray while the app is open, but never banners or sounds.
const ACTIVITY: NotificationBehavior = {
  shouldShowBanner: false,
  shouldShowList: true,
  shouldPlaySound: false,
  shouldSetBadge: false
}

const SUPPRESS: NotificationBehavior = {
  shouldShowBanner: false,
  shouldShowList: false,
  shouldPlaySound: false,
  shouldSetBadge: false
}

export function classifyForegroundNotification(
  payload: Pick<OrcaPushPayload, 'kind'> | null
): ForegroundNotificationKind {
  return payload?.kind === 'activity' ? 'activity' : 'alert'
}

/**
 * Whether the workspace already on screen silences this class. An alert for it is
 * redundant with the live session, so it stays quiet in the foreground; activity is
 * status the user is still following, so it keeps updating.
 */
export function suppressesWhileOnScreen(kind: ForegroundNotificationKind): boolean {
  return kind === 'alert'
}

/**
 * Decides how a notification that arrives while the app is open is presented.
 * `suppressed` folds every reason the push must not show (consent, host, dismissal,
 * duplicate, or an alert for the workspace on screen).
 */
export function resolveForegroundNotificationBehavior(
  kind: ForegroundNotificationKind,
  input: { readonly suppressed: boolean; readonly sound: boolean }
): NotificationBehavior {
  if (input.suppressed) {
    return SUPPRESS
  }
  if (kind === 'activity') {
    return ACTIVITY
  }
  return input.sound ? SHOW : SHOW_SILENT
}
