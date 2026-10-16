import {
  DEFAULT_GROK_VOICE,
  DEFAULT_GROK_VOICE_MODEL,
} from '../../../shared/voice-config';
import { DICTATION_ENGINE_VOCABULARY } from '../../../shared/dictation-vocabulary';
import {
  OpenAIRealtimeProvider,
  type OpenAIRealtimeProviderOptions,
  type SessionUpdateBuilder,
} from './openai-realtime';

/**
 * Grok Voice (xAI) como transporte realtime.
 *
 * A xAI publica uma superfície Realtime-compatível: mesmo `Authorization:
 * Bearer`, mesmo vocabulário de eventos (`session.created`,
 * `input_audio_buffer.*`, `response.*`) e mesmo transporte binário de áudio.
 * Por isso este arquivo NÃO reimplementa o provider — reaproveita todo o
 * transporte já testado do OpenAIRealtimeProvider e injeta apenas as duas
 * coisas que divergem: o host e o formato do `session.update`.
 *
 * Divergências do dialeto (doc oficial da xAI):
 * - `voice` e `turn_detection` ficam na RAIZ da sessão; na OpenAI eles moram em
 *   `audio.output.voice` e `audio.input.turn_detection`.
 * - o VAD é `server_vad`; a OpenAI usa `semantic_vad`.
 * - não existe modelo de transcrição separado — o próprio modelo de voz
 *   transcreve (é justamente a aposta do Think Fast). A xAI só aceita ajustar
 *   a transcrição em `audio.input.transcription` (`language_hint`, `keyterms`);
 *   `input_audio_transcription: { model: 'whisper-…' }` é campo da OpenAI e
 *   NÃO existe na superfície da xAI (docs.x.ai/docs/guides/voice/agent,
 *   conferido em 15/10/2026), então nunca vai no session.update.
 */
export const GROK_REALTIME_URL = 'wss://api.x.ai/v1/realtime';

/**
 * A xAI só aceita variante regional para pt/es: o `pt` cru é ignorado em
 * silêncio e cai na detecção automática (que erra comando curto em português).
 */
export const GROK_TRANSCRIPTION_LANGUAGE_HINT = 'pt-BR';
/** Limites documentados: até 100 termos, 50 caracteres cada. */
const GROK_KEYTERMS_MAX = 100;
const GROK_KEYTERM_MAX_CHARS = 50;

/**
 * Vocabulário que o reconhecedor costuma mutilar quando o operador fala com a
 * Jarvis (a mesma lista dos engines de ditado + os nomes da própria conversa).
 */
export function grokTranscriptionKeyterms(): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of [
    'Jarvis',
    'Nexus IDE',
    'missão',
    'orquestrador',
    ...DICTATION_ENGINE_VOCABULARY,
  ]) {
    const term = raw.trim();
    const key = term.toLowerCase();
    if (!term || term.length > GROK_KEYTERM_MAX_CHARS || seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length >= GROK_KEYTERMS_MAX) break;
  }
  return terms;
}

/**
 * Vozes publicadas pela xAI para a rota Grok Voice. Uma voz fora desta lista é
 * recusada na conexão e a sessão morre sem voz.
 */
export const GROK_VOICES = ['ara', 'eve', 'leo', 'rex', 'sal'] as const;

/** 24 kHz casa com o OUTPUT_SAMPLE_RATE do LiveAudioPlayer do renderer. */
const GROK_TARGET_RATE = 24_000;

export const buildGrokSessionUpdate: SessionUpdateBuilder = (opts) => {
  const tools = opts.tools ?? [];
  const turnDetection = opts.turnDetection ?? 'semantic_vad';
  return {
    type: 'session.update',
    session: {
      model: opts.model,
      instructions: opts.instructions,
      voice: opts.voice,
      // `manual` desliga o VAD do servidor para o push-to-talk decidir o turno,
      // exatamente como na rota OpenAI.
      turn_detection:
        turnDetection === 'manual' ? null : { type: 'server_vad' },
      audio: {
        input: {
          format: {
            type: 'audio/pcm',
            rate: opts.inputRate ?? GROK_TARGET_RATE,
          },
          // Transcrição da fala do operador (evento
          // `conversation.item.input_audio_transcription.completed`): o viés de
          // idioma e de vocabulário melhora comando curto em português.
          transcription: {
            language_hint: GROK_TRANSCRIPTION_LANGUAGE_HINT,
            keyterms: grokTranscriptionKeyterms(),
          },
        },
        output: {
          format: {
            type: 'audio/pcm',
            rate: GROK_TARGET_RATE,
          },
        },
      },
      ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
    },
  };
};

export type GrokRealtimeProviderOptions = Omit<
  OpenAIRealtimeProviderOptions,
  'realtimeUrl' | 'sessionUpdateBuilder'
>;

export function createGrokRealtimeProvider(
  options: GrokRealtimeProviderOptions,
): OpenAIRealtimeProvider {
  return new OpenAIRealtimeProvider({
    ...options,
    model: options.model ?? DEFAULT_GROK_VOICE_MODEL,
    voice: options.voice ?? DEFAULT_GROK_VOICE,
    realtimeUrl: GROK_REALTIME_URL,
    sessionUpdateBuilder: buildGrokSessionUpdate,
  });
}
