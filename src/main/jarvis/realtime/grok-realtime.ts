import {
  DEFAULT_GROK_VOICE,
  DEFAULT_GROK_VOICE_MODEL,
} from '../../../shared/voice-config';
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
 *   transcreve (é justamente a aposta do Think Fast).
 */
export const GROK_REALTIME_URL = 'wss://api.x.ai/v1/realtime';

/** Vozes internas publicadas pela xAI. */
export const GROK_VOICES = ['rex', 'eve', 'ara'] as const;

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
