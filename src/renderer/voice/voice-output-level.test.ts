/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OUTPUT_LATENCY_MAX_MS,
  OUTPUT_LEVEL_ATTACK,
  OUTPUT_LEVEL_RELEASE,
  OutputLevelMeter,
  outputLatencyMs,
  outputLevelTarget,
  rmsOf,
  smoothOutputLevel,
  spectralBrightness,
  VoiceFrameDelayLine,
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

/** Espectro em dB com um pico de `peakDb` na faixa [fromHz, toHz] e o resto em silêncio. */
function spectrumWithPeak(sampleRate: number, fftSize: number, fromHz: number, toHz: number, peakDb = -20) {
  const bins = new Float32Array(fftSize / 2).fill(-140);
  const binHz = sampleRate / fftSize;
  for (let i = Math.ceil(fromHz / binHz); i <= Math.floor(toHz / binHz); i += 1) bins[i] = peakDb;
  return bins;
}

describe('forma da voz: brilho espectral', () => {
  it('vogal aberta (formantes graves) é escura; chiado (agudos) é brilhante', () => {
    for (const rate of [24_000, 48_000]) {
      const vowel = spectralBrightness(spectrumWithPeak(rate, 512, 300, 900), rate, 512);
      const hiss = spectralBrightness(spectrumWithPeak(rate, 512, 3000, 5500), rate, 512);
      expect(vowel).toBeLessThan(0.1);
      expect(hiss).toBeGreaterThan(0.9);
    }
  });

  it('mistura fica no meio; silêncio, buffer vazio e taxa inválida devolvem 0', () => {
    const rate = 24_000;
    const bins = spectrumWithPeak(rate, 512, 300, 900, -20);
    const high = spectrumWithPeak(rate, 512, 3000, 5000, -30); // agudos 10 dB abaixo (um "e")
    for (let i = 0; i < bins.length; i += 1) bins[i] = Math.max(bins[i]!, high[i]!);
    const mixed = spectralBrightness(bins, rate, 512);
    expect(mixed).toBeGreaterThan(0.1);
    expect(mixed).toBeLessThan(0.9);
    expect(spectralBrightness(new Float32Array(256).fill(-Infinity), rate, 512)).toBe(0);
    expect(spectralBrightness(new Float32Array(0), rate, 512)).toBe(0);
    expect(spectralBrightness(bins, 0, 512)).toBe(0);
  });
});

describe('compensação da latência de saída', () => {
  it('soma base + saída em ms, trava no teto e ignora campo ausente', () => {
    expect(outputLatencyMs({ baseLatency: 0.01, outputLatency: 0.03 })).toBeCloseTo(40, 6);
    expect(outputLatencyMs({ baseLatency: 0.01, outputLatency: 2 })).toBe(OUTPUT_LATENCY_MAX_MS);
    expect(outputLatencyMs({ baseLatency: undefined, outputLatency: undefined } as never)).toBe(0);
    expect(outputLatencyMs(null)).toBe(0);
  });

  it('a linha de atraso devolve o quadro medido `delay` atrás (o que o ouvido escuta agora)', () => {
    const line = new VoiceFrameDelayLine();
    expect(line.read(0, 40)).toEqual({ level: 0, brightness: 0 }); // vazio = silêncio
    for (let t = 0; t <= 200; t += 16) line.push(t, { level: t / 1000, brightness: 0 });
    expect(line.read(208, 0).level).toBeCloseTo(0.192, 6); // último medido
    expect(line.read(208, 100).level).toBeCloseTo(0.096, 6); // quadro de t=96
    // Antes do histórico existir, o quadro mais antigo (a fala ainda não chegou ao ouvido).
    expect(line.read(208, 10_000).level).toBe(0);
  });

  it('descarta o que passou do horizonte sem perder o último quadro', () => {
    const line = new VoiceFrameDelayLine(100);
    for (let t = 0; t <= 1000; t += 10) line.push(t, { level: t, brightness: 0 });
    expect(line.read(1000, 500).level).toBeGreaterThanOrEqual(890); // nada mais velho que o horizonte
    line.clear();
    expect(line.read(1000, 0)).toEqual({ level: 0, brightness: 0 });
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

  it('publica o brilho do espectro e segura o par pela latência de saída do contexto', () => {
    useVoiceStore.setState({ status: 'speaking' });
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const meter = new OutputLevelMeter();
    const { ctx, analyser, source } = fakeAudio(0.5);
    const rate = 24_000;
    Object.assign(ctx, { sampleRate: rate, baseLatency: 0.01, outputLatency: 0.09 }); // 100 ms
    Object.assign(analyser, {
      frequencyBinCount: 256,
      getFloatFrequencyData: vi.fn((buf: Float32Array) => buf.set(spectrumWithPeak(rate, 512, 3000, 5500))),
    });
    meter.tap(ctx, source);
    raf.step(); // fftSize 512 aplicado no tap
    expect(useVoiceStore.getState().outputLevel).toBeCloseTo(OUTPUT_LEVEL_ATTACK, 10);

    // Até 100 ms o ouvido ainda escuta o PRIMEIRO quadro medido.
    clock = 64;
    raf.step();
    expect(useVoiceStore.getState().outputLevel).toBeCloseTo(OUTPUT_LEVEL_ATTACK, 10);
    clock = 170; // 100 ms depois do 2º quadro (t=64): agora ele é o que se ouve
    raf.step();
    expect(useVoiceStore.getState().outputLevel).toBeGreaterThan(OUTPUT_LEVEL_ATTACK);
    expect(useVoiceStore.getState().outputBrightness).toBeGreaterThan(0.3);
    vi.restoreAllMocks();
  });

  it('chiado baixo (cauda, respiração) não estica a boca: o brilho fica em 0', () => {
    useVoiceStore.setState({ status: 'speaking' });
    const meter = new OutputLevelMeter();
    const { ctx, analyser, source } = fakeAudio(0.01); // nível 0,04: abaixo do piso
    const rate = 24_000;
    Object.assign(ctx, { sampleRate: rate });
    Object.assign(analyser, {
      frequencyBinCount: 256,
      getFloatFrequencyData: vi.fn((buf: Float32Array) => buf.set(spectrumWithPeak(rate, 512, 3000, 5500))),
    });
    meter.tap(ctx, source);
    for (let i = 0; i < 5; i += 1) raf.step();
    expect(useVoiceStore.getState().outputLevel).toBeGreaterThan(0);
    expect(useVoiceStore.getState().outputBrightness).toBe(0);
    expect(analyser.getFloatFrequencyData).not.toHaveBeenCalled();
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
