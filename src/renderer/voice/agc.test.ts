import { describe, expect, it } from 'vitest';
import { AGC_MAX_GAIN, AGC_TARGET_RMS, SoftAgc } from './agc';

function frameWithRms(rms: number, len = 1280): Float32Array {
  // Onda quadrada ±rms tem RMS exatamente rms.
  const f = new Float32Array(len);
  for (let i = 0; i < len; i += 1) f[i] = i % 2 === 0 ? rms : -rms;
  return f;
}

function rmsOf(f: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < f.length; i += 1) sum += f[i] * f[i];
  return Math.sqrt(sum / f.length);
}

describe('SoftAgc', () => {
  it('amplifica fala fraca gradualmente em direção ao alvo', () => {
    const agc = new SoftAgc(1);
    // Fala fraca sustentada (RMS 0.02, como o fifine entrega).
    let out = 0;
    for (let i = 0; i < 200; i += 1) {
      const f = frameWithRms(0.02);
      agc.process(f);
      out = rmsOf(f);
    }
    // Depois de ~16s de fala, o RMS de saída deve estar perto do alvo.
    expect(out).toBeGreaterThan(AGC_TARGET_RMS * 0.5);
    expect(agc.currentGain()).toBeLessThanOrEqual(AGC_MAX_GAIN);
  });

  it('reduz o ganho rapidamente quando o usuário fala perto/alto', () => {
    const agc = new SoftAgc(12);
    // Grito perto do mic: RMS cru 0.4 — com ganho 12 estouraria.
    const f = frameWithRms(0.4);
    agc.process(f);
    expect(agc.currentGain()).toBeLessThan(12);
    // Saída nunca passa de ±1 (clamp).
    expect(Math.max(...f)).toBeLessThanOrEqual(1);
  });

  it('NÃO adapta sobre silêncio/ruído de fundo', () => {
    const agc = new SoftAgc(12);
    for (let i = 0; i < 100; i += 1) agc.process(frameWithRms(0.004));
    // Ambiente (abaixo do piso de fala) não puxa o ganho para o teto.
    expect(agc.currentGain()).toBe(12);
  });

  it('ganho fica dentro dos limites em qualquer sequência', () => {
    const agc = new SoftAgc(12);
    for (const rms of [0.5, 0.001, 0.02, 0.9, 0.015, 0]) {
      agc.process(frameWithRms(rms));
      expect(agc.currentGain()).toBeGreaterThanOrEqual(1);
      expect(agc.currentGain()).toBeLessThanOrEqual(AGC_MAX_GAIN);
    }
  });

  it('devolve o RMS cru do frame para telemetria', () => {
    const agc = new SoftAgc(1);
    const raw = agc.process(frameWithRms(0.05));
    expect(raw).toBeCloseTo(0.05, 2);
  });
});
