import { describe, expect, it } from 'vitest';
import { buildPresentationBrief, normalizeSiteUrl } from './video-brief';

describe('brief do vídeo de apresentação', () => {
  it('leva produto, site, público, formato, voz, música e a regra de custo', () => {
    const brief = buildPresentationBrief({
      product: 'Agendify — agenda online para barbearias',
      siteUrl: 'agendify.com.br',
      audience: 'donos de barbearia',
      style: 'escuro, neon',
      durationSec: 45,
      preset: 'vertical-9x16',
      voice: { kind: 'mine', voiceId: 'abc123', name: 'Voz de Ana' },
      music: true,
    });
    expect(brief).toContain('Carregue a skill nexus-video');
    expect(brief).toContain('Produto: Agendify — agenda online para barbearias');
    expect(brief).toContain('https://agendify.com.br/');
    expect(brief).toContain('Público: donos de barbearia');
    expect(brief).toContain('cerca de 45 s');
    expect(brief).toContain('Reels, Shorts e TikTok (9:16) (1080×1920, preset vertical-9x16)');
    expect(brief).toContain('voice_id abc123');
    expect(brief).toContain('nexus_music_generate');
    expect(brief).toContain('espere o meu ok');
    expect(brief).toContain('nexus_video_export no preset vertical-9x16');
  });

  it('sem site, biblioteca ou sem narração dizem o que fazer', () => {
    const library = buildPresentationBrief({ product: 'X', durationSec: 30, preset: 'youtube-16x9', voice: { kind: 'library' }, music: false });
    expect(library).toContain('Sem site');
    expect(library).toContain('nexus_voice_list e me pergunte');
    expect(library).toContain('Música: sem música.');
    expect(library).not.toContain('Público:');
    const silent = buildPresentationBrief({ product: 'X', durationSec: 30, preset: 'square-1x1', voice: { kind: 'none' }, music: true });
    expect(silent).toContain('sem narração');
  });

  it('URL: só http(s); texto de controle sai do brief', () => {
    expect(normalizeSiteUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeSiteUrl('http://a.b/c')).toBe('http://a.b/c');
    expect(normalizeSiteUrl('  ')).toBeNull();
    const brief = buildPresentationBrief({ product: 'A\u001b[31mB', durationSec: 30, preset: 'square-1x1', voice: { kind: 'none' }, music: false });
    expect(brief).toContain('Produto: A [31mB');
  });
});
