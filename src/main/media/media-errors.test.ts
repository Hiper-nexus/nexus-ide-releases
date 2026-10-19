import { describe, expect, it } from 'vitest';
import {
  MediaProviderHttpError,
  describeMediaHttpError,
  mediaHttpError,
  mediaServiceName,
  providerErrorDetail,
  providerErrorReason,
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

  it('F-1587: erro do /interactions vem num array; chave inválida do Google é 400 e diz "recusou a chave"', async () => {
    // Corpo devolvido ao vivo pelo Google em 19/10/2026 (chave de teste falsa).
    const body = JSON.stringify([
      {
        error: {
          code: 400,
          message: 'API key not valid. Please pass a valid API key.',
          status: 'INVALID_ARGUMENT',
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
              reason: 'API_KEY_INVALID',
              domain: 'googleapis.com',
              metadata: { service: 'generativelanguage.googleapis.com' },
            },
          ],
        },
      },
    ]);
    expect(providerErrorDetail(body)).toBe('API key not valid. Please pass a valid API key.');
    expect(providerErrorReason(body)).toBe('API_KEY_INVALID');
    const err = await mediaHttpError(new Response(body, { status: 400 }), 'google-video');
    expect(err.kind).toBe('key');
    expect(err.message).toBe(
      'Google recusou a chave (HTTP 400). Confira ou troque a chave em Ajustes → Serviços de mídia. ' +
        'Resposta do serviço: API key not valid. Please pass a valid API key.',
    );
    // Outro 400 do Google segue sendo pedido recusado.
    const other = await mediaHttpError(
      new Response('{"error":{"code":400,"message":"bad resolution","status":"INVALID_ARGUMENT"}}', {
        status: 400,
      }),
      'google-video',
    );
    expect(other.kind).toBe('invalid-request');
    expect(providerErrorReason('[]')).toBeUndefined();
    expect(providerErrorReason('não é json')).toBeUndefined();
  });

  it('F-1587: cota zero do plano gratuito do Gemini não é "espere e tente de novo"', async () => {
    // Frase devolvida ao vivo em 19/10/2026 para uma chave de projeto gratuito.
    const message =
      'Rate limit exceeded for model gemini-omni-1.1-flash (limit: 0 input tokens per minute on Free Tier). ' +
      'Please upgrade your tier at https://ai.dev/rate-limit.';
    const err = await mediaHttpError(
      new Response(JSON.stringify({ error: { code: 429, message, status: 'RESOURCE_EXHAUSTED' } }), {
        status: 429,
      }),
      'google-video',
    );
    expect(err.kind).toBe('billing');
    expect(err.message).toBe(
      'Google recusou por falta de saldo ou de cobrança ativa (HTTP 429). Adicione crédito na conta do serviço. ' +
        `Resposta do serviço: ${message}`,
    );
    // Limite de verdade (cota maior que zero) continua sendo "espere".
    const throttled = await mediaHttpError(
      new Response(
        JSON.stringify({ error: { code: 429, message: 'Quota exceeded (limit: 10 requests per minute).' } }),
        { status: 429 },
      ),
      'google-video',
    );
    expect(throttled.kind).toBe('rate-limit');
  });

  it('nome curto do serviço', () => {
    expect(mediaServiceName('replicate-video')).toBe('Replicate');
    expect(mediaServiceName('google-image')).toBe('Google');
    expect(mediaServiceName('elevenlabs')).toBe('ElevenLabs');
    expect(mediaServiceName('outro')).toBe('outro');
  });
});
