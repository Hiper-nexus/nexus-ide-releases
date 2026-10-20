import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { pruneVitestModuleCache } from './vitest-cache-budget';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-vitest-cache-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function entry(name: string, ageMinutes: number): void {
  const file = path.join(dir, name);
  fs.writeFileSync(file, 'x'.repeat(8192));
  const at = new Date(Date.now() - ageMinutes * 60_000);
  fs.utimesSync(file, at, at);
}

it('dentro do teto não toca em nada', () => {
  entry('a', 1);
  expect(pruneVitestModuleCache(dir, 1024 * 1024)).toMatchObject({ removed: 0, freedBytes: 0 });
  expect(fs.readdirSync(dir)).toEqual(['a']);
});

it('acima do teto apaga os mais antigos até 3/4 do teto', () => {
  for (let index = 0; index < 10; index += 1) entry(`e${index}`, 100 - index);
  const one = fs.lstatSync(path.join(dir, 'e0'));
  const unit = one.blocks > 0 ? one.blocks * 512 : one.size;
  const result = pruneVitestModuleCache(dir, unit * 8);
  // 10 unidades, alvo 6: saem as 4 mais antigas.
  expect(result.removed).toBe(4);
  expect(fs.readdirSync(dir).sort()).toEqual(['e4', 'e5', 'e6', 'e7', 'e8', 'e9']);
});

it('pasta ausente é rodada vazia', () => {
  expect(pruneVitestModuleCache(path.join(dir, 'nada'))).toEqual({ removed: 0, freedBytes: 0, totalBytes: 0 });
});
