import { describe, expect, it } from 'vitest';
import {
  MediaAbortError,
  MediaJobTimeoutError,
  dataUri,
  fileToInlineData,
  mediaResult,
  requireKey,
  sleepWhileAuthorized,
  type MediaDeps,
} from './media-runtime';
import { findMediaProvider, MediaProviderUnavailableError } from './media-providers';
import * as engine from './media-generation';

const deps: MediaDeps = {
  fetchFn: (async () => new Response()) as typeof fetch,
  resolveHostname: async () => [],
  getKey: () => undefined,
  sleep: async () => {},
  now: () => 5_000,
};

describe('media-runtime (saiu de media-generation.ts no F-1599)', () => {
  it('o motor reexporta as mesmas classes e tipos de antes', () => {
    expect(engine.MediaJobTimeoutError).toBe(MediaJobTimeoutError);
    expect(engine.MediaAbortError).toBe(MediaAbortError);
    expect(() => engine.throwIfMediaAborted(AbortSignal.abort())).toThrow(MediaAbortError);
  });

  it('estouro de tempo de vídeo promete a retomada; o de imagem, não', () => {
    expect(new MediaJobTimeoutError('xai-video', 'req-1').message).toContain('recoverJobId="req-1"');
    expect(new MediaJobTimeoutError('replicate-image', 'p1', false).message).toContain('reenvie a geração');
  });

  it('sem chave é MediaProviderUnavailableError com o caminho de Ajustes', () => {
    const def = findMediaProvider('xai-video')!;
    expect(() => requireKey(def, deps)).toThrow(MediaProviderUnavailableError);
    expect(() => requireKey(def, deps)).toThrow('xAI — Grok Imagine (vídeo) sem chave — conecte em Ajustes → Serviços de mídia');
    expect(requireKey(def, { ...deps, getKey: () => 'k' })).toBe('k');
  });

  it('imagem do projeto vira base64 com o mime pela extensão', () => {
    const file = { path: 'C:\\proj\\foto.JPG', data: Buffer.from('jpg') };
    expect(fileToInlineData(file)).toEqual({ mimeType: 'image/jpeg', data: 'anBn' });
    expect(dataUri({ path: 'a.webp', data: Buffer.from('w') })).toBe('data:image/webp;base64,dw==');
  });

  it('resultado usa a tabela do provedor e o relógio injetado', () => {
    const def = findMediaProvider('xai-video')!;
    expect(
      mediaResult(def, 'grok-imagine-video', 'C:\\proj\\v.mp4', 1_000, deps, { seconds: 10, resolution: '480p' }, 'req-1'),
    ).toEqual({
      ok: true,
      path: 'C:\\proj\\v.mp4',
      provider: 'xai-video',
      model: 'grok-imagine-video',
      kind: 'video',
      estimatedCostUsd: 0.5,
      durationMs: 4_000,
      jobId: 'req-1',
    });
  });

  it('espera cancelada vira MediaAbortError', async () => {
    const controller = new AbortController();
    const pending = sleepWhileAuthorized(
      { ...deps, sleep: () => new Promise(() => {}) },
      5_000,
      { signal: controller.signal },
    );
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(MediaAbortError);
  });
});
