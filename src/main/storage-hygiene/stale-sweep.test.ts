import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { measureDirUsage, newestActivityMs } from './dir-usage';
import { capAppendOnlyFile, keepNewestFiles, pruneEmptyDirs, sweepStaleChildren } from './stale-sweep';

const DAY = 24 * 60 * 60_000;
// Arquivo recém-criado tem mtime/ctime de AGORA; o "futuro" do teste o torna velho.
const FUTURE = Date.now() + 10 * DAY;

let dir: string;

function write(rel: string, body = 'x'): string {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

/** Marca atividade recente (relativa ao FUTURE) — ctime não pode ser recuado, mtime pode avançar. */
function touchRecent(target: string, agoMs = 60_000): void {
  const at = new Date(FUTURE - agoMs);
  fs.utimesSync(target, at, at);
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-hygiene-test-')));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('sweepStaleChildren', () => {
  it('remove só o que casa, está parado além do prazo e não está protegido', async () => {
    write('old/a.bin', 'a'.repeat(10_000));
    write('fresh/b.txt');
    touchRecent(path.join(dir, 'fresh', 'b.txt'));
    write('live/c.txt');
    write('other/d.txt');
    const outcome = await sweepStaleChildren({
      root: dir, now: FUTURE, maxIdleMs: DAY,
      match: (name) => name !== 'other',
      isProtected: (name) => name === 'live',
    });
    expect(outcome).toMatchObject({ removed: 1, kept: 2, errors: 0 });
    expect(outcome.freedBytes).toBeGreaterThanOrEqual(10_000);
    expect(fs.existsSync(path.join(dir, 'old'))).toBe(false);
    expect(fs.readdirSync(dir).sort()).toEqual(['fresh', 'live', 'other']);
  });

  it('atividade num filho (até a profundidade pedida) mantém a pasta', async () => {
    write('deep/a/b/c.txt');
    touchRecent(path.join(dir, 'deep', 'a', 'b'));
    const shallow = await sweepStaleChildren({ root: dir, now: FUTURE, maxIdleMs: DAY, match: () => true, activityDepth: 2 });
    expect(shallow.kept).toBe(1);
    const flat = await sweepStaleChildren({ root: dir, now: FUTURE, maxIdleMs: DAY, match: () => true, activityDepth: 1 });
    expect(flat.removed).toBe(1);
  });

  it('nunca segue nem remove link: o alvo fora da raiz fica intacto', async () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-hygiene-outside-')));
    try {
      fs.writeFileSync(path.join(outside, 'precioso.txt'), 'não apague');
      fs.mkdirSync(path.join(dir, 'pasta'));
      fs.symlinkSync(outside, path.join(dir, 'link'), 'junction');
      // Link DENTRO de uma pasta parada: some só o link, nunca o alvo.
      fs.symlinkSync(outside, path.join(dir, 'pasta', 'node_modules'), 'junction');
      const outcome = await sweepStaleChildren({ root: dir, now: FUTURE, maxIdleMs: DAY, match: () => true });
      expect(outcome.removed).toBe(1);
      expect(fs.lstatSync(path.join(dir, 'link')).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(path.join(outside, 'precioso.txt'), 'utf8')).toBe('não apague');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('beforeRemove falso (resgate falhou) mantém o item', async () => {
    write('a/x.txt');
    write('b/x.txt');
    const outcome = await sweepStaleChildren({
      root: dir, now: FUTURE, maxIdleMs: DAY, match: () => true,
      beforeRemove: (name) => name !== 'a',
    });
    expect(outcome).toMatchObject({ removed: 1, kept: 1 });
    expect(fs.readdirSync(dir)).toEqual(['a']);
  });

  it('para no teto de remoções e conta o resto como adiado', async () => {
    for (const name of ['a', 'b', 'c']) write(`${name}/x.txt`);
    const outcome = await sweepStaleChildren({ root: dir, now: FUTURE, maxIdleMs: DAY, match: () => true, maxRemovals: 1 });
    expect(outcome).toMatchObject({ removed: 1, deferred: 2 });
  });

  it('raiz ausente é rodada vazia', async () => {
    await expect(sweepStaleChildren({ root: path.join(dir, 'nada'), now: FUTURE, maxIdleMs: 0, match: () => true }))
      .resolves.toMatchObject({ removed: 0, errors: 0 });
  });
});

describe('medição', () => {
  it('soma o alocado, não atravessa link e marca truncado no orçamento', async () => {
    write('a/b.bin', 'b'.repeat(50_000));
    fs.symlinkSync('/', path.join(dir, 'raiz'));
    const usage = await measureDirUsage(dir);
    expect(usage.truncated).toBe(false);
    expect(usage.bytes).toBeGreaterThanOrEqual(50_000);
    expect(usage.bytes).toBeLessThan(10 * 1024 * 1024);
    expect((await measureDirUsage(dir, { maxEntries: 1 })).truncated).toBe(true);
  });

  it('pasta grande demais para provar inatividade conta como ativa agora', async () => {
    for (let index = 0; index < 5; index += 1) write(`many/${index}.txt`);
    expect(await newestActivityMs(path.join(dir, 'many'), { maxEntries: 2, now: 42 })).toBe(42);
  });
});

describe('rotação e tetos', () => {
  it('keepNewestFiles mantém as N cópias mais novas', async () => {
    for (const [index, name] of ['runtime-schema-1.sqlite3', 'runtime-schema-2.sqlite3', 'runtime-schema-3.sqlite3'].entries()) {
      const file = write(`backups/${name}`, 'db');
      const at = new Date(Date.now() - (3 - index) * DAY);
      fs.utimesSync(file, at, at);
    }
    write('backups/outro.txt');
    const outcome = await keepNewestFiles(path.join(dir, 'backups'), (name) => name.startsWith('runtime-schema-'), 1);
    expect(outcome).toMatchObject({ removed: 2, kept: 1 });
    expect(fs.readdirSync(path.join(dir, 'backups')).sort()).toEqual(['outro.txt', 'runtime-schema-3.sqlite3']);
  });

  it('capAppendOnlyFile guarda a cauda a partir de uma linha inteira', async () => {
    const file = write('update.log', Array.from({ length: 200 }, (_, index) => `linha ${index}`).join('\n') + '\n');
    const outcome = await capAppendOnlyFile(file, 500, 100);
    const kept = fs.readFileSync(file, 'utf8');
    expect(outcome.freedBytes).toBeGreaterThan(0);
    expect(kept.length).toBeLessThanOrEqual(100);
    expect(kept.endsWith('linha 199\n')).toBe(true);
    expect(kept.startsWith('linha ')).toBe(true);
    // Dentro do teto: intocado.
    expect((await capAppendOnlyFile(file, 10_000, 100)).freedBytes).toBe(0);
  });

  it('pruneEmptyDirs remove só pastas vazias abaixo da raiz', async () => {
    fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
    write('c/keep.txt');
    await pruneEmptyDirs(dir, 2);
    expect(fs.readdirSync(dir)).toEqual(['c']);
  });
});
