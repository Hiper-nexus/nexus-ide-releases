/**
 * Gemini as the second voice provider of the video studio (F-1601, study
 * §5.3 step 9): library voices and replicated voices through the Gemini API,
 * with the user's own key (the same GEMINI_API_KEY of the media services).
 *
 * Contracts read on 19/10/2026 (ai.google.dev/gemini-api/docs/voice-replication,
 * /speech-generation, /api/voices, /pricing):
 * - TTS: `POST /v1beta/interactions` with `response_format.type: audio` and
 *   `generation_config.speech_config[].voice` = a prebuilt name, `voice_…` or
 *   `voicekey_…`; the unary answer is a RIFF WAV (24 kHz mono 16-bit) in
 *   `steps[].content[]` of type `audio` (the Jarvis measured this on 23/09).
 *   The TTS gives NO word times: narration timing comes from the alignment
 *   (F-1602).
 * - Replication: `POST /v1beta/voices` with `store: true` and
 *   `voice.replicated.{source_audio, consent_audio}` ({mime_type, data}); the
 *   source is 10–30 s of the same adult speaker, the consent clip says the
 *   official sentence. Google verifies the speaker match itself.
 * - `GET /v1beta/voices?type=replicated`, `DELETE /v1beta/voices/{id}`.
 * - Price: audio output at 25 tokens per second, US$ 9 per million tokens for
 *   gemini-3.8-flash-tts until 31/12/2026, US$ 18 from 2027 (input text is
 *   cents per million and is ignored in the estimate).
 */

export const GEMINI_API = 'https://generativelanguage.googleapis.com';
export const GEMINI_TTS_MODEL = 'gemini-3.8-flash-tts';
export {
  VOICE_GEMINI_CONSENT_PHRASE as GEMINI_CONSENT_PHRASE_PT,
  VOICE_GEMINI_SAMPLE_MIN_SEC as GEMINI_SOURCE_MIN_SEC,
  VOICE_GEMINI_SAMPLE_MAX_SEC as GEMINI_SOURCE_MAX_SEC,
} from '../../../shared/voice-clone-types';
export const GEMINI_SAMPLE_RATE = 24_000;
/** Below the 8.192-token input limit of the TTS model, with margin. */
export const GEMINI_TTS_MAX_CHARS = 3_000;
const AUDIO_TOKENS_PER_SECOND = 25;
/** Measured speaking rate of pt-BR narration (~2.3 words/s): used only to price before synthesis. */
export const PT_CHARS_PER_SECOND = 14;

export const GEMINI_PREBUILT_VOICES = [
  'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe', 'Autonoe',
  'Enceladus', 'Iapetus', 'Umbriel', 'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi',
  'Laomedeia', 'Achernar', 'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird',
  'Zubenelgenubi', 'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat',
] as const;

const REPLICATED_ID = /^voice_[A-Za-z0-9_-]{1,128}$/u;

export function isGeminiReplicatedVoiceId(value: string): boolean {
  return REPLICATED_ID.test(value);
}

export function isGeminiVoice(value: string): boolean {
  return isGeminiReplicatedVoiceId(value) || (GEMINI_PREBUILT_VOICES as readonly string[]).includes(value);
}

/** USD per second of generated audio at the list price of the day. */
export function geminiTtsUsdPerSecond(now: Date = new Date()): number {
  const perMillion = now.getTime() >= Date.UTC(2027, 0, 1) ? 18 : 9;
  return (AUDIO_TOKENS_PER_SECOND * perMillion) / 1_000_000;
}

export function geminiTtsCostUsd(seconds: number, now: Date = new Date()): number {
  return Number((seconds * geminiTtsUsdPerSecond(now)).toFixed(4));
}

interface CallOptions {
  readonly key: string;
  readonly fetchFn: typeof fetch;
  readonly signal?: AbortSignal;
}

async function failure(res: Response, what: string): Promise<Error> {
  let message = '';
  try {
    const body = (await res.json()) as { error?: { message?: unknown; status?: unknown } };
    if (typeof body.error?.message === 'string') {
      // eslint-disable-next-line no-control-regex -- a mensagem do provedor vira uma linha só, sem controles
      message = body.error.message.replace(/[\u0000-\u001f]+/gu, ' ').slice(0, 240);
    }
  } catch {
    // unreadable body
  }
  if (res.status === 401 || res.status === 403) {
    return new Error(`O Gemini recusou a chave ao ${what} (HTTP ${res.status}). Confira a chave em Serviços de mídia.`);
  }
  if (res.status === 429) return new Error(`O Gemini limitou o pedido ao ${what} (cota). Tente de novo em instantes.`);
  return new Error(`O Gemini recusou ${what} (HTTP ${res.status})${message ? `: ${message}` : ''}.`);
}

/** WAV of the TTS answer: `steps[].content[]` with `type: 'audio'` (last one wins). */
export function extractInteractionAudio(payload: unknown): Buffer | null {
  const steps = (payload as { steps?: unknown })?.steps;
  if (!Array.isArray(steps)) return null;
  let found: string | null = null;
  for (const step of steps) {
    const content = (step as { content?: unknown })?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const item = part as { type?: unknown; data?: unknown };
      if (item?.type === 'audio' && typeof item.data === 'string' && item.data) found = item.data;
    }
  }
  return found ? Buffer.from(found, 'base64') : null;
}

