// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { hatchPetIntent, petSlugFromImagePath } from './PetSection';

describe('petSlugFromImagePath', () => {
  it('deriva slug kebab-case do nome do arquivo', () => {
    expect(petSlugFromImagePath('/Users/x/Pictures/Meu Gato.png')).toBe(
      'meu-gato',
    );
  });

  it('remove acentos e caracteres fora de a-z0-9', () => {
    expect(petSlugFromImagePath('C:\\fotos\\Dragão_Vermelho!.webp')).toBe(
      'dragao-vermelho',
    );
  });

  it('cai para "pet" quando nada sobra', () => {
    expect(petSlugFromImagePath('/tmp/---.png')).toBe('pet');
  });
});

describe('hatchPetIntent', () => {
  it('inclui imagem-base, skill hatch-pet, malha 8×11 e destino do slug', () => {
    const intent = hatchPetIntent('/Users/x/Pictures/Meu Gato.png');
    expect(intent).toContain('/Users/x/Pictures/Meu Gato.png');
    expect(intent).toContain('hatch-pet');
    expect(intent).toContain('8×11');
    expect(intent).toContain('~/.codex/pets/meu-gato/');
    expect(intent).toContain('spriteVersionNumber 2');
  });
});
