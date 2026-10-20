import { describe, expect, it, vi } from 'vitest';
import { encodeWav } from '../wav-pcm';
import {
  createGeminiReplicatedVoice,
  deleteGeminiVoice,
  extractInteractionAudio,
  geminiTranscribe,
  geminiTts,
  geminiTtsCostUsd,
  isGeminiVoice,
  listGeminiReplicatedVoices,
} from './gemini-voice';

/** F-1601 — contratos da API de voz do Gemini (TTS, replicação, lista, apagar, STT). */

const wav = encodeWav({ sampleRate: 24_000, samples: new Int16Array(240) });

function respond(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

describe('voz do Gemini', () => {
  it('reconhece vozes da biblioteca e ids replicados', () => {
    expect(isGeminiVoice('Kore')).toBe(true);
    expect(isGeminiVoice('voice_abc-123')).toBe(true);
    expect(isGeminiVoice('kore')).toBe(false);
    expect(isGeminiVoice('voice_')).toBe(false);
    expect(isGeminiVoice('voice_a/../b')).toBe(false);
  });

  it('cobra 25 tokens por segundo a US$ 9 por milhão, o dobro a partir de 2027', () => {
    expect(geminiTtsCostUsd(60, new Date('2026-10-20T00:00:00Z'))).toBe(0.0135);
    expect(geminiTtsCostUsd(60, new Date('2027-01-01T00:00:00Z'))).toBe(0.027);
  });

  it('lê o último áudio dos passos da interação', () => {
    const payload = {
      steps: [
        { content: [{ type: 'text', text: 'x' }, { type: 'audio', data: Buffer.from('a').toString('base64') }] },
        { content: [{ type: 'audio', data: wav.toString('base64') }] },
      ],
    };
    expect(extractInteractionAudio(payload)?.equals(wav)).toBe(true);
    expect(extractInteractionAudio({ steps: [] })).toBeNull();
    expect(extractInteractionAudio(null)).toBeNull();
  });

  it('TTS pede áudio com a voz e devolve o WAV; recusa resposta sem WAV e explica chave recusada', async () => {
    const fetchFn = respond({ steps: [{ content: [{ type: 'audio', data: wav.toString('base64') }] }] });
    const out = await geminiTts({ key: 'k', fetchFn: fetchFn as unknown as typeof fetch, text: 'Olá', voice: 'Kore' });
    expect(out.equals(wav)).toBe(true);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
    expect(init.headers).toMatchObject({ 'x-goog-api-key': 'k' });
    const body = JSON.parse(String(init.body));
    expect(body.response_format).toEqual({ type: 'audio' });
    expect(body.input[0].content[0]).toEqual({ type: 'text', text: 'Olá' });

    await expect(
      geminiTts({ key: 'k', fetchFn: respond({ steps: [] }) as unknown as typeof fetch, text: 'x', voice: 'Kore' }),
    ).rejects.toThrow(/não devolveu áudio/u);
    await expect(
      geminiTts({ key: 'k', fetchFn: respond({ error: { message: 'bad key' } }, 403) as unknown as typeof fetch, text: 'x', voice: 'Kore' }),
    ).rejects.toThrow(/recusou a chave/u);
    await expect(geminiTts({ key: 'k', fetchFn: respond({}) as unknown as typeof fetch, text: 'x', voice: 'Rachel' })).rejects.toThrow(
      /desconhecida/u,
    );
  });

  it('replicação manda a amostra e o consentimento e exige um id voice_ válido', async () => {
    const fetchFn = respond({ id: 'voice_novo' });
    const created = await createGeminiReplicatedVoice({
      key: 'k',
      fetchFn: fetchFn as unknown as typeof fetch,
      displayName: 'Minha voz',
      sourceWav: wav,
      consentWav: wav,
    });
    expect(created).toEqual({ id: 'voice_novo' });
    const body = JSON.parse(String((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body).toMatchObject({
      store: true,
      voice: { model: 'gemini-3.8-flash-tts', type: 'replicated', display_name: 'Minha voz' },
    });
    expect(body.voice.replicated.consent_audio.mime_type).toBe('audio/wav');
    await expect(
      createGeminiReplicatedVoice({
        key: 'k',
        fetchFn: respond({ id: '../etc' }) as unknown as typeof fetch,
        displayName: 'x',
        sourceWav: wav,
        consentWav: wav,
      }),
    ).rejects.toThrow(/id da voz/u);
  });

  it('lista só vozes replicadas, segue as páginas e apaga tolerando 404', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            voices: [
              { id: 'voice_a', display_name: 'A', type: 'replicated' },
              { id: 'Kore', type: 'prebuilt' },
            ],
            next_page_token: 'p2',
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ voices: [{ id: 'voice_b', type: 'replicated' }] })));
    const voices = await listGeminiReplicatedVoices({ key: 'k', fetchFn: fetchFn as unknown as typeof fetch });
    expect(voices).toEqual([
      { id: 'voice_a', displayName: 'A' },
      { id: 'voice_b', displayName: null },
    ]);
    expect(String(fetchFn.mock.calls[1][0])).toContain('page_token=p2');

    await expect(deleteGeminiVoice({ key: 'k', fetchFn: respond({}, 404) as unknown as typeof fetch, id: 'voice_a' })).resolves.toBeUndefined();
    await expect(deleteGeminiVoice({ key: 'k', fetchFn: respond({}, 500) as unknown as typeof fetch, id: 'voice_a' })).rejects.toThrow();
    await expect(deleteGeminiVoice({ key: 'k', fetchFn: respond({}) as unknown as typeof fetch, id: 'Kore' })).rejects.toThrow(/inválido/u);
  });

  it('transcreve a declaração juntando as partes de texto', async () => {
    const fetchFn = respond({ candidates: [{ content: { parts: [{ text: 'Eu sou' }, { text: 'o proprietário' }] } }] });
    expect(await geminiTranscribe({ key: 'k', fetchFn: fetchFn as unknown as typeof fetch, wav })).toBe('Eu sou o proprietário');
  });
});
