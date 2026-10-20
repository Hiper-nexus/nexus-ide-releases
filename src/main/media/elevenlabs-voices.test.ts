import { describe, expect, it, vi } from 'vitest';
import {
  classifyVoiceOrigin,
  getElevenLabsVoice,
  listElevenLabsVoices,
  summarizeVoice,
} from './elevenlabs-voices';

const never = () => false;

describe('origem da voz', () => {
  it.each([
    [{ category: 'premade', voice_id: 'a' }, 'library'],
    [{ category: 'professional', is_owner: false, voice_id: 'a' }, 'library'],
    [{ category: 'generated', is_owner: true, voice_id: 'a' }, 'designed'],
    [{ category: 'cloned', is_owner: true, voice_id: 'a' }, 'external-clone'],
    [{ category: 'professional', is_owner: true, voice_id: 'a' }, 'external-clone'],
    [{ category: 'algo-novo', voice_id: 'a' }, 'unknown'],
  ])('%j → %s', (voice, origin) => {
    expect(classifyVoiceOrigin(voice, never)).toBe(origin);
  });

  it('clone com recibo do Nexus é nexus-clone', () => {
    expect(classifyVoiceOrigin({ category: 'cloned', is_owner: true, voice_id: 'minha' }, (id) => id === 'minha')).toBe(
      'nexus-clone',
    );
  });
});

describe('summarizeVoice', () => {
  it('leva só os campos úteis e limpa texto de controle', () => {
    const summary = summarizeVoice(
      {
        voice_id: 'abc123',
        name: 'Ana\u202e',
        category: 'premade',
        labels: { accent: 'brazilian', gender: 'female', secret: 'x' },
        description: 'Voz calma',
        verified_languages: [{ language: 'pt' }, { language: 'pt' }, { language: 'en' }],
        preview_url: 'https://storage.example/signed',
      } as Parameters<typeof summarizeVoice>[0],
      never,
    );
    expect(summary).toEqual({
      voiceId: 'abc123',
      name: 'Ana',
      category: 'premade',
      origin: 'library',
      labels: { accent: 'brazilian', gender: 'female' },
      languages: ['pt', 'en'],
      description: 'Voz calma',
    });
  });

  it('id estranho é descartado', () => {
    expect(summarizeVoice({ voice_id: '../x' }, never)).toBeNull();
    expect(summarizeVoice({}, never)).toBeNull();
  });
});

describe('listElevenLabsVoices', () => {
  it('pagina pelo next_page_token e manda a chave só no cabeçalho', async () => {
    const urls: string[] = [];
    const fetchFn = vi.fn(async (input: string | URL, init?: RequestInit) => {
      urls.push(String(input));
      expect(((init?.headers ?? {}) as Record<string, string>)['xi-api-key']).toBe('k');
      const first = !String(input).includes('next_page_token');
      return new Response(
        JSON.stringify({
          voices: [{ voice_id: first ? 'v1' : 'v2', name: first ? 'Um' : 'Dois', category: 'premade' }],
          has_more: first,
          next_page_token: first ? 'tok' : null,
        }),
      );
    });
    const voices = await listElevenLabsVoices({ key: 'k', fetchFn: fetchFn as unknown as typeof fetch, isNexusClone: never });
    expect(voices.map((voice) => voice.voiceId)).toEqual(['v1', 'v2']);
    expect(urls[0]).toContain('/v2/voices?page_size=100');
    expect(urls[1]).toContain('next_page_token=tok');
    expect(urls.join(' ')).not.toContain('k&');
  });

  it('401 vira frase com o que fazer', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 401 }));
    await expect(
      listElevenLabsVoices({ key: 'k', fetchFn: fetchFn as unknown as typeof fetch, isNexusClone: never }),
    ).rejects.toThrow(/Serviços de mídia/u);
  });
});

describe('getElevenLabsVoice', () => {
  it('voz que a conta não vê volta null', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 404 }));
    expect(
      await getElevenLabsVoice({ key: 'k', voiceId: 'x', fetchFn: fetchFn as unknown as typeof fetch, isNexusClone: never }),
    ).toBeNull();
  });
});
