/** Closed analysis protocol: no functions, accounts, tokens or process authority. */
export const ANALYSIS_UNIT_BYTES = 65_536;
export const ANALYSIS_SESSION_BYTES = 262_144;
export const ANALYSIS_GLOBAL_BYTES = 4 * 1024 * 1024;
export const ANALYSIS_EVENT_CAP = 64;
/** Teto de chars da tela retida por sessão (worker e espelho do Main). */
export const ANALYSIS_SCREEN_CHARS = 262_144;
export type AnalysisConsumer = 'screen' | 'dev-server' | 'failover' | 'completion' | 'handoff' | 'paste' | 'command' | 'pipe' | 'token' | 'prompt' | 'first-run' | 'mission-control';
export interface AnalysisFence {
  readonly workerEpoch: number;
  readonly sessionId: string;
  readonly generation: number;
  readonly eventSeq: number;
  readonly observedAt: number;
}
export interface AnalysisBinding { readonly adapterId?: string; readonly paneId?: string; readonly model?: string }
export type AnalysisInput = AnalysisFence & { readonly watchdogToken?: number } & (
  | { readonly kind: 'bind'; readonly binding: AnalysisBinding }
  | { readonly kind: 'data'; readonly data: string; readonly endOfChunk?: boolean; readonly pieces?: readonly { chars: number; at: number }[] }
  | { readonly kind: 'input'; readonly data: string }
  | { readonly kind: 'arm'; readonly consumer: AnalysisConsumer; readonly registration: number; readonly config?: unknown }
  | { readonly kind: 'disarm'; readonly consumer: AnalysisConsumer; readonly registration: number }
  | { readonly kind: 'control'; readonly consumer: AnalysisConsumer; readonly value: unknown }
  | { readonly kind: 'state'; readonly state: string }
  /** PTY winsize, ordered with the data so the grid reflows at the right byte. */
  | { readonly kind: 'resize'; readonly cols: number; readonly rows: number }
  | { readonly kind: 'flush' | 'exit' | 'terminate' }
);
/** Same ceiling the detector grid clamps to; anything else is dropped. */
export function validAnalysisGrid(cols: unknown, rows: unknown): boolean {
  return Number.isSafeInteger(cols) && Number.isSafeInteger(rows) &&
    (cols as number) >= 1 && (cols as number) <= 1_000 && (rows as number) >= 1 && (rows as number) <= 500;
}
/** The only trace a Worker may raise; Main re-validates before tracing. */
export interface AnalysisWorkerTrace { readonly kind: 'detector-ghostty-unavailable'; readonly reason: string; readonly detail: string }
export function validWorkerTrace(value: unknown): AnalysisWorkerTrace | null {
  const t = value as Partial<AnalysisWorkerTrace> | null;
  if (!t || typeof t !== 'object' || t.kind !== 'detector-ghostty-unavailable') return null;
  if (typeof t.reason !== 'string' || !/^[a-z-]{1,32}$/.test(t.reason)) return null;
  return { kind: t.kind, reason: t.reason, detail: typeof t.detail === 'string' ? t.detail.slice(0, 64) : '' };
}
export interface AnalysisEvent {
  readonly consumer: AnalysisConsumer;
  readonly registration: number;
  readonly value: unknown;
  /** Only read-only final evidence may be accepted for a sealed generation. */
  readonly archival?: boolean;
}
export type AnalysisResult = AnalysisFence & {
  readonly kind: 'result';
  readonly events: readonly AnalysisEvent[];
  readonly ackBytes: number;
  readonly done?: boolean;
  /** Tela inteira do worker (substitui o espelho do Main): só quando o delta não cabe. */
  readonly screenText?: string;
  /** Texto de tela NOVO desde o snapshot anterior; o Main anexa e mantém o teto. */
  readonly screenAppend?: string;
};
export type AnalysisWorkerMessage = AnalysisResult | { kind: 'ready' } | { kind: 'trace'; event: AnalysisWorkerTrace } | { kind: 'work-start'; workerEpoch: number; job: number; sessionId: string; watchdogToken?: number; activityToken?: number; manifestId?: string } | { kind: 'work-end'; watchdogToken?: number; activityToken?: number } | { kind: 'failed'; reason: string };
const CONSUMERS = new Set<AnalysisConsumer>(['screen', 'dev-server', 'failover', 'completion', 'handoff', 'paste', 'command', 'pipe', 'token', 'prompt', 'first-run', 'mission-control']);
export function validAnalysisResult(value: unknown): value is AnalysisResult {
  if (!value || typeof value !== 'object') return false;
  const r = value as AnalysisResult;
  return r.kind === 'result' && typeof r.sessionId === 'string' && r.sessionId.length <= 512 &&
    Number.isSafeInteger(r.workerEpoch) && Number.isSafeInteger(r.generation) && Number.isSafeInteger(r.eventSeq) &&
    typeof r.observedAt === 'number' && Number.isFinite(r.observedAt) &&
    Number.isSafeInteger(r.ackBytes) && r.ackBytes >= 0 && r.ackBytes <= ANALYSIS_UNIT_BYTES &&
    Array.isArray(r.events) && r.events.length <= ANALYSIS_EVENT_CAP && r.events.every((event) => event && CONSUMERS.has(event.consumer) && Number.isSafeInteger(event.registration) && event.registration > 0 && (event.archival === undefined || typeof event.archival === 'boolean')) &&
    (r.screenText === undefined || (typeof r.screenText === 'string' && r.screenText.length <= ANALYSIS_SCREEN_CHARS)) &&
    (r.screenAppend === undefined || (typeof r.screenAppend === 'string' && r.screenAppend.length <= ANALYSIS_SCREEN_CHARS && r.screenText === undefined));
}
