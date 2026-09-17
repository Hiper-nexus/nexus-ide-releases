import { ipcMain, type WebContents } from 'electron'
import { TOKEN_SPEED_CHANNELS } from '../../shared/token-speed-types'
import type { TokenSpeedSnapshot } from '../../shared/token-speed-types'
import type { ProjectExecutionScope } from '../../shared/types'
import { requireRendererWorkspaceScope } from '../persistence/renderer-workspace-scope'
import { broadcastToProject } from './project-scoped-broadcast'
import {
  getTokenSpeedSnapshot,
  initTokenSpeedTracker,
  onTokenSpeedChange,
} from './token-speed-tracker'

/**
 * Superfície IPC do medidor de velocidade. Read-only por contrato: o renderer
 * observa, nunca escreve. O escopo vem da autoridade do workspace do sender —
 * jamais de um argumento do renderer.
 */

const listeners = new Set<WebContents>()
let registered = false

function broadcast(
  scope: ProjectExecutionScope,
  snapshot: TokenSpeedSnapshot,
): void {
  broadcastToProject(listeners, scope, TOKEN_SPEED_CHANNELS.changed, snapshot)
}

export function registerTokenSpeedListener(webContents: WebContents): void {
  listeners.add(webContents)
}

export function unregisterTokenSpeedListener(webContents: WebContents): void {
  listeners.delete(webContents)
}

/** Register tracker taps, broadcasts and IPC handlers exactly once. */
export function registerTokenSpeedIpc(): void {
  if (registered) return
  registered = true
  initTokenSpeedTracker()
  onTokenSpeedChange(broadcast)

  ipcMain.handle(TOKEN_SPEED_CHANNELS.snapshot, (event) =>
    getTokenSpeedSnapshot(requireRendererWorkspaceScope(event.sender)),
  )
}
