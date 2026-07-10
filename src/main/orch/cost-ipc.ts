import { ipcMain, type WebContents } from 'electron';
import { COST_CHANNELS, setCapSchema } from '../../shared/cost-types';
import type { CostSnapshot } from '../../shared/cost-types';
import type { ProjectExecutionScope } from '../../shared/types';
import { requireRendererWorkspaceScope } from '../persistence/renderer-workspace-scope';
import { broadcastToProject } from './project-scoped-broadcast';
import {
  getCostSnapshot,
  initCostTracker,
  onCostChange,
  setPaneCap,
} from './cost-tracker';

const listeners = new Set<WebContents>();
let registered = false;

function broadcast(
  scope: ProjectExecutionScope,
  snapshot: CostSnapshot,
): void {
  broadcastToProject(listeners, scope, COST_CHANNELS.changed, snapshot);
}

export function registerCostListener(webContents: WebContents): void {
  listeners.add(webContents);
}

export function unregisterCostListener(webContents: WebContents): void {
  listeners.delete(webContents);
}

/** Register tracker taps, broadcasts and IPC handlers exactly once. */
export function registerCostIpc(): void {
  if (registered) return;
  registered = true;
  initCostTracker();
  onCostChange(broadcast);

  ipcMain.handle(COST_CHANNELS.snapshot, (event) =>
    getCostSnapshot(requireRendererWorkspaceScope(event.sender)),
  );

  ipcMain.handle(COST_CHANNELS.setCap, (event, raw) => {
    const scope = requireRendererWorkspaceScope(event.sender);
    const parsed = setCapSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'invalid cap payload' };
    const ok = setPaneCap(scope, parsed.data.paneId, parsed.data.capUsd);
    return ok ? { ok: true } : { ok: false, error: 'unknown pane' };
  });
}
