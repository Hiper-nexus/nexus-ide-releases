import { describe, expect, it } from 'vitest';
import {
  extractGeminiOmniOutput,
  geminiOmniRequest,
  geminiOmniTransportError,
  isGeminiFileTarget,
  isGeminiOmniModel,
} from './gemini-omni-interactions';

const image = (name: string, mimeType = 'image/jpeg') => ({
  mimeType,
  data: Buffer.from(name).toString('base64'),
});

describe('gemini-omni-interactions (F-1587)', () => {
  it('moldura final, referências e combinações seguem a sintaxe da documentação', () => {
    const req = { prompt: 'p' };
    const both = geminiOmniRequest(req, 'gemini-omni-1.1-flash', {
      start: image('a.jpg'),
      end: image('b.jpg'),
    });
    expect((both.input as Array<{ text?: string }>).at(-1)?.text).toBe(
      '[# Sources <FIRST_FRAME>@Image1 <LAST_FRAME>@Image2]\np',
    );
    expect(both.generation_config).toEqual({ video_config: { task: 'image_to_video' } });

    const refs = geminiOmniRequest(req, 'gemini-omni-1.1-flash', {
      references: [image('r1.png', 'image/png'), image('r2.webp', 'image/webp')],
    });
    expect(refs.input).toEqual([
      { type: 'image', data: Buffer.from('r1.png').toString('base64'), mime_type: 'image/png' },
      { type: 'image', data: Buffer.from('r2.webp').toString('base64'), mime_type: 'image/webp' },
      { type: 'text', text: '[# References <IMAGE_REF_0>@Image1 <IMAGE_REF_1>@Image2]\np' },
    ]);
    expect(refs.generation_config).toEqual({ video_config: { task: 'reference_to_video' } });

    const mixed = geminiOmniRequest(req, 'gemini-omni-1.1-flash', {
      start: image('a.jpg'),
      references: [image('r.png', 'image/png')],
    });
    expect((mixed.input as Array<{ text?: string }>).at(-1)?.text).toBe(
      '[# Sources <FIRST_FRAME>@Image1] [# References <IMAGE_REF_0>@Image2]\np',
    );
    expect(mixed.generation_config).toBeUndefined();

    expect(() => geminiOmniRequest(req, 'gemini-omni-1.1-flash', { end: image('b.jpg') })).toThrow(
      'usa a imagem final junto da inicial',
    );
  });

  it('texto puro vai como string, com text_to_video e store=true (exigência da entrega por URI)', () => {
    expect(geminiOmniRequest({ prompt: 'farol', resolution: '360p' }, 'gemini-omni-1.1-flash')).toEqual({
      model: 'gemini-omni-1.1-flash',
      input: 'farol',
      response_format: { type: 'video', delivery: 'uri', resolution: '360p' },
      generation_config: { video_config: { task: 'text_to_video' } },
      store: true,
    });
  });

  it('lê a resposta real de 19/10/2026: passo model_output com uri da Files API e usage', () => {
    const live = {
      id: 'v1_live',
      status: 'completed',
      usage: {
        total_tokens: 19636,
        total_input_tokens: 22,
        input_tokens_by_modality: [{ modality: 'text', tokens: 22 }],
        total_cached_tokens: 0,
        total_output_tokens: 19310,
        output_tokens_by_modality: [{ modality: 'video', tokens: 19310 }],
        total_tool_use_tokens: 0,
        total_thought_tokens: 304,
      },
      created: '2026-10-19T21:05:00Z',
      updated: '2026-10-19T21:05:27Z',
      service_tier: 'standard',
      steps: [
        { type: 'thought' },
        {
          type: 'model_output',
          content: [
            {
              type: 'video',
              mime_type: 'video/mp4',
              uri: 'https://generativelanguage.googleapis.com/v1beta/files/mqeyc809t9jy:download?alt=media',
            },
          ],
        },
      ],
      object: 'interaction',
      model: 'gemini-omni-1.1-flash',
    };
    expect(extractGeminiOmniOutput(live)).toEqual({
      fileId: 'files/mqeyc809t9jy',
      interactionId: 'v1_live',
      status: 'completed',
      text: '',
      usage: { inputTokens: 22, videoTokens: 19310, textTokens: 304 },
    });
  });

  it('lê as outras formas da resposta: outputs[], output_video e URI fora da Files API', () => {
    expect(extractGeminiOmniOutput({ outputs: [{ type: 'video', data: 'QUJD' }] })).toMatchObject({
      data: 'QUJD',
    });
    expect(extractGeminiOmniOutput({ output_video: { uri: 'files/xyz-9' } })).toMatchObject({
      fileId: 'files/xyz-9',
    });
    expect(
      extractGeminiOmniOutput({
        steps: [
          {
            type: 'model_output',
            content: [{ type: 'video', uri: 'https://video.googleusercontent.com/v.mp4' }],
          },
        ],
      }),
    ).toMatchObject({ uri: 'https://video.googleusercontent.com/v.mp4' });
    // Sem tokens de vídeo no usage não há custo inventado.
    expect(extractGeminiOmniOutput({ usage: { total_output_tokens: 10 } }).usage).toBeUndefined();
  });

  it('reconhece o modelo, o alvo da Files API e o estouro de 5 min do fetch', () => {
    expect(isGeminiOmniModel('gemini-omni-1.1-flash')).toBe(true);
    expect(isGeminiOmniModel('veo-3.1-generate-preview')).toBe(false);
    expect(isGeminiFileTarget('files/abc-1')).toBe(true);
    expect(isGeminiFileTarget('models/veo-3.1-generate-preview/operations/x1')).toBe(false);
    const timeout = new TypeError('fetch failed', { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } });
    expect((geminiOmniTransportError(timeout) as Error).message).toContain('em 5 minutos');
    const other = new Error('outra falha');
    expect(geminiOmniTransportError(other)).toBe(other);
  });
});
