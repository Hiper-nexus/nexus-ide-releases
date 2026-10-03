/** Private Main authority only. Hooks cannot supply a mission or its transition time. */
export interface MimoMissionTimeline {
  readonly startedAt: number;
  readonly transitions: Array<{ readonly at: number; readonly missionId?: string }>;
}
const timelines = new Map<string, MimoMissionTimeline>();
export function beginMimoMissionAuthority(ptySessionId: string, missionId?: string): MimoMissionTimeline {
  const startedAt = Date.now();
  const timeline = { startedAt, transitions: [{ at: startedAt, missionId }] };
  timelines.set(ptySessionId, timeline); return timeline;
}
export function forgetMimoMissionAuthority(ptySessionId: string): void { timelines.delete(ptySessionId); }
export function noteMimoMissionAuthority(ptySessionId: string, missionId?: string): void {
  const timeline = timelines.get(ptySessionId);
  if (!timeline || timeline.transitions.at(-1)?.missionId === missionId) return;
  timeline.transitions.push({ at: Math.max(Date.now(), timeline.transitions.at(-1)!.at), missionId });
}
/** Native message.time.created is an epoch-ms timestamp; rewrites retain this start. */
export function mimoMessageMission(timeline: MimoMissionTimeline, createdAt: number): { known: boolean; missionId?: string } {
  for (let i = timeline.transitions.length - 1; i >= 0; i--) {
    const transition = timeline.transitions[i]!;
    if (createdAt >= transition.at) return { known: true, missionId: transition.missionId };
  }
  // Before this process saw the runtime, there is no Main mission/pane proof.
  return { known: false };
}
