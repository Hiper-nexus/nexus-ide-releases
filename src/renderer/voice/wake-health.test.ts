import { describe, expect, it } from 'vitest';

import { classifyMicHealth, frameIsSilent, MIC_NOISE_FLOOR } from './wake-health';

/**
 * Saúde do mic =(classifica permissão + quanto tempo silencioso) → ação da UI.
 * Puro, sem deps de áudio, pra rodar no vitest.
 */
describe('wake-health frameIsSilent', () => {
  it('RMS abaixo do piso de ruído = silêncio', () => {
    expect(frameIsSilent(0)).toBe(true);
    expect(frameIsSilent(0.001)).toBe(true);
  });

  it('RMS de fala real = NÃO silêncio', () => {
    expect(frameIsSilent(0.05)).toBe(false);
    expect(frameIsSilent(0.2)).toBe(false);
  });

  it('não-número vira silêncio (defensivo)', () => {
    expect(frameIsSilent(NaN)).toBe(true);
    expect(frameIsSilent(Number.POSITIVE_INFINITY)).toBe(true);
  });

  it('limiar default bate com NOISE_FLOOR', () => {
    expect(frameIsSilent(MIC_NOISE_FLOOR)).toBe(false);
    expect(frameIsSilent(MIC_NOISE_FLOOR - 1e-6)).toBe(true);
  });
});

describe('wake-health classifyMicHealth', () => {
  const TH = 12_000;

  it('permissão negada → needsPermission', () => {
    expect(classifyMicHealth('denied', 0, TH)).toBe('needsPermission');
  });

  it('permissão indefinida (prompt) → needsPermission', () => {
    expect(classifyMicHealth('prompt', 0, TH)).toBe('needsPermission');
  });

  it('granted e ainda não passou do limiar silencioso → ok', () => {
    expect(classifyMicHealth('granted', 0, TH)).toBe('ok');
    expect(classifyMicHealth('granted', 5_000, TH)).toBe('ok');
  });

  it('granted e silencioso além do limiar → silent', () => {
    expect(classifyMicHealth('granted', TH, TH)).toBe('silent');
    expect(classifyMicHealth('granted', 20_000, TH)).toBe('silent');
  });

  it('unknown (ainda não consultou) → ok (não alarmar cedo)', () => {
    expect(classifyMicHealth('unknown', 99_000, TH)).toBe('ok');
  });
});

describe('phantomGrant (TCC fantasma — WAKE-BROKEN-001)', () => {
  it('granted + zeros sustentados = phantomGrant (prioridade sobre silent)', () => {
    expect(
      classifyMicHealth('granted', 15_000, 12_000, {
        zeroMs: 11_000,
        zeroThresholdMs: 10_000,
      }),
    ).toBe('phantomGrant');
  });

  it('granted + silêncio ambiente (rms > 0) continua silent, não phantom', () => {
    expect(
      classifyMicHealth('granted', 15_000, 12_000, { zeroMs: 0 }),
    ).toBe('silent');
  });

  it('zeros abaixo do limiar ainda não alarmam', () => {
    expect(
      classifyMicHealth('granted', 3_000, 12_000, { zeroMs: 3_000 }),
    ).toBe('ok');
  });

  it('sem permissão ganha de phantom (o fix é outro)', () => {
    expect(
      classifyMicHealth('denied', 15_000, 12_000, { zeroMs: 15_000 }),
    ).toBe('needsPermission');
  });

  it('assinatura antiga (3 args) continua funcionando', () => {
    expect(classifyMicHealth('granted', 15_000, 12_000)).toBe('silent');
  });
});
