/**
 * Parâmetros de STT do DITADO por turno (paridade ClockVoice, 06/08).
 *
 * O modo precisa viajar EXPLÍCITO no request: o default por plugin varia entre
 * os engines da cadeia (Groq translate:true; fallback OpenAI/local sem
 * translate ⇒ caía em PT literal dependendo de qual engine atendeu). Com o
 * request explícito, qualquer engine honra o modo configurado —
 * `req.translate` vence `plugin.translate` em stt-service.
 */
import {
  DICTATION_CODE_LITERAL_PRIMING_PROMPT,
  DICTATION_CODE_PRIMING_PROMPT,
} from '../../shared/dictation-vocabulary';

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
export { DICTATION_CODE_LITERAL_PRIMING_PROMPT, DICTATION_CODE_PRIMING_PROMPT };

/** Chaves que atendem a reescrita do ditado CODE (main/voice/code-prompt-polish). */
export const CODE_POLISH_KEY_ENV_VARS: ReadonlySet<string> = new Set([
  'GEMINI_API_KEY',
  'OPENAI_API_KEY',
  'GROQ_API_KEY',
  'XAI_API_KEY',
]);

/** Há modelo de texto para a reescrita do CODE (presença de chave, nunca o valor). */
export function codePolishAvailable(
  keys: ReadonlyArray<{ envVar: string; hasEnv: boolean; hasStoredKey: boolean }> | undefined,
): boolean {
  return (keys ?? []).some(
    (key) =>
      CODE_POLISH_KEY_ENV_VARS.has(key.envVar) && (key.hasEnv || key.hasStoredKey),
  );
}

export function dictationSttRequestParams(
  mode: DictationOutputMode | undefined,
  options: { readonly polishAvailable?: boolean } = {},
): {
  translate: boolean;
  language: 'pt';
  prompt?: string;
  polish?: 'code-prompt';
} {
  // 'portuguese': transcrição literal, intocada — sem priming.
  if (mode === 'portuguese') return { translate: false, language: 'pt' };
  // 'english' (CODE) com reescrita disponível: a STT transcreve LITERAL e a
  // reescrita traduz uma vez só, a partir do português original. Pedir
  // tradução à STT e depois reescrever de novo eram duas chamadas de modelo
  // em série (5,8–8,2 s de espera medidos em 23/09) e a reescrita recebia um
  // texto já traduzido em vez do que foi dito.
  if (options.polishAvailable) {
    return {
      translate: false,
      language: 'pt',
      prompt: DICTATION_CODE_LITERAL_PRIMING_PROMPT,
      polish: 'code-prompt',
    };
  }
  // Sem chave de modelo de texto: a própria STT traduz (quando o provider
  // traduz) e a reescrita segue pedida — falha sozinha e devolve a tradução.
  return {
    translate: true,
    language: 'pt',
    prompt: DICTATION_CODE_PRIMING_PROMPT,
    polish: 'code-prompt',
  };
}
