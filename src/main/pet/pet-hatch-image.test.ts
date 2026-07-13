import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { copyHatchImage, stableHatchImageName } from './pet-hatch-image';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true })));
});

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

describe('copyHatchImage', () => {
  it('reutiliza o mesmo destino para conteúdo idêntico', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nexus-pet-hatch-'));
    dirs.push(root);
    const a = path.join(root, 'Meu Gato.jpg');
    const b = path.join(root, 'Outra Cópia.jpg');
    await writeFile(a, 'same-image-bytes');
    await writeFile(b, 'same-image-bytes');

    const first = await copyHatchImage(a, root);
    const again = await copyHatchImage(a, root);

    expect(again).toBe(first);
    expect(await readFile(first, 'utf8')).toBe('same-image-bytes');
  });
});
