/**
 * Parâmetros de STT do DITADO por turno (paridade ClockVoice, 06/08).
 *
 * O modo precisa viajar EXPLÍCITO no request: o default por plugin varia entre
 * os engines da cadeia (Groq translate:true; fallback OpenAI/local sem
 * translate ⇒ caía em PT literal dependendo de qual engine atendeu). Com o
 * request explícito, qualquer engine honra o modo configurado —
 * `req.translate` vence `plugin.translate` em stt-service.
 */
import { DICTATION_CODE_PRIMING_PROMPT } from '../../shared/dictation-vocabulary';

export type DictationOutputMode = 'english' | 'portuguese';

/**
 * Priming do "modo code" (paridade ClockVoice, 10/08): a tradução literal do
 * Whisper mutila jargão técnico ditado em PT ("comita e sobe pro worktree").
 * O prompt condiciona o decoder ao domínio — precisa ser em inglês (a API de
 * translations condiciona em prompts EN) e funciona como bias de vocabulário,
 * não como instrução seguida à risca.
 *
 * A LISTA de termos vive em `shared/dictation-vocabulary` porque o main monta
 * o `custom_vocabulary` do Gemini a partir da MESMA lista. Reexportado aqui
 * para os consumidores do renderer não precisarem saber disso.
 */
export { DICTATION_CODE_PRIMING_PROMPT };

export function dictationSttRequestParams(
  mode: DictationOutputMode | undefined,
): {
  translate: boolean;
  language: 'pt';
  prompt?: string;
  polish?: 'code-prompt';
} {
  // 'portuguese': transcrição literal, intocada — sem priming.
  if (mode === 'portuguese') return { translate: false, language: 'pt' };
  // 'english' (default ClockVoice): tradução otimizada para execução, e o main
  // reescreve como prompt em inglês para o agente — inclusive quando a STT só
  // transcreve (xAI).
  return {
    translate: true,
    language: 'pt',
    prompt: DICTATION_CODE_PRIMING_PROMPT,
    polish: 'code-prompt',
  };
}
