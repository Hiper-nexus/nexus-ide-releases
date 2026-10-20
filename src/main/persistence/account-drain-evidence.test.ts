import { afterEach, describe, expect, it } from 'vitest';
import { accountDrainEvidence, DRAIN_THRESHOLD_ENV } from './account-drain-evidence';
import { DRAIN_THRESHOLD } from '../quota/account-headroom';

const NOW = 1_000_000;

afterEach(() => {
  delete process.env[DRAIN_THRESHOLD_ENV];
});

describe('accountDrainEvidence', () => {
  it('exige provider-api e leitura de no máximo 10 min', () => {
    const ev = accountDrainEvidence(NOW);
    expect(ev.requireSource).toBe('provider-api');
    expect(ev.maxAgeMs).toBe(10 * 60 * 1000);
    expect(ev.now).toBe(NOW);
  });

  it('sem env usa o limiar padrão', () => {
    expect(accountDrainEvidence(NOW).threshold).toBe(DRAIN_THRESHOLD);
  });

  it('env válida substitui o limiar', () => {
    process.env[DRAIN_THRESHOLD_ENV] = '0.5';
    expect(accountDrainEvidence(NOW).threshold).toBe(0.5);
  });

  it('env inválida recua para o padrão', () => {
    for (const bad of ['nao-e-numero', '', '  ', 'NaN']) {
      process.env[DRAIN_THRESHOLD_ENV] = bad;
      expect(accountDrainEvidence(NOW).threshold).toBe(DRAIN_THRESHOLD);
    }
  });

  it('env fora de (0,1] recua para o padrão', () => {
    for (const bad of ['0', '-0.5', '1.5', '2']) {
      process.env[DRAIN_THRESHOLD_ENV] = bad;
      expect(accountDrainEvidence(NOW).threshold).toBe(DRAIN_THRESHOLD);
    }
  });

  it('aceita 1 (drenar só no esgotamento) como desligamento prático', () => {
    process.env[DRAIN_THRESHOLD_ENV] = '1';
    expect(accountDrainEvidence(NOW).threshold).toBe(1);
  });
});
