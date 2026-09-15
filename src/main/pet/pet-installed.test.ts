import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  deleteInstalledPet,
  ensureDefaultInstalledPets,
  listInstalledPets,
  loadInstalledPet,
} from './pet-installed';

const roots: string[] = [];

const WEBP_MAGIC = Buffer.from('RIFF\u0004\u0000\u0000\u0000WEBP', 'binary');

function writeLibRoot(root: string): string {
  const libRoot = join(root, 'lib');
  mkdirSync(join(libRoot, 'sheets'), { recursive: true });
  writeFileSync(join(libRoot, 'sheets', 'codex-companion.webp'), WEBP_MAGIC);
  writeFileSync(join(libRoot, 'sheets', 'nivu.webp'), WEBP_MAGIC);
  return libRoot;
}

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

describe('ensureDefaultInstalledPets', () => {
  const CODEX_ID = '2e9cd7ac-dabd-4130-9bc5-782986aea0ed';
  const NIVU_ID = 'nivu';

  it('cria spritesheet.webp e pet.json para cada pet padrão ausente', () => {
    const root = mkdtempSync(join(tmpdir(), 'nexus-installed-pet-'));
    roots.push(root);
    const libRoot = writeLibRoot(root);

    ensureDefaultInstalledPets(root, libRoot);

    for (const id of [CODEX_ID, NIVU_ID]) {
      const dir = join(root, 'pets', id);
      const sheet = readFileSync(join(dir, 'spritesheet.webp'));
      expect(sheet).toEqual(WEBP_MAGIC);
      const manifest = JSON.parse(
        readFileSync(join(dir, 'pet.json'), 'utf8'),
      );
      expect(manifest).toMatchObject({
        id,
        spriteVersionNumber: 2,
        spritesheetPath: 'spritesheet.webp',
      });
    }
    expect(listInstalledPets(root).items?.map((i) => i.id).sort()).toEqual(
      [CODEX_ID, NIVU_ID].sort(),
    );
  });

  it('nunca sobrescreve spritesheet.webp ou pet.json já existentes do usuário', () => {
    const root = mkdtempSync(join(tmpdir(), 'nexus-installed-pet-'));
    roots.push(root);
    const libRoot = writeLibRoot(root);
    const dir = join(root, 'pets', NIVU_ID);
    mkdirSync(dir, { recursive: true });
    const userSheet = Buffer.from('minha-sprite-custom-do-usuario');
    const userManifest = JSON.stringify({
      id: NIVU_ID,
      displayName: 'Meu Nivu customizado',
      description: 'Edição pessoal preservada',
      spriteVersionNumber: 2,
      spritesheetPath: 'spritesheet.webp',
    });
    writeFileSync(join(dir, 'spritesheet.webp'), userSheet);
    writeFileSync(join(dir, 'pet.json'), userManifest);

    ensureDefaultInstalledPets(root, libRoot);

    expect(readFileSync(join(dir, 'spritesheet.webp'))).toEqual(userSheet);
    expect(readFileSync(join(dir, 'pet.json'), 'utf8')).toBe(userManifest);
  });

  it('respeita .deleted-preinstalled.json e não recria o id excluído', () => {
    const root = mkdtempSync(join(tmpdir(), 'nexus-installed-pet-'));
    roots.push(root);
    const libRoot = writeLibRoot(root);
    mkdirSync(join(root, 'pets'), { recursive: true });
    writeFileSync(
      join(root, 'pets', '.deleted-preinstalled.json'),
      JSON.stringify([NIVU_ID]),
    );

    ensureDefaultInstalledPets(root, libRoot);

    expect(
      listInstalledPets(root).items?.some((i) => i.id === NIVU_ID),
    ).toBe(false);
    expect(
      listInstalledPets(root).items?.some((i) => i.id === CODEX_ID),
    ).toBe(true);
  });

  it('recusa alvo que é symlink e não escreve dentro dele', () => {
    const root = mkdtempSync(join(tmpdir(), 'nexus-installed-pet-'));
    roots.push(root);
    const libRoot = writeLibRoot(root);
    const outside = join(root, 'outside-target');
    mkdirSync(outside, { recursive: true });
    mkdirSync(join(root, 'pets'), { recursive: true });
    symlinkSync(outside, join(root, 'pets', NIVU_ID), 'dir');

    ensureDefaultInstalledPets(root, libRoot);

    expect(existsSync(join(outside, 'spritesheet.webp'))).toBe(false);
    expect(existsSync(join(outside, 'pet.json'))).toBe(false);
    expect(
      lstatSync(join(root, 'pets', NIVU_ID)).isSymbolicLink(),
    ).toBe(true);
  });

  it('deleteInstalledPet de um pet padrão registra o id em .deleted-preinstalled.json', () => {
    const root = mkdtempSync(join(tmpdir(), 'nexus-installed-pet-'));
    roots.push(root);
    writePackage(root, NIVU_ID, 'Nivu');

    expect(deleteInstalledPet(NIVU_ID, root)).toMatchObject({ ok: true });

    const deletedList = JSON.parse(
      readFileSync(join(root, 'pets', '.deleted-preinstalled.json'), 'utf8'),
    );
    expect(deletedList).toEqual([NIVU_ID]);
  });
});
