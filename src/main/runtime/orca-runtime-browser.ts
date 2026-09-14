import type { BrowserScreencastReadyResult } from '../../shared/runtime-types'

export type RuntimeBrowserCommands = {
  browserScreencast: (
    params: any,
    options: {
      sendBinary?: (bytes: Uint8Array<ArrayBufferLike>) => boolean | void
      emit: (result: any) => void
      pairedDeviceId?: string
    }
  ) => Promise<{
    subscriptionId: string
    ready: BrowserScreencastReadyResult
    session: { done: Promise<void>; stop: () => void }
    flushPendingFrame: () => void
  }>
  [key: string]: any
}
