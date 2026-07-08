import { describe, expect, it } from 'vitest';
import {
  base64ToBytes,
  bytesToBase64,
  downsampleFloat,
  floatToInt16Bytes,
  int16BytesToFloat,
  micFrameToBase64,
  scheduledTailMs,
} from './live-audio';

describe('scheduledTailMs — DEFECT 2: cobre a fila gapless inteira', () => {
  it('devolve o tempo até a fila DRENAR, não só um chunk', () => {
    // 20s de áudio agendado à frente do relógio atual → suprime ~20s.
    expect(scheduledTailMs(20.5, 0.5)).toBe(20_000);
  });

  it('é zero quando nada está agendado à frente', () => {
    expect(scheduledTailMs(1, 1)).toBe(0);
    expect(scheduledTailMs(0.5, 1)).toBe(0);
  });

  it('ignora valores não-finitos', () => {
    expect(scheduledTailMs(Number.NaN, 0)).toBe(0);
    expect(scheduledTailMs(Infinity, 0)).toBe(0);
  });
});

describe('float ↔ int16', () => {
  it('roundtrip preserva o sinal dentro da precisão do int16', () => {
    const input = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const back = int16BytesToFloat(floatToInt16Bytes(input));
    expect(back.length).toBe(input.length);
    for (let i = 0; i < input.length; i += 1) {
      expect(back[i]).toBeCloseTo(input[i], 3);
    }
  });

  it('clampa fora de [-1,1]', () => {
    const bytes = floatToInt16Bytes(new Float32Array([2, -2]));
    const back = int16BytesToFloat(bytes);
    expect(back[0]).toBeCloseTo(1, 3);
    expect(back[1]).toBeCloseTo(-1, 3);
  });
});

describe('downsampleFloat', () => {
  it('mesma taxa devolve o mesmo array', () => {
    const input = new Float32Array([1, 2, 3]);
    expect(downsampleFloat(input, 16_000, 16_000)).toBe(input);
  });

  it('48k → 16k reduz o comprimento por 3', () => {
    const input = new Float32Array(48);
    const out = downsampleFloat(input, 48_000, 16_000);
    expect(out.length).toBe(16);
  });
});

describe('base64', () => {
  it('roundtrip de bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    expect([...base64ToBytes(bytesToBase64(bytes))]).toEqual([...bytes]);
  });
});

describe('micFrameToBase64', () => {
  it('produz base64 não-vazio de um frame 48k', () => {
    const frame = new Float32Array(480).fill(0.25);
    const b64 = micFrameToBase64(frame, 48_000);
    expect(b64.length).toBeGreaterThan(0);
    // 480 amostras / 3 = 160 amostras × 2 bytes = 320 bytes
    expect(base64ToBytes(b64).length).toBe(320);
  });
});
