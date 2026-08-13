/**
 * Fan-out of hook waiting latches to the renderer inbox (⌘J "pede Enter").
 * Two planes, same pane: semantic `/hook/status` and Orca managed hooks.
 * Main only forwards; the renderer ORs the sources (see agent-waiting.ts).
 */
import type { WebContents } from 'electron';
import { tapAgentHookStatus } from '../agent-hooks/hook-ingest';
import { getAgentSessionInfo } from '../pty/pty-manager';
import { ORCH_CHANNELS } from '../../shared/orch-channels';
import type { AgentWaitingEvent } from '../../shared/types';
import { tapAgentSemanticStatus } from './agent-status';

const webContents = new Set<WebContents>();
let stopTaps: (() => void) | null = null;

function agentLabelFor(sessionId: string): string {
  const info = getAgentSessionInfo(sessionId);
  return (
    info?.agentName?.trim() ||
    info?.adapterId?.trim() ||
    'Agente'
  );
}

function emit(event: AgentWaitingEvent): void {
  for (const wc of webContents) {
    if (wc.isDestroyed() || wc.isCrashed()) continue;
    try {
      wc.send(ORCH_CHANNELS.agentWaiting, event);
    } catch {
      // frame disposed
    }
  }
}

export function registerAgentWaitingTarget(wc: WebContents): void {
  webContents.add(wc);
}

export function unregisterAgentWaitingTarget(wc: WebContents): void {
  webContents.delete(wc);
}

export function initAgentWaitingBroadcast(): () => void {
  if (stopTaps) return stopTaps;
  const offSemantic = tapAgentSemanticStatus((entry) => {
    emit({
      source: 'semantic',
      sessionId: entry.sessionId,
      paneId: entry.paneId,
      agentLabel: agentLabelFor(entry.sessionId),
      state: entry.status,
      at: entry.updatedAt,
    });
  });
  const offOrca = tapAgentHookStatus((sessionId, state) => {
    const info = getAgentSessionInfo(sessionId);
    if (!info?.paneId) return;
    emit({
      source: 'orca',
      sessionId,
      paneId: info.paneId,
      agentLabel:
        info.agentName?.trim() || info.adapterId.trim() || 'Agente',
      state,
      at: Date.now(),
    });
  });
  stopTaps = () => {
    offSemantic();
    offOrca();
    stopTaps = null;
  };
  return stopTaps;
}

export function shutdownAgentWaitingBroadcast(): void {
  stopTaps?.();
  stopTaps = null;
}
