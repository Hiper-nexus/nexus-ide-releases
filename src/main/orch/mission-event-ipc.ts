/**
 * Read/ACK path for the mission event journal (consumer UI).
 * Fail-closed when feature.mission.eventJournal is off or runtime missing.
 */
import { ipcMain } from 'electron';
import { z } from 'zod';
import { ORCH_CHANNELS } from '../../shared/orch-channels';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import { missionEventReplayQuerySchema } from '../../shared/mission-events';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';
import { requireRendererWorkspaceScope } from '../persistence/renderer-workspace-scope';
import { getMissionEventRuntimeManager } from './mission-event-emit';
import { MissionEventJournal } from './mission-event-journal';

const recentSchema = z
  .object({
    missionId: z.string().min(1).max(128),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

const ackSchema = z
  .object({
    missionId: z.string().min(1).max(128),
    upToSequence: z.number().int().nonnegative(),
    consumerId: z.string().min(1).max(128).default('ui-main'),
  })
  .strict();

const cursorSchema = z
  .object({
    missionId: z.string().min(1).max(128),
    consumerId: z.string().min(1).max(128).default('ui-main'),
  })
  .strict();

function journalFor(sender: Electron.WebContents): MissionEventJournal | null {
  if (
    !getFeatureFlagRegistry().isEnabled(FEATURE_FLAG_IDS.missionEventJournal)
  ) {
    return null;
  }
  const manager = getMissionEventRuntimeManager();
  if (!manager) return null;
  const scope = requireRendererWorkspaceScope(sender);
  return new MissionEventJournal(manager, scope);
}

export function registerMissionEventIpc(): void {
  ipcMain.handle(ORCH_CHANNELS.missionEventsRecent, (event, raw) => {
    try {
      const input = recentSchema.parse(raw ?? {});
      const journal = journalFor(event.sender);
      if (!journal) return { events: [], enabled: false };
      return {
        enabled: true,
        events: journal.projectRecent(input.missionId, input.limit ?? 50),
      };
    } catch (err) {
      return {
        events: [],
        enabled: true,
        error: err instanceof Error ? err.message : 'recent failed',
      };
    }
  });

  ipcMain.handle(ORCH_CHANNELS.missionEventsReplay, (event, raw) => {
    try {
      const query = missionEventReplayQuerySchema.parse(raw ?? {});
      const journal = journalFor(event.sender);
      if (!journal) return { events: [], enabled: false };
      return { enabled: true, events: journal.replay(query) };
    } catch (err) {
      return {
        events: [],
        enabled: true,
        error: err instanceof Error ? err.message : 'replay failed',
      };
    }
  });

  ipcMain.handle(ORCH_CHANNELS.missionEventsAck, (event, raw) => {
    try {
      const input = ackSchema.parse(raw ?? {});
      const journal = journalFor(event.sender);
      if (!journal) {
        return { ok: false, error: 'mission event journal disabled' };
      }
      const cursor = journal.ack(
        input.consumerId,
        input.missionId,
        input.upToSequence,
      );
      return { ok: true, cursor };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'ack failed',
      };
    }
  });

  ipcMain.handle(ORCH_CHANNELS.missionEventsCursor, (event, raw) => {
    try {
      const input = cursorSchema.parse(raw ?? {});
      const journal = journalFor(event.sender);
      if (!journal) return { cursor: null, enabled: false };
      return {
        enabled: true,
        cursor: journal.getCursor(input.consumerId, input.missionId),
      };
    } catch (err) {
      return {
        cursor: null,
        enabled: true,
        error: err instanceof Error ? err.message : 'cursor failed',
      };
    }
  });
}
