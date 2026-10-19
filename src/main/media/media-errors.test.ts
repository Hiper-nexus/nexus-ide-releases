import { describe, expect, it } from 'vitest';
import {
  MediaProviderHttpError,
  describeMediaHttpError,
  mediaHttpError,
  mediaServiceName,
  providerErrorDetail,
} from './media-errors';

describe('media-errors (F-1584)', () => {
  it('tira a frase do serviço do corpo JSON de cada provedor', () => {
    // Replicate: {"title","detail","status"}
    expect(
      providerErrorDetail(
        '{"title":"Input validation failed","detail":"- input.duration: duration must be one of the following: 4, 6, 8","status":422}',
      ),
    ).toBe('- input.duration: duration must be one of the following: 4, 6, 8');
    // Google / OpenAI: {"error":{"message"}}
    expect(
      providerErrorDetail('{"error":{"code":400,"message":"API key not valid.","status":"INVALID_ARGUMENT"}}'),
    ).toBe('API key not valid.');
    // ElevenLabs: {"detail":{"message"}}
    expect(providerErrorDetail('{"detail":{"status":"quota_exceeded","message":"Quota exceeded."}}')).toBe(
      'Quota exceeded.',
    );
    expect(providerErrorDetail('<html>Bad Gateway</html>')).toBe('<html>Bad Gateway</html>');
    expect(providerErrorDetail('')).toBe('');
    expect(providerErrorDetail('x'.repeat(1000))).toHaveLength(300);
  });

  it('diz o que houve e o que fazer, por tipo de falha', () => {
    expect(describeMediaHttpError('replicate-video', 401, '')).toBe(
      'Replicate recusou a chave (HTTP 401). Confira ou troque a chave em Ajustes → Serviços de mídia.',
    );
    expect(describeMediaHttpError('google-video', 402, '')).toContain('falta de saldo');
    expect(describeMediaHttpError('openai-image', 429, 'Rate limit reached')).toBe(
      'OpenAI limitou os pedidos ou a cota acabou (HTTP 429). Espere um pouco e tente de novo. Resposta do serviço: Rate limit reached',
    );
    expect(describeMediaHttpError('replicate-video', 503, '')).toContain('Tente de novo em alguns minutos');
    expect(describeMediaHttpError('replicate-video', 404, '')).toContain('pode ter sido desligado');
    expect(describeMediaHttpError('replicate-video', 422, 'duration must be 4, 6, 8')).toBe(
      'Replicate não aceitou o pedido (HTTP 422); nada foi gerado. Resposta do serviço: duration must be 4, 6, 8',
    );
  });

  it('o erro tipado guarda status, tipo e detalhe, sem o corpo inteiro', async () => {
    const res = new Response('{"title":"Unauthenticated","detail":"You did not pass a valid authentication token","status":401}', {
      status: 401,
    });
    const err = await mediaHttpError(res, 'replicate-image');
    expect(err).toBeInstanceOf(MediaProviderHttpError);
    expect(err).toBeInstanceOf(Error);
    expect(err.kind).toBe('key');
    expect(err.status).toBe(401);
    expect(err.message).toContain('Replicate recusou a chave (HTTP 401)');
    expect(err.message).toContain('You did not pass a valid authentication token');
    expect(err.message).not.toContain('"title"');
  });

  it('nome curto do serviço', () => {
    expect(mediaServiceName('replicate-video')).toBe('Replicate');
    expect(mediaServiceName('google-image')).toBe('Google');
    expect(mediaServiceName('elevenlabs')).toBe('ElevenLabs');
    expect(mediaServiceName('outro')).toBe('outro');
  });
});
