/** Closed analysis protocol: no functions, accounts, tokens or process authority. */
export const ANALYSIS_UNIT_BYTES = 65_536;
export const ANALYSIS_SESSION_BYTES = 262_144;
export const ANALYSIS_GLOBAL_BYTES = 4 * 1024 * 1024;
export const ANALYSIS_EVENT_CAP = 64;
export type AnalysisConsumer = 'screen' | 'dev-server' | 'failover' | 'completion' | 'handoff' | 'paste' | 'command' | 'pipe' | 'token' | 'prompt' | 'first-run' | 'mission-control';
export interface AnalysisFence {
  readonly workerEpoch: number;
  readonly sessionId: string;
  readonly generation: number;
  readonly eventSeq: number;
  readonly observedAt: number;
}
export interface AnalysisBinding { readonly adapterId?: string; readonly paneId?: string; readonly model?: string }
export type AnalysisInput = AnalysisFence & (
  | { readonly kind: 'bind'; readonly binding: AnalysisBinding }
  | { readonly kind: 'data'; readonly data: string }
  | { readonly kind: 'input'; readonly data: string }
  | { readonly kind: 'arm'; readonly consumer: AnalysisConsumer; readonly registration: number; readonly config?: unknown }
  | { readonly kind: 'disarm'; readonly consumer: AnalysisConsumer; readonly registration: number }
  | { readonly kind: 'control'; readonly consumer: AnalysisConsumer; readonly value: unknown }
  | { readonly kind: 'state'; readonly state: string }
  | { readonly kind: 'flush' | 'exit' | 'terminate' }
);
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
  readonly screenText?: string;
};
export type AnalysisWorkerMessage = AnalysisResult | { kind: 'ready' } | { kind: 'work-start'; workerEpoch: number; job: number; sessionId: string } | { kind: 'failed'; reason: string };
export function validAnalysisResult(value: unknown): value is AnalysisResult {
  if (!value || typeof value !== 'object') return false;
  const r = value as AnalysisResult;
  return r.kind === 'result' && typeof r.sessionId === 'string' && r.sessionId.length <= 512 &&
    Number.isSafeInteger(r.workerEpoch) && Number.isSafeInteger(r.generation) && Number.isSafeInteger(r.eventSeq) &&
    typeof r.observedAt === 'number' && Number.isFinite(r.observedAt) &&
    Number.isSafeInteger(r.ackBytes) && r.ackBytes >= 0 && r.ackBytes <= ANALYSIS_UNIT_BYTES &&
    Array.isArray(r.events) && r.events.length <= ANALYSIS_EVENT_CAP &&
    (r.screenText === undefined || (typeof r.screenText === 'string' && r.screenText.length <= 262_144));
}
