import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type JarvisRealtimeMetric =
  | 'audio_in_to_transcript_delta_ms'
  | 'transcript_final_to_action_ms'
  | 'transcript_final_to_audio_out_ms'
  | 'roundtrip_ms';

export interface JarvisMetricRecord {
  ts: string;
  metric: JarvisRealtimeMetric;
  value: number;
  session_id: string;
  /** Renderer turn token when the provider can correlate the event. */
  turn_id?: string;
}

export interface JarvisMetricsLoggerOptions {
  filePath?: string;
  now?: () => Date;
}

interface TurnTiming {
  audioInAt: number;
  hasAudioInput: boolean;
  firstTranscriptLogged: boolean;
  transcriptFinalAt: number | null;
  firstActionAt: number | null;
  firstAudioOutAt: number | null;
  transcriptToActionLogged: boolean;
  transcriptToAudioLogged: boolean;
}

const DEFAULT_METRICS_FILE = path.join(
  os.homedir(),
  'Library',
  'Logs',
  'NexusIDE',
  'jarvis-metrics.log',
);

function resolveMetricsFile(): string {
  return process.env.NEXUS_JARVIS_METRICS_FILE?.trim() || DEFAULT_METRICS_FILE;
}

export class JarvisMetricsLogger {
  private readonly filePath: string;
  private readonly now: () => Date;

  constructor(options: JarvisMetricsLoggerOptions = {}) {
    this.filePath = options.filePath ?? resolveMetricsFile();
    this.now = options.now ?? (() => new Date());
  }

  log(
    metric: JarvisRealtimeMetric,
    value: number,
    sessionId: string,
    turnId?: string,
  ): JarvisMetricRecord {
    const record: JarvisMetricRecord = {
      ts: this.now().toISOString(),
      metric,
      value: Math.max(0, Math.round(value)),
      session_id: sessionId,
      ...(turnId ? { turn_id: turnId } : {}),
    };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, 'utf-8');
    return record;
  }
}

export class JarvisLatencyTracker {
  private readonly turns = new Map<string, TurnTiming>();

  constructor(
    private readonly logger: JarvisMetricsLogger,
    private readonly nowMs: () => number = Date.now,
  ) {}

  markAudioIn(sessionId: string, turnId?: string): void {
    const key = this.turnKey(sessionId, turnId);
    if (this.turns.has(key)) return;
    this.turns.set(key, {
      audioInAt: this.nowMs(),
      hasAudioInput: true,
      firstTranscriptLogged: false,
      transcriptFinalAt: null,
      firstActionAt: null,
      firstAudioOutAt: null,
      transcriptToActionLogged: false,
      transcriptToAudioLogged: false,
    });
  }

  markTranscript(sessionId: string, final: boolean, turnId?: string): void {
    const now = this.nowMs();
    const key = this.turnKey(sessionId, turnId);
    const turn = this.turns.get(key);
    if (!turn) {
      if (!final) return;
      this.turns.set(key, {
        audioInAt: now,
        hasAudioInput: false,
        firstTranscriptLogged: true,
        transcriptFinalAt: now,
        firstActionAt: null,
        firstAudioOutAt: null,
        transcriptToActionLogged: false,
        transcriptToAudioLogged: false,
      });
      return;
    }
    if (!turn.firstTranscriptLogged) {
      this.logger.log(
        'audio_in_to_transcript_delta_ms',
        now - turn.audioInAt,
        sessionId,
        turnId,
      );
      turn.firstTranscriptLogged = true;
    }
    if (final) {
      turn.transcriptFinalAt = now;
      this.maybeLogTranscriptToAction(sessionId, turn, turnId);
      this.maybeLogTranscriptToAudio(sessionId, turn, turnId);
    }
  }

  markAction(sessionId: string, turnId?: string): void {
    const turn = this.turns.get(this.turnKey(sessionId, turnId));
    if (!turn) return;
    if (turn.firstActionAt === null) {
      turn.firstActionAt = this.nowMs();
      this.maybeLogTranscriptToAction(sessionId, turn, turnId);
    }
  }

  markAudioOut(sessionId: string, turnId?: string): void {
    const turn = this.turns.get(this.turnKey(sessionId, turnId));
    if (!turn) return;
    if (turn.firstAudioOutAt === null) {
      turn.firstAudioOutAt = this.nowMs();
      this.maybeLogTranscriptToAudio(sessionId, turn, turnId);
    }
  }

  markResponseDone(sessionId: string, turnId?: string): void {
    const key = this.turnKey(sessionId, turnId);
    const turn = this.turns.get(key);
    if (!turn) return;
    if (turn.hasAudioInput) {
      this.logger.log(
        'roundtrip_ms',
        this.nowMs() - turn.audioInAt,
        sessionId,
        turnId,
      );
    }
    this.turns.delete(key);
  }

  /** Drops an interrupted/obsolete turn without allowing it to leak into the next one. */
  discard(sessionId: string, turnId?: string): void {
    this.turns.delete(this.turnKey(sessionId, turnId));
  }

  private maybeLogTranscriptToAudio(
    sessionId: string,
    turn: TurnTiming,
    turnId?: string,
  ): void {
    if (turn.transcriptFinalAt === null || turn.firstAudioOutAt === null) return;
    if (turn.transcriptToAudioLogged) return;
    turn.transcriptToAudioLogged = true;
    this.logger.log(
      'transcript_final_to_audio_out_ms',
      turn.firstAudioOutAt - turn.transcriptFinalAt,
      sessionId,
      turnId,
    );
  }

  private maybeLogTranscriptToAction(
    sessionId: string,
    turn: TurnTiming,
    turnId?: string,
  ): void {
    if (turn.transcriptFinalAt === null || turn.firstActionAt === null) return;
    if (turn.transcriptToActionLogged) return;
    turn.transcriptToActionLogged = true;
    this.logger.log(
      'transcript_final_to_action_ms',
      turn.firstActionAt - turn.transcriptFinalAt,
      sessionId,
      turnId,
    );
  }

  private turnKey(sessionId: string, turnId?: string): string {
    return `${sessionId}\u0000${turnId ?? ''}`;
  }
}

export const jarvisMetricsLogger = new JarvisMetricsLogger();
export const jarvisLatencyTracker = new JarvisLatencyTracker(jarvisMetricsLogger);
