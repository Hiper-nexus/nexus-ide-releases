/**
 * Parâmetros de STT do DITADO por turno (paridade ClockVoice, 06/08).
 *
 * O modo precisa viajar EXPLÍCITO no request: o default por plugin varia entre
 * os engines da cadeia (Groq translate:true; fallback OpenAI/local sem
 * translate ⇒ caía em PT literal dependendo de qual engine atendeu). Com o
 * request explícito, qualquer engine honra o modo configurado —
 * `req.translate` vence `plugin.translate` em stt-service.
 */
export type DictationOutputMode = 'english' | 'portuguese';

export function dictationSttRequestParams(
  mode: DictationOutputMode | undefined,
): { translate: boolean; language: 'pt' } {
  // 'english' (default ClockVoice): tradução otimizada para execução.
  // 'portuguese': transcrição literal.
  return { translate: mode !== 'portuguese', language: 'pt' };
}
