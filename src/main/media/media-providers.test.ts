import { describe, expect, it } from 'vitest';
import {
  computeMediaTierAlternatives,
  MEDIA_PROVIDERS,
  MediaProviderUnavailableError,
  resolveMediaProvider,
} from './media-providers';

describe('computeMediaTierAlternatives', () => {
  it('retorna providers de imagem disponíveis quando vídeo está indisponível', () => {
    const alternatives = computeMediaTierAlternatives(
      'video',
      'sem key configurada',
      (def) => def.kind === 'image',
    );
    expect(alternatives).toHaveLength(1);
    expect(alternatives[0].kind).toBe('image');
    expect(alternatives[0].providers.length).toBeGreaterThan(0);
    expect(alternatives[0].reason).toMatch(/sem key configurada/);
  });

  it('retorna lista vazia quando nenhuma alternativa tem key', () => {
    const alternatives = computeMediaTierAlternatives(
      'video',
      'sem key',
      () => false,
    );
    expect(alternatives).toHaveLength(0);
  });

  it('não sugere alternativa da mesma tier (video não pode ser alternativa de video)', () => {
    const alternatives = computeMediaTierAlternatives(
      'video',
      'sem key',
      () => true,
    );
    expect(alternatives.every((a) => a.kind !== 'video')).toBe(true);
  });

  it('image indisponível não gera alternativa de tier inferior com provider real', () => {
    const alternatives = computeMediaTierAlternatives(
      'image',
      'sem key',
      () => false,
    );
    // nenhum provider de tier inferior existe na registry; resultado vazio
    expect(alternatives.every((a) => a.providers.length === 0 || a.kind !== 'video')).toBe(true);
  });

  it('audio não tem tier inferior — retorna lista vazia', () => {
    const alternatives = computeMediaTierAlternatives(
      'audio',
      'sem key',
      () => true,
    );
    expect(alternatives).toHaveLength(0);
  });

  it('só inclui providers e modelos dentro da whitelist (sem fallback silencioso)', () => {
    const alternatives = computeMediaTierAlternatives(
      'video',
      'sem key',
      (def) => def.kind === 'image',
    );
    for (const alt of alternatives) {
      for (const provider of alt.providers) {
        const def = MEDIA_PROVIDERS.find((p) => p.id === provider.id)!;
        expect(def).toBeDefined();
        for (const model of provider.models) {
          expect(def.models).toContain(model);
        }
      }
    }
  });

  it('inclui defaultModel no provider sugerido', () => {
    const alternatives = computeMediaTierAlternatives(
      'video',
      'sem key',
      (def) => def.kind === 'image',
    );
    for (const alt of alternatives) {
      for (const provider of alt.providers) {
        expect(provider.defaultModel).toBeTruthy();
        const def = MEDIA_PROVIDERS.find((p) => p.id === provider.id)!;
        expect(provider.defaultModel).toBe(def.defaultModel);
      }
    }
  });
});

describe('MediaProviderUnavailableError', () => {
  it('é lançado por resolveMediaProvider quando kind não tem nenhum provider com key', () => {
    expect(() =>
      resolveMediaProvider('video', undefined, () => false),
    ).toThrow(MediaProviderUnavailableError);
  });

  it('é lançado por resolveMediaProvider quando provider explícito não tem key', () => {
    expect(() =>
      resolveMediaProvider('image', 'google-image', () => false),
    ).toThrow(MediaProviderUnavailableError);
  });

  it('carrega o kind que falhou', () => {
    try {
      resolveMediaProvider('video', undefined, () => false);
      expect.fail('deveria ter lançado');
    } catch (err) {
      expect(err).toBeInstanceOf(MediaProviderUnavailableError);
      expect((err as MediaProviderUnavailableError).requestedKind).toBe('video');
    }
  });

  it('preserva a mensagem legível de configuração', () => {
    try {
      resolveMediaProvider('video', undefined, () => false);
      expect.fail('deveria ter lançado');
    } catch (err) {
      expect((err as Error).message).toMatch(/Ajustes → Serviços de mídia/);
    }
  });
});
