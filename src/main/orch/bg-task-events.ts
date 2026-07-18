/**
 * Fan-out for background MCP task lifecycle events (nexus_bg_*).
 * Renderers subscribe via orch IPC; main tools push here on exit/kill.
 */
import type { WebContents } from 'electron';

export interface BgTaskEvent {
  readonly taskId: string;
  readonly command: string;
  readonly status: 'started' | 'exited' | 'killed';
  readonly exitCode: number | null;
  readonly projectId: string;
  readonly checkoutId: string;
  readonly at: number;
}

type Listener = (event: BgTaskEvent) => void;

const listeners = new Set<Listener>();
const webContents = new Set<WebContents>();

export function onBgTaskEvent(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function registerBgTaskEventTarget(wc: WebContents): void {
  webContents.add(wc);
}

export function unregisterBgTaskEventTarget(wc: WebContents): void {
  webContents.delete(wc);
}

export function emitBgTaskEvent(event: BgTaskEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (error) {
      console.warn('[bg-task] listener failed:', error);
    }
  }
  for (const wc of webContents) {
    if (wc.isDestroyed() || wc.isCrashed()) continue;
    try {
      wc.send('orch:bgTask.event', event); // channel: ORCH_CHANNELS.bgTaskEvent
    } catch {
      // frame disposed
    }
  }
}
