import type { VoiceNarrationEvent } from '../../shared/voice-ipc';

const MAX_SEEN = 256;

/** Renderer authority for proactive work speech. Project scope is already
 * enforced by main IPC; this layer enforces mission/pane visibility + dedup. */
export class WorkNarrationSupervisor {
  private readonly seen = new Set<string>();

  accept(
    event: VoiceNarrationEvent,
    context: { focusedPaneId?: string | null; focusedMissionId?: string | null },
  ): boolean {
    const text = event.text.trim();
    if (!text) return false;
    const key = event.eventId?.trim() || `${event.missionId ?? ''}\0${event.paneId ?? ''}\0${text}`;
    if (this.seen.has(key)) return false;

    // If an update names a mission and the focused pane belongs to another,
    // silence it. No mission anchor means project-level UI, where the update is
    // still useful and may be queued by NarrationQueue until idle.
    if (
      event.missionId &&
      context.focusedMissionId &&
      event.missionId !== context.focusedMissionId
    ) return false;
    // Pane-specific updates in the same mission remain speakable; updates with
    // no mission must match the focused pane when a pane origin is supplied.
    if (
      event.paneId &&
      !event.missionId &&
      context.focusedPaneId &&
      event.paneId !== context.focusedPaneId
    ) return false;

    this.seen.add(key);
    while (this.seen.size > MAX_SEEN) {
      const oldest = this.seen.values().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
    return true;
  }

  reset(): void {
    this.seen.clear();
  }
}
