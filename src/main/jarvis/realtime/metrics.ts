import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type JarvisRealtimeMetric =
  | 'audio_in_to_transcript_delta_ms'
  | 'transcript_final_to_audio_out_ms'
  | 'roundtrip_ms';

export interface JarvisMetricRecord {
  ts: string;
  metric: JarvisRealtimeMetric;
  value: number;
  session_id: string;
}

export interface JarvisMetricsLoggerOptions {
  filePath?: string;
  now?: () => Date;
}

interface TurnTiming {
  audioInAt: number;
  firstTranscriptLogged: boolean;
  transcriptFinalAt: number | null;
  firstAudioOutAt: number | null;
  transcriptToAudioLogged: boolean;
}

const DEFAULT_METRICS_FILE = path.join(
  os.homedir(),
  'Library',
  'Logs',
  'NexusIDE',
  'jarvis-metrics.log',
);

export class JarvisMetricsLogger {
  private readonly filePath: string;
  private readonly now: () => Date;

  constructor(options: JarvisMetricsLoggerOptions = {}) {
    this.filePath = options.filePath ?? DEFAULT_METRICS_FILE;
    this.now = options.now ?? (() => new Date());
  }

  log(metric: JarvisRealtimeMetric, value: number, sessionId: string): JarvisMetricRecord {
    const record: JarvisMetricRecord = {
      ts: this.now().toISOString(),
      metric,
      value: Math.max(0, Math.round(value)),
      session_id: sessionId,
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

  markAudioIn(sessionId: string): void {
    if (this.turns.has(sessionId)) return;
    this.turns.set(sessionId, {
      audioInAt: this.nowMs(),
      firstTranscriptLogged: false,
      transcriptFinalAt: null,
      firstAudioOutAt: null,
      transcriptToAudioLogged: false,
    });
  }

  markTranscript(sessionId: string, final: boolean): void {
    const turn = this.turns.get(sessionId);
    if (!turn) return;
    const now = this.nowMs();
    if (!turn.firstTranscriptLogged) {
      this.logger.log(
        'audio_in_to_transcript_delta_ms',
        now - turn.audioInAt,
        sessionId,
      );
      turn.firstTranscriptLogged = true;
    }
    if (final) {
      turn.transcriptFinalAt = now;
      this.maybeLogTranscriptToAudio(sessionId, turn);
    }
  }

  markAudioOut(sessionId: string): void {
    const turn = this.turns.get(sessionId);
    if (!turn) return;
    if (turn.firstAudioOutAt === null) {
      turn.firstAudioOutAt = this.nowMs();
      this.maybeLogTranscriptToAudio(sessionId, turn);
    }
  }

  markResponseDone(sessionId: string): void {
    const turn = this.turns.get(sessionId);
    if (!turn) return;
    this.logger.log('roundtrip_ms', this.nowMs() - turn.audioInAt, sessionId);
    this.turns.delete(sessionId);
  }

  private maybeLogTranscriptToAudio(sessionId: string, turn: TurnTiming): void {
    if (turn.transcriptFinalAt === null || turn.firstAudioOutAt === null) return;
    if (turn.transcriptToAudioLogged) return;
    turn.transcriptToAudioLogged = true;
    this.logger.log(
      'transcript_final_to_audio_out_ms',
      turn.firstAudioOutAt - turn.transcriptFinalAt,
      sessionId,
    );
  }
}

export const jarvisMetricsLogger = new JarvisMetricsLogger();
export const jarvisLatencyTracker = new JarvisLatencyTracker(jarvisMetricsLogger);
