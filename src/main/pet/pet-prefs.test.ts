import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultPetPrefs, PET_CUSTOM_GRID_SIZE } from '../../shared/pet-types';
import { loadPetPrefs, petPrefsPath, savePetPrefs } from './pet-prefs';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'nexus-pet-prefs-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('pet prefs persistence', () => {
  it('devolve defaults quando o arquivo não existe', () => {
    expect(loadPetPrefs(dir, 'darwin')).toEqual(defaultPetPrefs('darwin'));
  });

  it('linux nasce com fundo sólido por padrão; mac não', () => {
    expect(loadPetPrefs(dir, 'linux').solidBackground).toBe(true);
    expect(loadPetPrefs(dir, 'darwin').solidBackground).toBe(false);
  });

  it('salva e recarrega um round-trip fiel', () => {
    const prefs = {
      ...defaultPetPrefs('darwin'),
      enabled: true,
      sleeping: true,
      preset: 'flame' as const,
      position: { x: 120, y: 340 },
    };
    savePetPrefs(dir, prefs);
    expect(loadPetPrefs(dir, 'darwin')).toEqual(prefs);
  });

  it('descarta lixo persistido e campos malformados', () => {
    writeFileSync(
      petPrefsPath(dir),
      JSON.stringify({
        enabled: 'yes',
        preset: 'dragon',
        position: { x: 'a', y: 2 },
        customGrid: [['#zzzzzz']],
        extra: 42,
      }),
      'utf8',
    );
    expect(loadPetPrefs(dir, 'darwin')).toEqual(defaultPetPrefs('darwin'));
  });

  it('sobrevive a JSON corrompido', () => {
    writeFileSync(petPrefsPath(dir), '{not json', 'utf8');
    expect(loadPetPrefs(dir, 'darwin')).toEqual(defaultPetPrefs('darwin'));
  });

  it('aceita um customGrid 16×16 válido', () => {
    const grid = Array.from({ length: PET_CUSTOM_GRID_SIZE }, () =>
      Array.from({ length: PET_CUSTOM_GRID_SIZE }, () => '#ff0044' as const),
    );
    savePetPrefs(dir, {
      ...defaultPetPrefs('darwin'),
      preset: 'custom',
      customGrid: grid,
    });
    const loaded = loadPetPrefs(dir, 'darwin');
    expect(loaded.preset).toBe('custom');
    expect(loaded.customGrid).toEqual(grid);
  });

  it('aceita spritesheet Codex v2 válido e rejeita dataUrl malformado', () => {
    const sheet = {
      dataUrl: `data:image/webp;base64,${'A'.repeat(400)}`,
      cols: 8,
      rows: 11,
    };
    savePetPrefs(dir, {
      ...defaultPetPrefs('darwin'),
      preset: 'sheet',
      sheet,
    });
    expect(loadPetPrefs(dir, 'darwin').sheet).toEqual(sheet);

    writeFileSync(
      petPrefsPath(dir),
      JSON.stringify({
        sheet: { dataUrl: 'javascript:alert(1)', cols: 8, rows: 11 },
      }),
      'utf8',
    );
    expect(loadPetPrefs(dir, 'darwin').sheet).toBeNull();
  });

  it('escreve com newline final e sem arquivo tmp remanescente', () => {
    savePetPrefs(dir, defaultPetPrefs('darwin'));
    const raw = readFileSync(petPrefsPath(dir), 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(() => readFileSync(`${petPrefsPath(dir)}.tmp`)).toThrow();
  });
});
