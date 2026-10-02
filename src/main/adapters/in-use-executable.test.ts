import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  moveExecutableAside,
  removeStaleExecutableCopies,
  restoreExecutableIfMissing,
  type InUseExecutableFs,
} from './in-use-executable';

let root = '';

afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = '';
});

function binDir(): string {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-in-use-exe-'));
  const dir = path.join(root, 'devin', 'cli', 'bin');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe('executável em uso fora do caminho do instalador (F-747)', () => {
  it('renomeia o atual para .old-<marca> e o instalador encontra o caminho livre', () => {
    const dir = binDir();
    const entry = path.join(dir, 'devin.exe');
    fs.writeFileSync(entry, 'antigo');
    const aside = moveExecutableAside(entry, '1790000000000');
    expect(aside).toBe(`${entry}.old-1790000000000`);
    expect(fs.existsSync(entry)).toBe(false);
    expect(fs.readFileSync(aside!, 'utf8')).toBe('antigo');
  });

  it('sem executável não há o que mover', () => {
    const dir = binDir();
    expect(moveExecutableAside(path.join(dir, 'devin.exe'), '1')).toBeNull();
  });

  it('instalador que falhou sem binário novo devolve o antigo; com binário novo não mexe', () => {
    const dir = binDir();
    const entry = path.join(dir, 'devin.exe');
    fs.writeFileSync(entry, 'antigo');
    const aside = moveExecutableAside(entry, '2');
    expect(restoreExecutableIfMissing(entry, aside)).toBe(true);
    expect(fs.readFileSync(entry, 'utf8')).toBe('antigo');

    const again = moveExecutableAside(entry, '3');
    fs.writeFileSync(entry, 'novo');
    expect(restoreExecutableIfMissing(entry, again)).toBe(false);
    expect(fs.readFileSync(entry, 'utf8')).toBe('novo');
  });

  it('limpa as cópias velhas que não estão em uso e mantém a que um pane ainda roda', () => {
    const dir = binDir();
    const entry = path.join(dir, 'devin.exe');
    for (const name of ['devin.exe', 'devin.exe.old-3000.10.27', 'devin.exe.old-3000.11.1', 'outra.exe.old-1']) {
      fs.writeFileSync(path.join(dir, name), name);
    }
    const busy = path.join(dir, 'devin.exe.old-3000.11.1');
    // No Windows a cópia em uso recusa a remoção; aqui a recusa é simulada.
    const fakeFs: InUseExecutableFs = {
      existsSync: fs.existsSync,
      renameSync: fs.renameSync,
      readdirSync: fs.readdirSync,
      rmSync: (target, options) => {
        if (target === busy) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
        fs.rmSync(target, options);
      },
    };
    expect(removeStaleExecutableCopies(entry, fakeFs)).toEqual(['devin.exe.old-3000.10.27']);
    expect(fs.readdirSync(dir).sort()).toEqual([
      'devin.exe',
      'devin.exe.old-3000.11.1',
      'outra.exe.old-1',
    ]);
  });
});
