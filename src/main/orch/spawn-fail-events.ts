/**
 * Fan-out civil: CLI falhou ao boot → toast no renderer + log no main.
 * Não toca pet geometry; canal próprio (não vocabulary PR69).
 */
import type { WebContents } from 'electron';
import { ORCH_CHANNELS } from '../../shared/orch-channels';
import type { ProjectExecutionScope } from '../../shared/types';
import { broadcastToProject } from './project-scoped-broadcast';

export interface WorkerSpawnFailedEvent {
  readonly missionId: string;
  readonly deadAdapterId: string;
  readonly message: string;
  readonly title?: string;
  readonly successorCli?: string;
  readonly successorName?: string;
  readonly at: number;
  readonly scope: Readonly<ProjectExecutionScope>;
}

type Listener = (event: WorkerSpawnFailedEvent) => void;

const listeners = new Set<Listener>();
const webContents = new Set<WebContents>();

export function onWorkerSpawnFailed(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function registerWorkerSpawnFailedTarget(wc: WebContents): void {
  webContents.add(wc);
}

export function unregisterWorkerSpawnFailedTarget(wc: WebContents): void {
  webContents.delete(wc);
}

export function emitWorkerSpawnFailed(event: WorkerSpawnFailedEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (error) {
      console.warn('[spawn-fail] listener failed:', error);
    }
  }
  const { scope, ...rendererPayload } = event;
  broadcastToProject(
    webContents,
    scope,
    ORCH_CHANNELS.workerSpawnFailed,
    rendererPayload,
  );
}
