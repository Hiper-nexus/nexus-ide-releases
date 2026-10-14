import { describe, expect, it } from 'vitest';
import {
  loadSpecialtyBenchmark,
  parseSpecialtyBenchmark,
} from './specialty-benchmark';

describe('parseSpecialtyBenchmark', () => {
  it('rejeita schema errado e aceita especialidades conhecidas', () => {
    expect(parseSpecialtyBenchmark({ schemaVersion: 2, source: 'x' })).toBeNull();
    const parsed = parseSpecialtyBenchmark({
      schemaVersion: 1,
      source: 'nexus-benchmark/v1',
      specialties: {
        visual: [{ adapterId: 'agy', score: 88, effort: 'high' }],
        nope: [{ adapterId: 'glm' }],
      },
    });
    expect(parsed?.specialties.visual?.[0]?.adapterId).toBe('agy');
    expect(parsed?.specialties).not.toHaveProperty('nope');
  });
});

describe('loadSpecialtyBenchmark', () => {
  it('published vazio continua sem especialidades medidas', () => {
    const loaded = loadSpecialtyBenchmark();
    expect(loaded.schemaVersion).toBe(1);
    expect(Object.keys(loaded.specialties)).toHaveLength(0);
  });

  // A6 (perf spawn): o overlay do operador era relido a cada rota.
  it('cache por mtime: conteúdo novo com mtime igual não é relido', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { USER_SPECIALTY_BENCHMARK_FILE, __resetSpecialtyBenchmarkCacheForTests } =
      await import('./specialty-benchmark');
    __resetSpecialtyBenchmarkCacheForTests();
    fs.mkdirSync(path.dirname(USER_SPECIALTY_BENCHMARK_FILE), { recursive: true });
    const write = (adapterId: string) =>
      fs.writeFileSync(
        USER_SPECIALTY_BENCHMARK_FILE,
        JSON.stringify({
          schemaVersion: 1,
          source: 'test',
          specialties: { visual: [{ adapterId, score: 88, effort: 'high' }] },
        }),
      );
    write('agy');
    const at = fs.statSync(USER_SPECIALTY_BENCHMARK_FILE).mtime;
    try {
      const first = loadSpecialtyBenchmark();
      expect(first.specialties.visual?.[0]?.adapterId).toBe('agy');
      // Troca o conteúdo mas restaura o mtime: o cache por mtime deve vencer.
      write('codex');
      fs.utimesSync(USER_SPECIALTY_BENCHMARK_FILE, at, at);
      const cached = loadSpecialtyBenchmark();
      expect(cached.specialties.visual?.[0]?.adapterId).toBe('agy');
      // Sem cache (reset) o conteúdo novo aparece.
      __resetSpecialtyBenchmarkCacheForTests();
      const fresh = loadSpecialtyBenchmark();
      expect(fresh.specialties.visual?.[0]?.adapterId).toBe('codex');
    } finally {
      fs.rmSync(USER_SPECIALTY_BENCHMARK_FILE, { force: true });
      __resetSpecialtyBenchmarkCacheForTests();
    }
  });
});
