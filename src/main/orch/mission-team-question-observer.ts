/**
 * F-143: Main-observed pane→session bindings for team-question attribution.
 *
 * Worker panes spawned without workerIncarnationId/authoritySeal (legacy or
 * manual composition rows) can never satisfy the strict seal matcher, so
 * their real answers pile up as "Respostas pendentes" forever. The journal
 * already records every link needed to attribute them without trusting
 * agent-declared fields:
 *
 * - spawn registry binds pane → agent (Main-minted);
 * - `observer.session_spawned` binds pane → session (Main-observed);
 * - the MCP receipt binds session → payload (Main-observed pty-stream).
 *
 * Everything here fail-closes to `[]`: no journal, no manager, unreadable
 * rows, or unknown shapes all mean "no bindings" — never a weaker match.
 */
import type { ProjectExecutionScope } from '../../shared/types';
import type { TeamQuestionObserverBinding } from './mission-team-question-completion';
import { getMissionEventRuntimeManager } from './mission-event-emit';
import { MissionEventJournal } from './mission-event-journal';

export function extractObserverPaneSessions(
  payloads: readonly unknown[],
): TeamQuestionObserverBinding[] {
  const bindings: TeamQuestionObserverBinding[] = [];
  for (const raw of payloads) {
    let payload: Record<string, unknown> | null = null;
    if (typeof raw === 'string') {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') payload = parsed as Record<string, unknown>;
      } catch {
        continue;
      }
    } else if (raw && typeof raw === 'object') {
      payload = raw as Record<string, unknown>;
    }
    if (!payload) continue;
    const { paneId, sessionId } = payload;
    if (typeof paneId === 'string' && paneId && typeof sessionId === 'string' && sessionId) {
      bindings.push({ paneId, sessionId });
    }
  }
  return bindings;
}

export function loadObserverPaneSessions(
  scope: ProjectExecutionScope,
  missionId: string,
  deps: {
    readonly listSpawnPayloads?: (missionId: string) => readonly unknown[];
  } = {},
): TeamQuestionObserverBinding[] {
  try {
    if (!missionId) return [];
    if (deps.listSpawnPayloads) return extractObserverPaneSessions(deps.listSpawnPayloads(missionId));
    const manager = getMissionEventRuntimeManager();
    if (!manager) return [];
    return extractObserverPaneSessions(
      new MissionEventJournal(manager, scope).listSessionSpawnedPayloads(missionId),
    );
  } catch {
    return [];
  }
}
