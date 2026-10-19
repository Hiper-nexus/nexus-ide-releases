import { beforeEach, describe, expect, it } from 'vitest';
import {
  drainedAccountIds,
  drainMemoryUntil,
  forgetAccountDrain,
  forgetDrainMemory,
  isRememberedDrained,
  noteAccountDrained,
} from './account-drain-memory';

const NOW = 1_000_000;
const HOUR = 3_600_000;

beforeEach(() => forgetDrainMemory());

describe('memória de drenagem', () => {
  it('conta anotada continua drenada até a janela reabrir', () => {
    noteAccountDrained('a', NOW + HOUR);
    expect(isRememberedDrained('a', NOW)).toBe(true);
    expect(isRememberedDrained('a', NOW + HOUR - 1)).toBe(true);
  });

  it('a memória expira quando a janela reabre', () => {
    noteAccountDrained('a', NOW + HOUR);
    expect(isRememberedDrained('a', NOW + HOUR)).toBe(false);
  });

  it('conta nunca anotada não está drenada', () => {
    expect(isRememberedDrained('b', NOW)).toBe(false);
  });

  it('a anotação mais longa vence: janela que reabre depois manda', () => {
    noteAccountDrained('a', NOW + HOUR);
    noteAccountDrained('a', NOW + 2 * HOUR);
    expect(isRememberedDrained('a', NOW + HOUR + 1)).toBe(true);
    noteAccountDrained('a', NOW + HOUR);
    expect(isRememberedDrained('a', NOW + HOUR + 1)).toBe(true);
  });

  it('reabertura no passado não anota', () => {
    noteAccountDrained('a', NOW - 1);
    expect(isRememberedDrained('a', NOW)).toBe(false);
  });

  it('lista só as que ainda valem, e a leitura limpa as vencidas', () => {
    noteAccountDrained('a', NOW + HOUR);
    noteAccountDrained('b', NOW + 1);
    expect(drainedAccountIds(NOW)).toEqual(new Set(['a', 'b']));
    expect(drainedAccountIds(NOW + 2)).toEqual(new Set(['a']));
  });

  it('forgetDrainMemory zera tudo (ciclo de vida)', () => {
    noteAccountDrained('a', NOW + HOUR);
    forgetDrainMemory();
    expect(isRememberedDrained('a', NOW)).toBe(false);
  });
});

describe('a memória cede a prova fresca em contrário', () => {
  it('leitura abaixo do limiar esquece a conta', () => {
    noteAccountDrained('a', NOW + HOUR);
    forgetAccountDrain('a');
    expect(isRememberedDrained('a', NOW)).toBe(false);
  });

  it('esquecer conta que não está anotada é inócuo', () => {
    expect(() => forgetAccountDrain('fantasma')).not.toThrow();
  });
});

describe('drainMemoryUntil — até quando lembrar', () => {
  const FALLBACK = 60 * 60_000;

  it('reset futuro manda, mesmo mais curto que o fallback', () => {
    // Um bucket de 5 Horas que cruza o limiar 5 min antes de reabrir não pode
    // ficar fora da preferência por mais 55 min — e, no modo fila, uma conta
    // que não é escolhida não ganha leitura nova que limpe a lembrança.
    expect(drainMemoryUntil(NOW + 5 * 60_000, NOW, FALLBACK)).toBe(NOW + 5 * 60_000);
  });

  it('reset futuro mais longo que o fallback também manda', () => {
    expect(drainMemoryUntil(NOW + 5 * HOUR, NOW, FALLBACK)).toBe(NOW + 5 * HOUR);
  });

  it('sem reset conhecido vale o fallback', () => {
    expect(drainMemoryUntil(undefined, NOW, FALLBACK)).toBe(NOW + FALLBACK);
  });

  it('reset já vencido vale o fallback: lembrança que expira no mesmo instante faz quicar', () => {
    expect(drainMemoryUntil(NOW - 1, NOW, FALLBACK)).toBe(NOW + FALLBACK);
    expect(drainMemoryUntil(NOW, NOW, FALLBACK)).toBe(NOW + FALLBACK);
  });

  it('reset não finito vale o fallback', () => {
    expect(drainMemoryUntil(Number.NaN, NOW, FALLBACK)).toBe(NOW + FALLBACK);
  });
});
