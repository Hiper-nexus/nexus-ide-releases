/**
 * F-1392 — resumo de UMA sessão de ditado para o log de uso (`dictation-session`
 * no lifecycle do main). Puro: o ramo de ditado de voice-finish-and-process
 * chama `dictationSessionData` em cada saída (ok, vazio, erro).
 *
 * Só metadados: modo, provider/modelo da STT, idioma, duração do áudio,
 * latência até o texto, tamanhos do bruto e do entregue, se a reescrita do
 * CODE rodou, resultado e código do erro. NUNCA o texto ditado nem o áudio.
 */
import type { TranscribeResult } from '../../shared/voice-ipc';
import type { DictationOutputMode } from './dictation-output-mode';

export type DictationSessionResult = 'ok' | 'empty' | 'error' | 'cancelled';

export interface DictationSessionDraft {
  readonly outputMode: DictationOutputMode | undefined;
  readonly language: string;
  readonly audioSec: number;
  /** Fim da fala (captura parada) — a latência é medida a partir daqui. */
  readonly speechEndedAt: number;
}

export interface DictationSessionOutcome {
  readonly result: DictationSessionResult;
  readonly errorCode?: string;
  readonly stt?: TranscribeResult | null;
  /** Tamanho do texto entregue (depois da reescrita), quando houve texto. */
  readonly deliveredChars?: number;
}

export function dictationSessionData(
  draft: DictationSessionDraft,
  outcome: DictationSessionOutcome,
  now: number,
): Record<string, string | number | boolean> {
  const stt = outcome.stt ?? null;
  const ok = stt?.ok === true ? stt : null;
  const data: Record<string, string | number | boolean> = {
    mode: draft.outputMode === 'portuguese' ? 'plain' : 'code',
    language: draft.language,
    audioMs: Math.max(0, Math.round(draft.audioSec * 1000)),
    latencyMs: Math.max(0, now - draft.speechEndedAt),
    polished: ok?.polish?.ok === true,
    result: outcome.result,
  };
  if (ok) {
    data.sttProvider = ok.provider;
    if (ok.model) data.sttModel = ok.model;
    data.rawChars = ok.polish?.rawChars ?? ok.text.length;
  }
  if (outcome.deliveredChars !== undefined) data.polishedChars = outcome.deliveredChars;
  if (outcome.errorCode) data.errorCode = outcome.errorCode;
  return data;
}

/** Código curto e estável do erro de STT (o texto livre fica no voice.log). */
export function sttErrorCode(stt: Extract<TranscribeResult, { ok: false }>): string {
  if (stt.needsKey) return 'stt-needs-key';
  if (/\b429\b|throttl|rate.?limit/i.test(stt.error)) return 'stt-throttled';
  if (/timeout|timed out/i.test(stt.error)) return 'stt-timeout';
  return 'stt-failed';
}