export async function geminiTts(
  input: CallOptions & { readonly text: string; readonly voice: string; readonly style?: string; readonly model?: string },
): Promise<Buffer> {
  if (!isGeminiVoice(input.voice)) throw new Error(`voz do Gemini desconhecida: ${input.voice}`);
  const res = await input.fetchFn(`${GEMINI_API}/v1beta/interactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': input.key },
    signal: input.signal,
    body: JSON.stringify({
      model: input.model ?? GEMINI_TTS_MODEL,
      input: [
        {
          type: 'user_input',
          content: [
            {
              type: 'text',
              text: input.text,
              ...(input.style ? { annotations: [{ type: 'speech_metadata', style: input.style }] } : {}),
            },
          ],
        },
      ],
      response_format: { type: 'audio' },
      generation_config: { speech_config: [{ voice: input.voice }] },
    }),
  });
  if (!res.ok) throw await failure(res, 'gerar a narração');
  const wav = extractInteractionAudio(await res.json().catch(() => null));
  if (!wav || wav.toString('latin1', 0, 4) !== 'RIFF') throw new Error('o Gemini não devolveu áudio WAV');
  return wav;
}

export async function createGeminiReplicatedVoice(
  input: CallOptions & { readonly displayName: string; readonly sourceWav: Buffer; readonly consentWav: Buffer },
): Promise<{ id: string }> {
  const res = await input.fetchFn(`${GEMINI_API}/v1beta/voices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': input.key },
    signal: input.signal,
    body: JSON.stringify({
      store: true,
      voice: {
        model: GEMINI_TTS_MODEL,
        type: 'replicated',
        display_name: input.displayName,
        replicated: {
          source_audio: { mime_type: 'audio/wav', data: input.sourceWav.toString('base64') },
          consent_audio: { mime_type: 'audio/wav', data: input.consentWav.toString('base64') },
        },
      },
    }),
  });
  if (!res.ok) throw await failure(res, 'criar a voz');
  const body = (await res.json().catch(() => ({}))) as { id?: unknown };
  if (typeof body.id !== 'string' || !isGeminiReplicatedVoiceId(body.id)) {
    throw new Error('o Gemini não devolveu o id da voz criada');
  }
  return { id: body.id };
}

export async function deleteGeminiVoice(input: CallOptions & { readonly id: string }): Promise<void> {
  if (!isGeminiReplicatedVoiceId(input.id)) throw new Error('id de voz do Gemini inválido');
  const res = await input.fetchFn(`${GEMINI_API}/v1beta/voices/${encodeURIComponent(input.id)}`, {
    method: 'DELETE',
    headers: { 'x-goog-api-key': input.key },
    signal: input.signal,
  });
  // 404: already gone (deleted elsewhere) — nothing left to remove there.
  if (!res.ok && res.status !== 404) throw await failure(res, 'apagar a voz');
}

export interface GeminiVoiceInfo {
  readonly id: string;
  readonly displayName: string | null;
}

export async function listGeminiReplicatedVoices(input: CallOptions): Promise<GeminiVoiceInfo[]> {
  const voices: GeminiVoiceInfo[] = [];
  let pageToken = '';
  for (let page = 0; page < 10; page += 1) {
    const url = new URL(`${GEMINI_API}/v1beta/voices`);
    url.searchParams.set('type', 'replicated');
    url.searchParams.set('page_size', '200');
    if (pageToken) url.searchParams.set('page_token', pageToken);
    const res = await input.fetchFn(url, { headers: { 'x-goog-api-key': input.key }, signal: input.signal });
    if (!res.ok) throw await failure(res, 'listar as vozes');
    const body = (await res.json().catch(() => ({}))) as {
      voices?: Array<{ id?: unknown; display_name?: unknown; type?: unknown }>;
      next_page_token?: unknown;
    };
    for (const voice of body.voices ?? []) {
      if (voice.type !== 'replicated' || typeof voice.id !== 'string' || !isGeminiReplicatedVoiceId(voice.id)) continue;
      voices.push({ id: voice.id, displayName: typeof voice.display_name === 'string' ? voice.display_name.slice(0, 120) : null });
    }
    pageToken = typeof body.next_page_token === 'string' ? body.next_page_token : '';
    if (!pageToken) break;
  }
  return voices;
}

/** Speech-to-text of a short clip (the consent declaration) with the same key. */
export async function geminiTranscribe(input: CallOptions & { readonly wav: Uint8Array }): Promise<string> {
  const res = await input.fetchFn(`${GEMINI_API}/v1beta/models/gemini-3.5-flash:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': input.key },
    signal: input.signal,
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [
            { inline_data: { mime_type: 'audio/wav', data: Buffer.from(input.wav).toString('base64') } },
            {
              text:
                'Transcribe the audio verbatim in the language spoken (Brazilian Portuguese). Write numbers as ' +
                'spoken words or digits, exactly as heard. Output ONLY the transcript.',
            },
          ],
        },
      ],
      generationConfig: { temperature: 0 },
    }),
  });
  if (!res.ok) throw await failure(res, 'transcrever a declaração');
  const body = (await res.json().catch(() => ({}))) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }>;
  };
  return (body.candidates?.[0]?.content?.parts ?? [])
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join(' ')
    .trim();
}
