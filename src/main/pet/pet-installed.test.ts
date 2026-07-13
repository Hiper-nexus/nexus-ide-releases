import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  deleteInstalledPet,
  listInstalledPets,
  loadInstalledPet,
} from './pet-installed';

const roots: string[] = [];

function writePackage(root: string, id: string, displayName = 'Navi'): void {
  const dir = join(root, 'pets', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'spritesheet.webp'),
    Buffer.from('RIFF\u0004\u0000\u0000\u0000WEBP', 'binary'),
  );
  writeFileSync(
    join(dir, 'pet.json'),
    JSON.stringify({
      id,
      displayName,
      description: 'Pet criado com IA',
      spriteVersionNumber: 2,
      spritesheetPath: 'spritesheet.webp',
    }),
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('installed Codex pets', () => {
  it('lists and previews a complete Pet Studio package', () => {
    const root = mkdtempSync(join(tmpdir(), 'nexus-installed-pet-'));
    roots.push(root);
    writePackage(root, 'navi');

    expect(listInstalledPets(root)).toEqual({
      ok: true,
      items: [
        {
          id: 'navi',
          slug: 'navi',
          label: 'Navi',
          note: 'Pet criado com IA',
        },
      ],
    });
    expect(loadInstalledPet('navi', root)).toMatchObject({
      ok: true,
      name: 'Navi',
      sheet: { cols: 8, rows: 11 },
    });
  });

  it('hides malformed packages and rejects traversal ids', () => {
    const root = mkdtempSync(join(tmpdir(), 'nexus-installed-pet-'));
    roots.push(root);
    mkdirSync(join(root, 'pets', 'broken'), { recursive: true });
    writeFileSync(join(root, 'pets', 'broken', 'pet.json'), '{}');

    expect(listInstalledPets(root)).toEqual({ ok: true, items: [] });
    expect(loadInstalledPet('../outside', root)).toMatchObject({ ok: false });
  });

  it('deleteInstalledPet remove o pacote e rejeita traversal', () => {
    const root = mkdtempSync(join(tmpdir(), 'nexus-installed-pet-'));
    roots.push(root);
    writePackage(root, 'nivu', 'Nivu');
    expect(listInstalledPets(root).items?.map((i) => i.id)).toEqual(['nivu']);

    expect(deleteInstalledPet('nivu', root)).toEqual({
      ok: true,
      name: 'Nivu',
    });
    expect(listInstalledPets(root)).toEqual({ ok: true, items: [] });
    expect(deleteInstalledPet('../outside', root)).toMatchObject({
      ok: false,
    });
    expect(deleteInstalledPet('missing', root)).toMatchObject({ ok: false });
  });
});
