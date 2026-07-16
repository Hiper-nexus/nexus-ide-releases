export type VoiceTurnMilestone =
  | 'wake'
  | 'speech_start'
  | 'speech_end'
  | 'turn_committed'
  | 'first_tool_call'
  | 'effect_confirmed'
  | 'first_audio';

export interface VoiceTurnMilestoneRecord {
  readonly turnId: string;
  readonly milestone: VoiceTurnMilestone;
  readonly timestamp: string;
  readonly timestampMs: number;
  readonly deltaFromWakeMs: number;
  readonly deltaFromPreviousMs: number;
}

interface VoiceTurnTiming {
  readonly wakeAt: number;
  previousAt: number;
  readonly milestones: Set<VoiceTurnMilestone>;
}

const MAX_TRACKED_TURNS = 128;

export class VoiceTurnTimeline {
  private readonly turns = new Map<string, VoiceTurnTiming>();

  constructor(private readonly now: () => number = Date.now) {}

  mark(
    rawTurnId: string,
    milestone: VoiceTurnMilestone,
  ): VoiceTurnMilestoneRecord | null {
    const turnId = rawTurnId.trim().slice(0, 128);
    if (!turnId) return null;
    const timestampMs = this.now();
    let timing = this.turns.get(turnId);
    if (!timing) {
      timing = {
        wakeAt: timestampMs,
        previousAt: timestampMs,
        milestones: new Set(),
      };
      this.turns.set(turnId, timing);
      if (this.turns.size > MAX_TRACKED_TURNS) {
        this.turns.delete(this.turns.keys().next().value!);
      }
    }
    if (timing.milestones.has(milestone)) return null;
    const record = Object.freeze({
      turnId,
      milestone,
      timestamp: new Date(timestampMs).toISOString(),
      timestampMs,
      deltaFromWakeMs: Math.max(0, timestampMs - timing.wakeAt),
      deltaFromPreviousMs: Math.max(0, timestampMs - timing.previousAt),
    });
    timing.milestones.add(milestone);
    timing.previousAt = timestampMs;
    return record;
  }
}

export const voiceTurnTimeline = new VoiceTurnTimeline();

export function logVoiceTurnMilestone(
  turnId: string,
  milestone: VoiceTurnMilestone,
  context: Readonly<Record<string, unknown>> = {},
): void {
  const record = voiceTurnTimeline.mark(turnId, milestone);
  if (!record) return;
  try {
    window.nexus.voice.logVoice({
      level: 'info',
      event: `voice.turn.${milestone}`,
      msg: milestone,
      data: { ...context, ...record },
    });
  } catch {
    // Telemetria nunca interfere na máquina de estados de áudio.
  }
}
