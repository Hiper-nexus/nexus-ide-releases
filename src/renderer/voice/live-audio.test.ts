import { describe, expect, it, vi } from 'vitest';
import {
  base64ToBytes,
  bytesToBase64,
  downsampleFloat,
  floatToInt16Bytes,
  int16BytesToFloat,
  micFrameToBase64,
  scheduledTailMs,
  LiveAudioPlayer,
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

describe('LiveAudioPlayer output readiness', () => {
  it('does not start the first PCM block before sink selection completes', async () => {
    let resolveSink!: () => void;
    const sinkReady = new Promise<void>((resolve) => {
      resolveSink = resolve;
    });
    const start = vi.fn();
    const channel = new Float32Array(240);
    const context = {
      currentTime: 1,
      destination: {},
      state: 'running',
      setSinkId: vi.fn(() => sinkReady),
      resume: vi.fn(() => Promise.resolve()),
      close: vi.fn(() => Promise.resolve()),
      createBuffer: vi.fn(() => ({
        duration: 0.01,
        getChannelData: () => channel,
      })),
      createBufferSource: vi.fn(() => ({
        buffer: null,
        connect: vi.fn(),
        start,
        stop: vi.fn(),
        onended: null,
      })),
    } as unknown as AudioContext;
    const player = new LiveAudioPlayer(() => context);
    const pcm = bytesToBase64(new Uint8Array(480));

    const playing = player.play(pcm);
    await Promise.resolve();
    await Promise.resolve();
    expect(start).not.toHaveBeenCalled();

    resolveSink();
    await expect(playing).resolves.toBeGreaterThanOrEqual(10);
    expect(start).toHaveBeenCalledWith(1);
  });

  it('retries AudioContext readiness after a transient resume rejection', async () => {
    let state: AudioContextState = 'suspended';
    const start = vi.fn();
    const channel = new Float32Array(240);
    const resume = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('gesture required'))
      .mockImplementationOnce(async () => {
        state = 'running';
      });
    const context = {
      currentTime: 1,
      destination: {},
      get state() {
        return state;
      },
      resume,
      close: vi.fn(() => Promise.resolve()),
      createBuffer: vi.fn(() => ({
        duration: 0.01,
        getChannelData: () => channel,
      })),
      createBufferSource: vi.fn(() => ({
        buffer: null,
        connect: vi.fn(),
        start,
        stop: vi.fn(),
        onended: null,
      })),
    } as unknown as AudioContext;
    const player = new LiveAudioPlayer(() => context);
    const pcm = bytesToBase64(new Uint8Array(480));

    await expect(player.play(pcm)).rejects.toThrow('gesture required');
    await expect(player.play(pcm)).resolves.toBeGreaterThanOrEqual(10);
    expect(resume).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenCalledOnce();
  });
});
