import { describe, expect, it } from 'vitest';
import {
  VIDEO_STYLE_PRESETS,
  matchVideoStylePreset,
  toggleVideoStylePreset,
} from './video-style-presets';
import { BRIEF_FIELD_LIMITS } from './video-brief';

describe('predefinições de estilo do vídeo', () => {
  it('cobre os caminhos reais do estúdio, do motor próprio ao clipe de IA', () => {
    const ids = VIDEO_STYLE_PRESETS.map((preset) => preset.id);
    expect(ids).toEqual([
      'motion-graphics',
      'screen-demo',
      'live-action',
      '3d',
      'anime-2d',
      'illustration',
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('cada uma escreve direção concreta, não um rótulo', () => {
    for (const preset of VIDEO_STYLE_PRESETS) {
      // Texto curto demais seria só outro "moderno": o problema que elas resolvem.
      expect(preset.text.length).toBeGreaterThan(120);
      expect(preset.text.length).toBeLessThanOrEqual(BRIEF_FIELD_LIMITS.style);
      expect(preset.label.length).toBeLessThanOrEqual(24);
      expect(preset.hint.length).toBeGreaterThan(20);
    }
  });

  it('nenhuma cita marca, obra ou pessoa — todo serviço de vídeo recusa', () => {
    const proibido =
      /\b(pixar|disney|marvel|netflix|apple|nike|coca|ghibli|sora|veo|midjourney|kling|seedance)\b/iu;
    for (const preset of VIDEO_STYLE_PRESETS) {
      expect(preset.text).not.toMatch(proibido);
    }
  });

  it('escolher escreve o texto no campo; escolher de novo limpa', () => {
    const motion = VIDEO_STYLE_PRESETS[0]!;
    const escrito = toggleVideoStylePreset('', motion.id);
    expect(escrito).toBe(motion.text);
    expect(toggleVideoStylePreset(escrito, motion.id)).toBe('');
  });

  it('trocar de predefinição substitui o texto da anterior', () => {
    const [motion, tela] = VIDEO_STYLE_PRESETS;
    const comMotion = toggleVideoStylePreset('', motion!.id);
    expect(toggleVideoStylePreset(comMotion, tela!.id)).toBe(tela!.text);
  });

  it('o campo continua editável: texto próprio não é predefinição nenhuma', () => {
    expect(matchVideoStylePreset('escuro, com a cor do meu site')).toBeNull();
    expect(matchVideoStylePreset('')).toBeNull();
    expect(matchVideoStylePreset('   ')).toBeNull();
  });

  it('o chip só fica marcado enquanto o texto é o da predefinição', () => {
    const preset = VIDEO_STYLE_PRESETS[2]!;
    expect(matchVideoStylePreset(preset.text)).toBe(preset.id);
    expect(matchVideoStylePreset(`  ${preset.text}  `)).toBe(preset.id);
    // Editou por cima: deixa de ser a predefinição, e o chip desmarca.
    expect(matchVideoStylePreset(`${preset.text} e com o logo no canto`)).toBeNull();
  });
});
