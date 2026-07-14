import type { MissionIntentEvent } from '../../shared/mission-intent';

/**
 * In-process telemetry for intent-first mission runtime.
 * Structured events are append-only for the session and mirrored to console.
 */

const MAX_EVENTS = 500;
const events: MissionIntentEvent[] = [];
const listeners = new Set<(event: MissionIntentEvent) => void>();

export function emitMissionIntentEvent(
  event: Omit<MissionIntentEvent, 'at'> & { at?: number },
): MissionIntentEvent {
  const full: MissionIntentEvent = Object.freeze({
    ...event,
    at: event.at ?? Date.now(),
    ...(event.meta ? { meta: Object.freeze({ ...event.meta }) } : {}),
  });
  events.push(full);
  if (events.length > MAX_EVENTS) {
    events.splice(0, events.length - MAX_EVENTS);
  }
  console.info(
    `[mission-intent] ${full.name}` +
      (full.missionId ? ` mission=${full.missionId}` : '') +
      (full.intentState ? ` state=${full.intentState}` : '') +
      (full.reason ? ` reason=${full.reason}` : ''),
  );
  for (const listener of listeners) {
    try {
      listener(full);
    } catch (error) {
      console.warn('[mission-intent] listener failed:', error);
    }
  }
  return full;
}

export function listMissionIntentEvents(): readonly MissionIntentEvent[] {
  return events.slice();
}

export function onMissionIntentEvent(
  listener: (event: MissionIntentEvent) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam — clears ring buffer between unit cases. */
export function resetMissionIntentEventsForTests(): void {
  events.length = 0;
  listeners.clear();
}
