/**
 * F-1392 — log de uso do ditado. Cada sessão de ditado vira UM evento
 * `dictation-session` no trace do main e no histórico `lifecycle-*.ndjson`,
 * para responder "quando e por que a transcrição falha".
 *
 * Fronteira de privacidade: o renderer manda o resumo pelo canal de log de
 * voz, mas só o que esta lista branca aceita chega ao disco — rótulos curtos,
 * números e um booleano. Texto ditado e áudio nunca passam (um campo extra,
 * ou um rótulo com espaço, é descartado).
 */
export const DICTATION_SESSION_EVENT = 'dictation.session';
export const DICTATION_SESSION_KIND = 'dictation-session';

// F-1392 (revisão Fable): modelo `org/modelo` precisa do `/`; `:` já era
// aceito. Sem espaço nem controle, teto de 64 caracteres mantido.
const LABEL_RE = /^[a-z][a-z0-9:._/-]{0,63}$/i;
const LABEL_KEYS = ['mode', 'sttProvider', 'sttModel', 'language', 'result', 'errorCode'] as const;
const NUMBER_KEYS = ['audioMs', 'latencyMs', 'rawChars', 'polishedChars'] as const;
const BOOLEAN_KEYS = ['polished'] as const;
const RESULTS: ReadonlySet<string> = new Set(['ok', 'queued', 'pending', 'empty', 'error', 'cancelled']);

export type DictationSessionTraceEvent = Record<string, string | number | boolean> & {
  kind: typeof DICTATION_SESSION_KIND;
  result: string;
};

export function dictationSessionTraceEvent(raw: unknown): DictationSessionTraceEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Record<string, unknown>;
  if (typeof data.result !== 'string' || !RESULTS.has(data.result)) return null;
  const out: Record<string, string | number | boolean> = { kind: DICTATION_SESSION_KIND };
  for (const key of LABEL_KEYS) {
    const value = data[key];
    if (typeof value === 'string' && LABEL_RE.test(value)) out[key] = value;
  }
  for (const key of NUMBER_KEYS) {
    const value = data[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      out[key] = Math.round(value);
    }
  }
  for (const key of BOOLEAN_KEYS) {
    const value = data[key];
    if (typeof value === 'boolean') out[key] = value;
  }
  return out as DictationSessionTraceEvent;
}
