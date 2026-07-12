import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetPetLibraryCacheForTests,
  configurePetsLibraryRoot,
  listPetLibrary,
  loadLibrarySheet,
  resolvePetsLibraryRoot,
} from './pet-library';

const REPO_PETS = path.join(process.cwd(), 'resources', 'pets');

describe('pet-library', () => {
  beforeEach(() => {
    __resetPetLibraryCacheForTests();
  });

  afterEach(() => {
    __resetPetLibraryCacheForTests();
  });

  it('resolvePetsLibraryRoot packaged aponta para resourcesPath/pets', () => {
    expect(resolvePetsLibraryRoot('/app', '/Resources', true)).toBe(
      path.join('/Resources', 'pets'),
    );
  });

  it('resolvePetsLibraryRoot em dev prefere o candidato com manifest', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-lib-root-'));
    const pets = path.join(dir, 'resources', 'pets');
    fs.mkdirSync(pets, { recursive: true });
    fs.writeFileSync(path.join(pets, 'manifest.json'), '[]');
    const resolved = resolvePetsLibraryRoot(
      path.join(dir, 'somewhere', 'build'),
      '/Resources',
      false,
      dir,
    );
    expect(resolved).toBe(path.resolve(pets));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lista o manifest embutido do repositório', () => {
    configurePetsLibraryRoot(REPO_PETS);
    const listed = listPetLibrary();
    expect(listed.ok).toBe(true);
    expect(listed.items?.length).toBeGreaterThanOrEqual(15);
    expect(listed.items?.some((item) => item.id === 'navi')).toBe(true);
  });

  it('carrega um sheet como data URL webp', () => {
    configurePetsLibraryRoot(REPO_PETS);
    const loaded = loadLibrarySheet('navi');
    expect(loaded.ok).toBe(true);
    expect(loaded.name).toBe('Navi');
    expect(loaded.sheet?.dataUrl.startsWith('data:image/webp;base64,')).toBe(
      true,
    );
    expect(loaded.sheet?.cols).toBe(8);
    // Packs petdex: 8×9 (célula 192×208); Codex full seria 8×11.
    expect(loaded.sheet?.rows).toBe(9);
  });

  it('rejeita path traversal e file que não casa com id', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-lib-'));
    fs.mkdirSync(path.join(dir, 'sheets'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify([
        {
          id: 'evil',
          slug: 'evil',
          label: 'Evil',
          file: '../outside.webp',
        },
        {
          id: 'mismatch',
          slug: 'mismatch',
          label: 'Mismatch',
          file: 'sheets/other.webp',
        },
      ]),
    );
    configurePetsLibraryRoot(dir);
    expect(listPetLibrary().items).toEqual([]);
    expect(loadLibrarySheet('evil').ok).toBe(false);
    expect(loadLibrarySheet('mismatch').ok).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejeita arquivo sem magic WebP', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-lib-'));
    fs.mkdirSync(path.join(dir, 'sheets'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'sheets', 'bogus.webp'),
      Buffer.from('not-a-webp-file-at-all'),
    );
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify([
        {
          id: 'bogus',
          slug: 'bogus',
          label: 'Bogus',
          file: 'sheets/bogus.webp',
        },
      ]),
    );
    configurePetsLibraryRoot(dir);
    const loaded = loadLibrarySheet('bogus');
    expect(loaded.ok).toBe(false);
    expect(loaded.error).toMatch(/WebP/i);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejeita id com caracteres inválidos', () => {
    configurePetsLibraryRoot(REPO_PETS);
    expect(loadLibrarySheet('../navi').ok).toBe(false);
    expect(loadLibrarySheet('NAVI').ok).toBe(false);
    expect(loadLibrarySheet('').ok).toBe(false);
  });
});
