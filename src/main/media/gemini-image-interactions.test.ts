import { describe, expect, it } from 'vitest';
import {
  extractGeminiImage,
  geminiImageRequest,
  geminiImageUsesInteractions,
} from './gemini-image-interactions';

describe('imagem do Gemini pela Interactions API', () => {
  it('os ids estáveis da família Nano Banana usam a Interactions; os antigos seguem no generateContent', () => {
    for (const model of [
      'gemini-nano-banana-2.1',
      'gemini-3.1-flash-image',
      'gemini-3.1-flash-lite-image',
      'gemini-3-pro-image',
    ]) {
      expect(geminiImageUsesInteractions(model)).toBe(true);
    }
    expect(geminiImageUsesInteractions('gemini-3.1-flash-image-preview')).toBe(false);
    expect(geminiImageUsesInteractions('gemini-2.5-flash-image')).toBe(false);
  });

  it('o pedido leva modelo, texto, formato de imagem 1K e a proporção', () => {
    expect(geminiImageRequest({ prompt: 'um gato', aspectRatio: '16:9' }, 'gemini-nano-banana-2.1')).toEqual({
      model: 'gemini-nano-banana-2.1',
      input: 'um gato',
      response_format: { type: 'image', mime_type: 'image/png', image_size: '1K', aspect_ratio: '16:9' },
    });
    const noAspect = geminiImageRequest({ prompt: 'x' }, 'gemini-3-pro-image');
    expect((noAspect.response_format as Record<string, string>).aspect_ratio).toBeUndefined();
  });

  it('edição manda a imagem antes do texto', () => {
    const body = geminiImageRequest({ prompt: 'troque o fundo' }, 'gemini-3-pro-image', {
      mimeType: 'image/png',
      data: 'QUJD',
    });
    expect(body.input).toEqual([
      { type: 'image', data: 'QUJD', mime_type: 'image/png' },
      { type: 'text', text: 'troque o fundo' },
    ]);
  });

  it('lê a imagem de model_output, de outputs[] e de output_image', () => {
    expect(
      extractGeminiImage({
        steps: [{ type: 'model_output', content: [{ type: 'text', text: 'pronto' }, { type: 'image', data: 'AAA' }] }],
      }),
    ).toEqual({ data: 'AAA', text: 'pronto' });
    expect(extractGeminiImage({ outputs: [{ type: 'image', data: 'BBB' }] }).data).toBe('BBB');
    expect(extractGeminiImage({ output_image: { data: 'CCC' } }).data).toBe('CCC');
  });

  it('sem imagem devolve só o texto do modelo (a recusa)', () => {
    const out = extractGeminiImage({
      steps: [{ type: 'model_output', content: [{ type: 'text', text: '  não posso   gerar isso ' }] }],
    });
    expect(out.data).toBeUndefined();
    expect(out.text).toBe('não posso gerar isso');
  });
});
