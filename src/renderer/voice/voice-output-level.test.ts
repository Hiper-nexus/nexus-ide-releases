/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OUTPUT_LEVEL_ATTACK,
  OUTPUT_LEVEL_RELEASE,
  OutputLevelMeter,
  outputLevelTarget,
  rmsOf,
  smoothOutputLevel,
} from './voice-output-level';
import { useVoiceStore } from './voice-store';

describe('parte numérica do nível de saída', () => {
  it('rmsOf: RMS de amostras [-1,1], 0 se vazio', () => {
    expect(rmsOf(new Float32Array([0.5, 0.5, 0.5, 0.5]))).toBeCloseTo(0.5, 10);
    expect(rmsOf(new Float32Array([0, 0.5]))).toBeCloseTo(Math.sqrt(0.125), 10);
    expect(rmsOf(new Float32Array(0))).toBe(0);
  });

  it('outputLevelTarget aplica o ganho e trava em [0,1]', () => {
    expect(outputLevelTarget(0.1)).toBeCloseTo(0.4, 10);
    expect(outputLevelTarget(0.5)).toBe(1); // 0.5 × 4 trava no teto
    expect(outputLevelTarget(-1)).toBe(0);
  });

  it('smoothOutputLevel ataca rápido e libera devagar', () => {
    expect(smoothOutputLevel(0, 1)).toBeCloseTo(OUTPUT_LEVEL_ATTACK, 10);
    expect(smoothOutputLevel(1, 0)).toBeCloseTo(1 - OUTPUT_LEVEL_RELEASE, 10);
    expect(OUTPUT_LEVEL_ATTACK).toBeGreaterThan(OUTPUT_LEVEL_RELEASE);
  });
});

/** Relógio manual: rAF enfileirado, o teste conduz os quadros. */
function manualRaf() {
  const queue = new Map<number, FrameRequestCallback>();
  let id = 0;
  let cancels = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    queue.set(++id, cb);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (i: number) => {
    if (queue.delete(i)) cancels += 1;
  });
  return {
    step() {
      const callbacks = [...queue.values()];
      queue.clear();
      for (const cb of callbacks) cb(16);
    },
    pending: () => queue.size,
    cancels: () => cancels,
  };
}

/** Contexto WebAudio falso: analisador com amostras constantes `amp`. */
function fakeAudio(amp: number) {
  const analyser = {
    fftSize: 0,
    connect: vi.fn(),
    disconnect: vi.fn(),
    getFloatTimeDomainData: vi.fn((buf: Float32Array) => {
      buf.fill(amp);
    }),
  };
  const ctx = {
    destination: {},
    createAnalyser: vi.fn(() => analyser),
  } as unknown as AudioContext;
  const source = { connect: vi.fn(), disconnect: vi.fn() } as unknown as AudioNode;
  return { ctx, analyser, source };
}

describe('OutputLevelMeter', () => {
  let raf: ReturnType<typeof manualRaf>;

  beforeEach(() => {
    raf = manualRaf();
    useVoiceStore.setState({ status: 'idle', level: 0, outputLevel: 0 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useVoiceStore.setState({ status: 'idle', level: 0, outputLevel: 0 });
  });

  it('insere a fonte no caminho (source → analyser → destination)', () => {
    const meter = new OutputLevelMeter();
    const { ctx, analyser, source } = fakeAudio(0.5);
    meter.tap(ctx, source);
    expect(ctx.createAnalyser).toHaveBeenCalledTimes(1);
    expect(source.connect).toHaveBeenCalledWith(analyser);
    expect(analyser.connect).toHaveBeenCalledWith((ctx as { destination: {} }).destination);
    expect(analyser.fftSize).toBeGreaterThan(0);
  });

  it('durante speaking publica o RMS suavizado em outputLevel', () => {
    useVoiceStore.setState({ status: 'speaking' });
    const meter = new OutputLevelMeter();
    const { ctx, source } = fakeAudio(0.5); // RMS 0.5 → alvo 1 (ganho 4x, teto)
    meter.tap(ctx, source);
    raf.step();
    const first = useVoiceStore.getState().outputLevel;
    expect(first).toBeCloseTo(OUTPUT_LEVEL_ATTACK, 10);
    raf.step();
    expect(useVoiceStore.getState().outputLevel).toBeGreaterThan(first);
  });

  it('ao sair de speaking zera o outputLevel', () => {
    useVoiceStore.setState({ status: 'speaking' });
    const meter = new OutputLevelMeter();
    const { ctx, source } = fakeAudio(0.5);
    meter.tap(ctx, source);
    raf.step();
    expect(useVoiceStore.getState().outputLevel).toBeGreaterThan(0);

    useVoiceStore.setState({ status: 'idle' });
    raf.step();
    expect(useVoiceStore.getState().outputLevel).toBe(0);
  });

  it('solturar o tap desconecta o analisador, zera o nível e encerra o loop', () => {
    useVoiceStore.setState({ status: 'speaking' });
    const meter = new OutputLevelMeter();
    const { ctx, analyser, source } = fakeAudio(0.5);
    const untap = meter.tap(ctx, source);
    raf.step();
    expect(useVoiceStore.getState().outputLevel).toBeGreaterThan(0);
    expect(raf.pending()).toBe(1);

    untap();
    expect(source.disconnect).toHaveBeenCalledWith(analyser);
    expect(analyser.disconnect).toHaveBeenCalledTimes(1);
    expect(useVoiceStore.getState().outputLevel).toBe(0);

    // Sem taps o loop se encerra sozinho no próximo quadro.
    raf.step();
    expect(raf.pending()).toBe(0);
  });

  it('duas fontes no mesmo contexto mantêm o analisador até a última sair', () => {
    const meter = new OutputLevelMeter();
    const { ctx, analyser, source } = fakeAudio(0.3);
    const source2 = { connect: vi.fn(), disconnect: vi.fn() } as unknown as AudioNode;
    const untap1 = meter.tap(ctx, source);
    const untap2 = meter.tap(ctx, source2);
    expect(ctx.createAnalyser).toHaveBeenCalledTimes(1); // um analyser por ctx

    untap1();
    expect(analyser.disconnect).not.toHaveBeenCalled();
    untap2();
    expect(analyser.disconnect).toHaveBeenCalledTimes(1);
  });
});
