/**
 * ElevenLabs live check for the video studio (F-1591/F-1592/F-1593).
 *
 * Run it in YOUR terminal, with your key only in that process:
 *
 *   ELEVENLABS_API_KEY=... npx tsx scripts/elevenlabs-live-check.mts
 *   (PowerShell: $env:ELEVENLABS_API_KEY='...'; npx tsx scripts/elevenlabs-live-check.mts)
 *
 * Optional: VOICE_ID (default Rachel), WITH_MUSIC=1 (adds a 5 s instrumental,
 * ~US$ 0.0125). It answers what the docs do not say:
 *   1. which models return per-character timing on /with-timestamps
 *      (the study §2.1 left eleven_v4 as a mandatory test);
 *   2. whether Scribe v2 transcribes Portuguese for the consent check;
 *   3. (WITH_MUSIC=1) whether music_v2_5 accepts force_instrumental + C2PA.
 * Cost: ~240 characters of TTS (≤ US$ 0.02) + a few seconds of STT.
 * The key is never printed and nothing is written to disk.
 */
const key = process.env.ELEVENLABS_API_KEY?.trim();
if (!key) {
  console.error('Defina ELEVENLABS_API_KEY neste terminal antes de rodar.');
  process.exit(2);
}
const voiceId = process.env.VOICE_ID?.trim() || '21m00Tcm4TlvDq8ikWAM';
const API = 'https://api.elevenlabs.io';
const TEXT = 'O Claude abre panes. O Gemini revisa. Código 4 7 1 9.';
const MODELS = ['eleven_v4', 'eleven_flash_v2_5', 'eleven_multilingual_v2', 'eleven_v3'];

async function detail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: unknown };
    const value = body.detail;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      return String(record.status ?? '') + ' ' + String(record.message ?? '').slice(0, 160);
    }
    return JSON.stringify(value).slice(0, 160);
  } catch {
    return '';
  }
}

const results: Record<string, unknown>[] = [];
let sampleAudio: Buffer | null = null;
{
  for (const model of MODELS) {
    const url = `${API}/v1/text-to-speech/${voiceId}/with-timestamps?output_format=mp3_44100_128`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({ text: TEXT, model_id: model }),
    });
    if (!res.ok) {
      results.push({ model, http: res.status, timing: false, detail: await detail(res) });
      continue;
    }
    const body = (await res.json()) as {
      audio_base64?: string;
      alignment?: { characters?: string[]; character_end_times_seconds?: number[] } | null;
      normalized_alignment?: unknown;
    };
    const chars = body.alignment?.characters?.length ?? 0;
    const lastEnd = body.alignment?.character_end_times_seconds?.at(-1) ?? null;
    const sameText = (body.alignment?.characters ?? []).join('') === TEXT;
    const audio = Buffer.from(body.audio_base64 ?? '', 'base64');
    if (!sampleAudio && audio.length > 0) sampleAudio = audio;
    results.push({
      model,
      http: res.status,
      timing: chars > 0,
      alignedChars: chars,
      textChars: TEXT.length,
      alignmentEqualsScript: sameText,
      lastCharEndSec: lastEnd,
      audioBytes: audio.length,
    });
  }
  console.log('\n1) /with-timestamps por modelo');
  console.table(results);

  if (sampleAudio) {
    const form = new FormData();
    form.set('model_id', 'scribe_v2');
    form.set('language_code', 'pt');
    form.set('file', new Blob([sampleAudio], { type: 'audio/mpeg' }), 'amostra.mp3');
    const res = await fetch(`${API}/v1/speech-to-text`, {
      method: 'POST',
      headers: { 'xi-api-key': key },
      body: form,
    });
    const body = res.ok ? ((await res.json()) as { text?: string; language_code?: string }) : null;
    console.log('\n2) Scribe v2 (pt)');
    console.table([
      {
        http: res.status,
        language: body?.language_code ?? null,
        // Só o tamanho e se os dígitos do código vieram — nunca o texto inteiro.
        textChars: body?.text?.length ?? 0,
        codeDigitsHeard: /4\D{0,3}7\D{0,3}1\D{0,3}9|quatro.*sete.*um.*nove/iu.test(body?.text ?? ''),
        detail: res.ok ? '' : await detail(res),
      },
    ]);
  }

  if (process.env.WITH_MUSIC === '1') {
    const res = await fetch(`${API}/v1/music`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'calm modern corporate instrumental, soft piano and pads',
        music_length_ms: 5_000,
        model_id: 'music_v2_5',
        force_instrumental: true,
        sign_with_c2pa: true,
      }),
    });
    const bytes = res.ok ? Buffer.from(await res.arrayBuffer()) : Buffer.alloc(0);
    console.log('\n3) Música music_v2_5');
    console.table([
      {
        http: res.status,
        bytes: bytes.length,
        contentType: res.headers.get('content-type'),
        songIdHeader: [...res.headers.keys()].filter((name) => /song|request/iu.test(name)).join(','),
        detail: res.ok ? '' : await detail(res),
      },
    ]);
  }
}
