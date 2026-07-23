/**
 * Fan-out for background MCP task lifecycle events (nexus_bg_*).
 * Renderers subscribe via orch IPC; main tools push here on exit/kill.
 */
import type { WebContents } from 'electron';
import { ORCH_CHANNELS } from '../../shared/orch-channels';
import type { ProjectExecutionScope } from '../../shared/types';
import { broadcastToProject } from './project-scoped-broadcast';

export interface BgTaskEvent {
  readonly taskId: string;
  readonly command: string;
  readonly status: 'started' | 'exited' | 'killed';
  readonly exitCode: number | null;
  readonly projectId: string;
  readonly checkoutId: string;
  readonly scope: Readonly<ProjectExecutionScope>;
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
  const { scope, ...rendererPayload } = event;
  broadcastToProject(
    webContents,
    scope,
    ORCH_CHANNELS.bgTaskEvent,
    rendererPayload,
  );
}
