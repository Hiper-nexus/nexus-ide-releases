import { describe, expect, it } from 'vitest';
import {
  estimateVideoCostUsd,
  videoModelCard,
  videoModelSpec,
  videoRequestProblem,
} from '../../shared/media-video-models';
import { MEDIA_PROVIDERS } from './media-providers';
import type { MediaInputFile } from './media-path-policy';
import {
  replicateEndImageField,
  replicateImageField,
  replicateInput,
  replicateReferenceLimit,
} from './replicate-video-input';

const png = (name: string): MediaInputFile => ({
  path: `/w/${name}.png`,
  data: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
});
const req = (extra: Record<string, unknown> = {}) => ({ prompt: 'p', baseDir: '/w', ...extra });

const NEW_MODELS = [
  'bytedance/seedance-2.5',
  'minimax/h3',
  'alibaba/wan-3',
  'alibaba/wan-3-prime',
  'google/gemini-omni-1.1',
  'pixverse/pixverse-v6',
  'vidu/q3-pro',
];

describe('F-1612: modelos de vídeo de ponta no Replicate', () => {
  it('todos estão no catálogo do replicate-video e na tabela (validação e preço)', () => {
    const replicate = MEDIA_PROVIDERS.find((p) => p.id === 'replicate-video')!;
    for (const model of NEW_MODELS) {
      expect(replicate.models, model).toContain(model);
      expect(videoModelSpec(model), model).not.toBeNull();
      expect(videoModelCard(model)?.summary, model).toBeTruthy();
    }
    // O padrão continua o Seedance 2.0: quem já gerava não paga mais sem pedir.
    expect(replicate.defaultModel).toBe('bytedance/seedance-2.0');
  });

  it('usa o nome de campo de cada família para os quadros', () => {
    expect(replicateImageField('minimax/h3')).toBe('first_frame_image');
    expect(replicateEndImageField('minimax/h3')).toBe('last_frame_image');
    expect(replicateImageField('vidu/q3-pro')).toBe('start_image');
    expect(replicateEndImageField('vidu/q3-pro')).toBe('end_image');
    expect(replicateImageField('pixverse/pixverse-v6')).toBe('image');
    expect(replicateEndImageField('pixverse/pixverse-v6')).toBe('last_frame_image');
    expect(replicateImageField('alibaba/wan-3')).toBe('image');
    expect(replicateEndImageField('alibaba/wan-3')).toBeNull();
    expect(replicateEndImageField('google/gemini-omni-1.1')).toBe('last_frame');
  });

  it('Seedance 2.5: até 30 s, adaptive com primeiro quadro, referências sem quadro', () => {
    const text = replicateInput(req({ durationSeconds: 30, aspectRatio: '9:16' }), 'bytedance/seedance-2.5');
    expect(text).toMatchObject({ duration: 30, resolution: '720p', aspect_ratio: '9:16', generate_audio: true });
    const i2v = replicateInput(req({ aspectRatio: '9:16' }), 'bytedance/seedance-2.5', png('a'));
    expect(i2v.aspect_ratio).toBe('adaptive');
    expect(i2v.image).toMatch(/^data:image\/png;base64,/u);
    const refs = replicateInput(req(), 'bytedance/seedance-2.5', undefined, undefined, [png('a'), png('b')]);
    expect(refs.reference_images).toHaveLength(2);
    expect(() =>
      replicateInput(req(), 'bytedance/seedance-2.5', png('a'), undefined, [png('b')]),
    ).toThrow(/não pode combinar/u);
    expect(replicateReferenceLimit('bytedance/seedance-2.5', 9)).toBe(30);
    expect(videoRequestProblem('bytedance/seedance-2.5', { durationSeconds: 30 })).toBeNull();
    expect(videoRequestProblem('bytedance/seedance-2.5', { resolution: '1080p' })).toMatch(/480p, 720p/u);
  });

  it('MiniMax H3: resolução em maiúsculas e proporção no campo ratio', () => {
    expect(replicateInput(req({ resolution: '768p', aspectRatio: '9:16' }), 'minimax/h3')).toMatchObject({
      duration: 5,
      resolution: '768P',
      ratio: '9:16',
    });
    const i2v = replicateInput(req(), 'minimax/h3', png('a'));
    expect(i2v).toMatchObject({ resolution: '2K', ratio: 'adaptive' });
    expect(i2v.first_frame_image).toBeDefined();
    expect(i2v).not.toHaveProperty('aspect_ratio');
  });

  it('Wan 3: proporção só sem imagem; PixVerse: resolução em quality e áudio ligado', () => {
    expect(replicateInput(req({ aspectRatio: '9:16' }), 'alibaba/wan-3')).toMatchObject({
      duration: 5,
      resolution: '1080p',
      aspect_ratio: '9:16',
    });
    expect(replicateInput(req({ aspectRatio: '9:16' }), 'alibaba/wan-3', png('a'))).not.toHaveProperty(
      'aspect_ratio',
    );
    const pix = replicateInput(req({ resolution: '1080p', durationSeconds: 8 }), 'pixverse/pixverse-v6');
    expect(pix).toMatchObject({ quality: '1080p', duration: 8, generate_audio_switch: true });
    expect(pix).not.toHaveProperty('resolution');
    expect(replicateInput(req(), 'vidu/q3-pro')).toMatchObject({ resolution: '720p', audio: true });
  });

  it('Gemini Omni 1.1 pelo Replicate não manda duração e aceita referências', () => {
    const input = replicateInput(req({ resolution: '1080p' }), 'google/gemini-omni-1.1', undefined, undefined, [
      png('a'),
    ]);
    expect(input).not.toHaveProperty('duration');
    expect(input.resolution).toBe('1080p');
    expect(input.reference_images).toHaveLength(1);
    expect(videoRequestProblem('google/gemini-omni-1.1', { durationSeconds: 8 })).toMatch(/o modelo decide/u);
    expect(estimateVideoCostUsd('google/gemini-omni-1.1', { seconds: 8, resolution: '720p' })).toBe(1.2);
  });

  it('recusa antes de pagar referência a mais, ou para quem não recebe referência', () => {
    expect(videoRequestProblem('minimax/h3', { referenceImages: 1 })).toMatch(/não recebe imagens de referência/u);
    expect(videoRequestProblem('google/veo-3.1', { referenceImages: 4 })).toMatch(/até 3 imagens/u);
    expect(videoRequestProblem('google/veo-3.1', { referenceImages: 3 })).toBeNull();
    // Veo 3.1: referência só em 16:9 e 8 s; Fast e Lite não recebem.
    expect(videoRequestProblem('google/veo-3.1', { referenceImages: 1, aspectRatio: '9:16' })).toMatch(/só gera em 16:9/u);
    expect(videoRequestProblem('google/veo-3.1', { referenceImages: 1, durationSeconds: 4 })).toMatch(/só gera 8 s/u);
    expect(videoRequestProblem('google/veo-3.1', { referenceImages: 1, durationSeconds: 8, aspectRatio: '16:9' })).toBeNull();
    expect(videoRequestProblem('google/veo-3.1-fast', { referenceImages: 1 })).toMatch(/não recebe/u);
    // Modelo sem teto na tabela: o motor segue o comportamento antigo.
    expect(videoRequestProblem('kwaivgi/kling-v3-video', { referenceImages: 2 })).toBeNull();
  });

  it('preço de lista da página de cada modelo', () => {
    expect(estimateVideoCostUsd('bytedance/seedance-2.5', { seconds: 10, resolution: '480p' })).toBe(1.028);
    expect(estimateVideoCostUsd('minimax/h3', { seconds: 5, resolution: '2k' })).toBe(0.65);
    expect(estimateVideoCostUsd('alibaba/wan-3-prime', { seconds: 5, resolution: '1080p' })).toBe(1.4);
    expect(estimateVideoCostUsd('vidu/q3-pro', { seconds: 16, resolution: '1080p' })).toBe(2.56);
  });
});
