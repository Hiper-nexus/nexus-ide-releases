import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JarvisMemory, slugifyMemoryKey } from './jarvis-memory';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-mem-'));
  file = path.join(dir, 'memory.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeMemory(start = 1_000) {
  let now = start;
  const mem = new JarvisMemory(file, () => now);
  return { mem, advance: (ms: number) => (now += ms) };
}

describe('slugifyMemoryKey', () => {
  it('gera slug estável sem acentos', () => {
    expect(slugifyMemoryKey('Preferência de Café!')).toBe('preferencia-de-cafe');
  });
});

describe('JarvisMemory', () => {
  it('lembra e lista fatos, mais recentes primeiro', () => {
    const { mem, advance } = makeMemory();
    mem.remember('cafe', 'gosta de café sem açúcar');
    advance(10);
    mem.remember('deploy', 'deploy é sempre na sexta');
    expect(mem.list().map((f) => f.key)).toEqual(['deploy', 'cafe']);
  });

  it('supersede: regravar a mesma key atualiza sem duplicar e guarda histórico', () => {
    const { mem, advance } = makeMemory();
    mem.remember('cafe', 'gosta de café com açúcar');
    advance(10);
    mem.remember('cafe', 'gosta de café sem açúcar');
    const facts = mem.list();
    expect(facts).toHaveLength(1);
    expect(facts[0].content).toBe('gosta de café sem açúcar');
  });

  it('mesmo conteúdo ativo é no-op (não persiste de novo)', () => {
    const { mem } = makeMemory();
    mem.remember('cafe', 'sem açúcar');
    const before = fs.statSync(file).mtimeMs;
    mem.remember('cafe', 'sem açúcar');
    expect(fs.statSync(file).mtimeMs).toBe(before);
  });

  it('forget é soft-delete e redizer o fato o ressuscita', () => {
    const { mem, advance } = makeMemory();
    mem.remember('cafe', 'sem açúcar');
    expect(mem.forget('cafe')).toBe(true);
    expect(mem.list()).toHaveLength(0);
    advance(10);
    mem.remember('cafe', 'sem açúcar');
    expect(mem.list()).toHaveLength(1);
  });

  it('forget de key inexistente retorna false', () => {
    const { mem } = makeMemory();
    expect(mem.forget('nada')).toBe(false);
  });

  it('persiste entre instâncias (sobrevive ao restart)', () => {
    const { mem } = makeMemory();
    mem.remember('cafe', 'sem açúcar');
    const reloaded = new JarvisMemory(file);
    expect(reloaded.list()[0]?.content).toBe('sem açúcar');
  });

  it('factsBlock respeita o cap de chars priorizando os recentes', () => {
    const { mem, advance } = makeMemory();
    for (let i = 0; i < 50; i++) {
      mem.remember(`fato-${i}`, `conteúdo do fato número ${i} com algum texto`);
      advance(1);
    }
    const block = mem.factsBlock(200);
    expect(block.length).toBeLessThanOrEqual(200);
    expect(block).toContain('fato-49');
  });

  it('arquivo corrompido degrada para memória vazia sem crash', () => {
    fs.writeFileSync(file, '{corrompido');
    const { mem } = makeMemory();
    expect(mem.list()).toEqual([]);
    mem.remember('cafe', 'sem açúcar');
    expect(mem.list()).toHaveLength(1);
  });
});
