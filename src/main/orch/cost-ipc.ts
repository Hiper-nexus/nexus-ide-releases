import { ipcMain } from 'electron';
import type { WebContents } from 'electron';
import { COST_CHANNELS, setCapSchema } from '../../shared/cost-types';
import type { CostSnapshot } from '../../shared/cost-types';
import {
  getCostSnapshot,
  initCostTracker,
  onCostChange,
  setPaneCap,
} from './cost-tracker';

/**
 * Renderer-facing IPC for the cost tracker. Same shape as account-ipc:
 * handle() for pull-style calls, a WebContents listener set for the
 * throttled `cost:changed` broadcast.
 */

const listeners = new Set<WebContents>();

function broadcast(snapshot: CostSnapshot): void {
  for (const wc of listeners) {
    if (!wc.isDestroyed()) wc.send(COST_CHANNELS.changed, snapshot);
  }
}

export function registerCostListener(wc: WebContents): void {
  listeners.add(wc);
}
export function unregisterCostListener(wc: WebContents): void {
  listeners.delete(wc);
}

export function registerCostIpc(): void {
  initCostTracker();
  onCostChange(broadcast);

  ipcMain.handle(COST_CHANNELS.snapshot, () => getCostSnapshot());

  ipcMain.handle(COST_CHANNELS.setCap, (_e, raw) => {
    const parsed = setCapSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'invalid cap payload' };
    const ok = setPaneCap(parsed.data.paneId, parsed.data.capUsd);
    return ok ? { ok: true } : { ok: false, error: 'unknown pane' };
  });
}
