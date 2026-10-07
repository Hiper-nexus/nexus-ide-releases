// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: casos de alerta vs. atividade sobre o workspace em tela do Nexus, mais o caminho real de push-receive e os canais Android.
import { sha256 } from '@noble/hashes/sha256'
import { AppState } from 'react-native'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as Notifications from 'expo-notifications'
import { loadHostCatalog } from '../transport/host-store'
import type { HostCatalogEntry } from '../transport/types'
import {
  AGENT_ACTIVITY_CHANNEL_ID,
  AGENT_ALERT_CHANNEL_ID,
  ensureAgentNotificationChannels,
  foregroundPresentationChannel
} from './agent-notification-channels'
import {
  classifyForegroundNotification,
  resolveForegroundNotificationBehavior
} from './foreground-notification-policy'
import { setNotificationViewingWorkspace } from './notification-viewing-policy'
import { foregroundNotificationBehavior, resetForegroundPushClaimsForTests } from './push-receive'

const platform = vi.hoisted(() => ({ OS: 'android' }))
vi.mock('react-native', () => ({ AppState: { currentState: 'background' }, Platform: platform }))
vi.mock('expo-notifications', () => ({
  AndroidImportance: { LOW: 'low', DEFAULT: 'default', HIGH: 'high' },
  setNotificationChannelAsync: vi.fn()
}))
vi.mock('./push-tray-dismissal', () => ({ dismissPresentedPushNotification: vi.fn() }))
vi.mock('../transport/host-store', () => ({ loadHostCatalog: vi.fn() }))
const storage = vi.hoisted(() => new Map<string, string>())
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => storage.set(key, value))
  }
}))

const publicKeyB64 = Buffer.alloc(32, 1).toString('base64')
const hostFingerprint = Buffer.from(sha256(Buffer.alloc(32, 1)))
  .toString('base64url')
  .slice(0, 16)

function push(kind: 'alert' | 'activity', seq: number) {
  return {
    request: {
      content: {
        data: {
          orca: {
            hostFingerprint,
            kind,
            worktreeId: 'workspace',
            notificationEpoch: 'epoch',
            notificationSeq: seq
          }
        }
      }
    }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  platform.OS = 'android'
  AppState.currentState = 'background'
  setNotificationViewingWorkspace(null)
  storage.clear()
  storage.set('orca:pushServiceNotificationsEnabled', 'true')
  resetForegroundPushClaimsForTests()
  vi.mocked(loadHostCatalog).mockResolvedValue([
    { id: 'host-1', publicKeyB64 }
  ] as unknown as HostCatalogEntry[])
})

describe('agent notification channels', () => {
  it('creates a high-importance alert channel and a separate low-importance activity channel', async () => {
    await ensureAgentNotificationChannels()
    const calls = vi.mocked(Notifications.setNotificationChannelAsync).mock.calls
    expect(calls).toEqual([
      [AGENT_ALERT_CHANNEL_ID, expect.objectContaining({ importance: 'high' })],
      [
        AGENT_ACTIVITY_CHANNEL_ID,
        expect.objectContaining({ importance: 'low', sound: null, enableVibrate: false })
      ]
    ])
  })

  it('uses new ids instead of renaming the channels Android already froze', () => {
    expect(new Set([AGENT_ALERT_CHANNEL_ID, AGENT_ACTIVITY_CHANNEL_ID, 'orca-desktop'])).toHaveProperty(
      'size',
      3
    )
    expect(AGENT_ALERT_CHANNEL_ID).not.toMatch(/^orca-desktop/)
    expect(AGENT_ACTIVITY_CHANNEL_ID).not.toMatch(/^orca-desktop/)
  })

  it('creates nothing on iOS', async () => {
    platform.OS = 'ios'
    await ensureAgentNotificationChannels()
    expect(Notifications.setNotificationChannelAsync).not.toHaveBeenCalled()
  })
})

describe('foreground notification policy', () => {
  it('classifies only explicit activity pushes as activity', () => {
    expect(classifyForegroundNotification({ kind: 'activity' })).toBe('activity')
    expect(classifyForegroundNotification({ kind: 'alert' })).toBe('alert')
    expect(classifyForegroundNotification({})).toBe('alert')
    expect(classifyForegroundNotification(null)).toBe('alert')
  })

  it('presents activity quietly in the tray and alerts with a banner', () => {
    expect(resolveForegroundNotificationBehavior('activity', { suppressed: false, sound: true }))
      .toEqual({
        shouldShowBanner: false,
        shouldShowList: true,
        shouldPlaySound: false,
        shouldSetBadge: false
      })
    expect(resolveForegroundNotificationBehavior('alert', { suppressed: false, sound: true }))
      .toMatchObject({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true })
    expect(
      resolveForegroundNotificationBehavior('alert', { suppressed: false, sound: false })
    ).toMatchObject({ shouldShowBanner: true, shouldPlaySound: false })
  })

  it('posts activity on its own channel and alerts on the requested or alert channel', () => {
    expect(foregroundPresentationChannel('activity', 'orca-desktop')).toBe(AGENT_ACTIVITY_CHANNEL_ID)
    expect(foregroundPresentationChannel('alert', 'orca-desktop')).toBe('orca-desktop')
    expect(foregroundPresentationChannel('alert', undefined)).toBe(AGENT_ALERT_CHANNEL_ID)
  })

  it('in the foreground, suppresses the alert for the workspace on screen but keeps its activity', async () => {
    AppState.currentState = 'active'
    setNotificationViewingWorkspace({ hostId: 'host-1', worktreeId: 'workspace' })

    const alert = await foregroundNotificationBehavior(push('alert', 1))
    expect(alert).toMatchObject({ shouldShowBanner: false, shouldShowList: false })

    const activity = await foregroundNotificationBehavior(push('activity', 2))
    expect(activity).toMatchObject({
      shouldShowBanner: false,
      shouldShowList: true,
      shouldPlaySound: false
    })
  })

  it('shows the same alert once the app is backgrounded', async () => {
    setNotificationViewingWorkspace({ hostId: 'host-1', worktreeId: 'workspace' })
    await expect(foregroundNotificationBehavior(push('alert', 3))).resolves.toMatchObject({
      shouldShowBanner: true,
      shouldShowList: true
    })
  })
})
