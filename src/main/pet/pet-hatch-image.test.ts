import { describe, expect, it } from 'vitest';
import { stableHatchImageName } from './pet-hatch-image';

describe('stableHatchImageName', () => {
  it('limpa querystring/acentos do nome da Fototeca e normaliza a extensão', () => {
    expect(
      stableHatchImageName(
        'uuid=C27F8BE9&code=001&library=1&cap=true.jpeg',
        42,
      ),
    ).toBe('uuid-c27f8be9-code-001-library-1-cap-true-42.jpg');
  });

  it('mantém png e corta stems gigantes em 48 chars', () => {
    const name = stableHatchImageName(`${'a'.repeat(80)}.PNG`, 7);
    expect(name).toBe(`${'a'.repeat(48)}-7.png`);
  });

  it('cai para "pet" quando o stem não sobra', () => {
    expect(stableHatchImageName('!!!.webp', 1)).toBe('pet-1.webp');
  });
});
