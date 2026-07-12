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

const REPO_PETS = path.join(
  process.cwd(),
  'resources',
  'pets',
);

describe('pet-library', () => {
  beforeEach(() => {
    __resetPetLibraryCacheForTests();
  });

  afterEach(() => {
    __resetPetLibraryCacheForTests();
  });

  it('resolvePetsLibraryRoot usa resources/pets empacotado e dev', () => {
    expect(resolvePetsLibraryRoot('/app', '/Resources', true)).toBe(
      path.join('/Resources', 'pets'),
    );
    expect(resolvePetsLibraryRoot('/repo', '/Resources', false)).toBe(
      path.join('/repo', 'resources', 'pets'),
    );
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
    expect(loaded.sheet?.rows).toBe(11);
  });

  it('rejeita id inexistente e path traversal no file do manifest', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-lib-'));
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify([
        {
          id: 'evil',
          slug: 'evil',
          label: 'Evil',
          file: '../outside.webp',
        },
      ]),
    );
    configurePetsLibraryRoot(dir);
    expect(listPetLibrary().items).toEqual([]);
    expect(loadLibrarySheet('missing').ok).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
