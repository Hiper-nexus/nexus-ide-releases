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
});
