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

  it('remove o sufixo técnico content-addressed do anexo', () => {
    expect(petSlugFromImagePath('/tmp/Meu Gato-264746742184270.jpg')).toBe(
      'meu-gato',
    );
  });
});

describe('hatchPetIntent', () => {
  it('produz um briefing visual curto com referência, skill e destino', () => {
    const intent = hatchPetIntent('/Users/x/Pictures/Meu Gato.png');
    expect(intent).toContain('/Users/x/Pictures/Meu Gato.png');
    expect(intent).toContain('nexus-pet-studio');
    expect(intent).toContain('3D toy premium');
    expect(intent).toContain('#FF00FF');
    expect(intent).toContain('Use o id meu-gato');
    expect(intent).toContain('artifacts/nexus-pet-studio/<missionId>');
    expect(intent).toContain('workflow governado v2');
    expect(intent).toContain('nunca escreva em ~/.codex/pets');
    expect(intent).not.toContain('nexus_context_doctor');
    expect(intent).not.toContain('reviewer');
    expect(intent).not.toContain('~/.claude/skills');
  });
});
