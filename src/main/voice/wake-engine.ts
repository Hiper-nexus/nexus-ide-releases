import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import * as ort from 'onnxruntime-node';
import {
  MELSPEC_ONNX_B64,
  EMBEDDING_ONNX_B64,
  HEY_JARVIS_ONNX_B64,
} from './wake-models';
import { PcmRingBuffer } from './pcm-ring-buffer';
import {
  CUSTOM_WAKE_SCORE_THRESHOLD,
  OFFICIAL_WAKE_SCORE_THRESHOLD,
  resolveWakeDetection,
  WAKE_SCORE_THRESHOLD,
  type WakeScoreSource,
} from './wake-score-gate';

/**
 * Modelo candidato PT-BR do usuário (ex.: "Ei/Hey Jarvis"). Quando presente,
 * ele roda EM PARALELO ao head SpeechKit permissivo embutido; nunca remove a
 * cobertura do modelo base. Treino: training/wake-ptbr/ no repositório.
 */
const CUSTOM_WAKE_MODEL = path.join(
  os.homedir(),
  '.nexus',
  'models',
  'wake',
  'custom.onnx',
);

/**
 * Verified third-party Apache-2.0 OpenWakeWord head. It is downloaded by our
 * installer only after checksum + runtime-shape verification, then remains an
 * optional second detector beside the embedded model.
 */
const OFFICIAL_OPEN_SOURCE_WAKE_MODEL = path.join(
  os.homedir(),
  '.nexus',
  'models',
  'wake',
  'speechkit-hey-jarvis.onnx',
);
const OFFICIAL_OPEN_SOURCE_WAKE_SHA256 =
  '7256019a18029c7bea33abc3344f7a3d0e07655cf4a5f18e65c9b6329eac3fb6';

/**
 * Wake word "Hey Jarvis" via openWakeWord — port fiel do streaming oficial
 * (openwakeword/utils.py), validado contra o Python (score 0.999 no mesmo
 * áudio). Três modelos ONNX no MAIN (onnxruntime-node), sem conta/key:
 *
 *   1. melspectrogram.onnx — SEMPRE com contexto: input = últimos 480
 *      samples do chunk anterior + 1280 novos (sem isso saem só 5 frames
 *      por chunk em vez de ~8 e a linha do tempo desalinha → score 0).
 *   2. embedding_model.onnx — janela dos últimos 76 mel frames, UM embedding
 *      por chunk de 1280.
 *   3. SpeechKit hey_jarvis.onnx — últimos 16 embeddings → score.
 *
 * Buffers pré-semeados como no oficial: mel = 76 frames de 1s; features =
 * embeddings de 4 s de ruído aleatório.
 */

const CHUNK = 1280; // 80 ms @ 16 kHz
const CTX = 480; // 160*3 — contexto de janela do mel (do oficial)
const MEL_WINDOW = 76;
const MEL_MAX = 400;
const EMB_WINDOW = 16;
const FEAT_MAX = 120;
// O gate calibrado aceita o wake curto falado emendado sem cruzar o teto de
// não-wake medido no Fifine; a decisão pura fica testável em wake-score-gate.
const THRESHOLD = WAKE_SCORE_THRESHOLD;
const DEBOUNCE_MS = 2_500;
const SCORE_TELEMETRY_MS = 2_000;
const SCORE_TELEMETRY_MIN_RMS = 0.03;
// Cap da fila de PCM: ~50 chunks (≈4 s de áudio). Se o mic produz mais rápido
// que o drain() consome, descartamos os samples mais ANTIGOS em vez de deixar
// a fila crescer sem limite.
const PCM_QUEUE_MAX = 50 * CHUNK;
const DROP_WARN_EVERY = 50; // 1 warn a cada N chunks descartados
// Limites de sanidade do custom.onnx antes de tocar o runtime nativo.
const CUSTOM_MODEL_MIN_BYTES = 1024;
const CUSTOM_MODEL_MAX_BYTES = 500 * 1024 * 1024;

export interface WakeScoreTelemetry {
  peakScore: number;
  peakRms: number;
  threshold: number;
  source: WakeScoreSource;
  chunks: number;
}

function fromB64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

async function releaseSessions(
  sessions: readonly (ort.InferenceSession | null)[],
): Promise<void> {
  for (const session of sessions) {
    try {
      await session?.release();
    } catch {
      // Session already released / native runtime shutting down.
    }
  }
}

/**
 * Sanidade barata do custom.onnx ANTES de entregá-lo ao runtime nativo — um
 * ONNX malformado pode ABORTAR o processo (SIGTRAP), não só lançar em JS.
 * Retorna null se o arquivo é plausível, ou o motivo da rejeição
 * ('ausente' quando simplesmente não existe — caso normal, sem warn).
 */
function checkWakeModel(filePath: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return 'ausente';
  }
  if (!stat.isFile()) return 'não é um arquivo regular';
  if (stat.size < CUSTOM_MODEL_MIN_BYTES) return `muito pequeno (${stat.size} bytes)`;
  if (stat.size > CUSTOM_MODEL_MAX_BYTES) return `muito grande (${stat.size} bytes)`;
  return null;
}

function checkCustomWakeModel(): string | null {
  return checkWakeModel(CUSTOM_WAKE_MODEL);
}

function checkOfficialWakeModel(): string | null {
  const rejected = checkWakeModel(OFFICIAL_OPEN_SOURCE_WAKE_MODEL);
  if (rejected !== null) return rejected;
  try {
    const bytes = fs.readFileSync(OFFICIAL_OPEN_SOURCE_WAKE_MODEL);
    const checksum = createHash('sha256').update(bytes).digest('hex');
    return checksum === OFFICIAL_OPEN_SOURCE_WAKE_SHA256
      ? null
      : `checksum inesperado (${checksum.slice(0, 12)})`;
  } catch {
    return 'não pôde ser lido';
  }
}

/** Guard against a valid-looking ONNX file with an incompatible wake head. */
async function verifyWakeHead(wake: ort.InferenceSession): Promise<void> {
  if (wake.inputNames.length !== 1 || wake.outputNames.length !== 1) {
    throw new Error('contrato ONNX inválido: esperado um input e um output');
  }
  const output = await wake.run({
    [wake.inputNames[0]]: new ort.Tensor(
      'float32',
      new Float32Array(EMB_WINDOW * 96),
      [1, EMB_WINDOW, 96],
    ),
  });
  const score = (output[wake.outputNames[0]].data as Float32Array)[0];
  if (!Number.isFinite(score)) {
    throw new Error('contrato ONNX inválido: score não numérico');
  }
}

export class WakeEngine {
  private mel: ort.InferenceSession | null = null;
  private emb: ort.InferenceSession | null = null;
  private baseWake: ort.InferenceSession | null = null;
  private customWake: ort.InferenceSession | null = null;
  private officialWake: ort.InferenceSession | null = null;

  private readonly pcmQueue = new PcmRingBuffer(PCM_QUEUE_MAX);
  private rawTail: Float32Array = new Float32Array(0); // últimos CTX samples
  private melFrames: Float32Array[] = []; // cada frame: [32]
  private features: Float32Array[] = []; // cada: [96]
  private lastFireAt = 0;
  private busy = false;
  private ready = false;
  private disposed = false;
  private droppedSinceWarn = 0;
  private peakScore = 0;
  private peakSource: WakeScoreTelemetry['source'] = 'embedded';
  private peakThreshold = THRESHOLD;
  private lastScoreLogAt = 0;
  private peakRms = 0;
  private scoredChunks = 0;

  constructor(
    private readonly onDetected: () => void,
    private readonly onScore?: (telemetry: WakeScoreTelemetry) => void,
  ) {}

  async init(): Promise<void> {
    if (this.disposed || this.mel) return;
    const opts: ort.InferenceSession.SessionOptions = {
      executionProviders: ['cpu'],
      interOpNumThreads: 1,
      intraOpNumThreads: 1,
    };
    let mel: ort.InferenceSession | null = null;
    let emb: ort.InferenceSession | null = null;
    let baseWake: ort.InferenceSession | null = null;
    let customWake: ort.InferenceSession | null = null;
    let officialWake: ort.InferenceSession | null = null;
    let installed = false;
    try {
      mel = await ort.InferenceSession.create(fromB64(MELSPEC_ONNX_B64), opts);
      if (this.disposed) return;
      emb = await ort.InferenceSession.create(fromB64(EMBEDDING_ONNX_B64), opts);
      if (this.disposed) return;
      baseWake = await ort.InferenceSession.create(fromB64(HEY_JARVIS_ONNX_B64), opts);
      if (this.disposed) return;
      customWake = await this.loadCustomWakeModel(opts);
      if (this.disposed) return;
      officialWake = await this.loadOfficialWakeModel(opts);
      if (this.disposed) return;
      const seeded = await this.seedBuffers(mel, emb);
      if (this.disposed) return;

      this.mel = mel;
      this.emb = emb;
      this.baseWake = baseWake;
      this.customWake = customWake;
      this.officialWake = officialWake;
      this.melFrames = seeded.melFrames;
      this.features = seeded.features;
      this.ready = true;
      installed = true;
      // Frames que chegaram DURANTE a init ficaram na fila — processa agora
      // (antes disso os primeiros segundos de áudio eram perdidos em silêncio).
      if (this.pcmQueue.length >= CHUNK && !this.busy) void this.drain();
    } finally {
      if (!installed) {
        await releaseSessions([mel, emb, baseWake, customWake, officialWake]);
      }
    }
  }

  /**
   * Carrega o candidato PT-BR apenas se ele passar nas validações baratas
   * (tamanho plausível + cabeçalho de protobuf) E se o runtime aceitar.
   * Falhas mantêm o modelo base ativo, sem substituir comportamento existente.
   */
  private async loadCustomWakeModel(
    opts: ort.InferenceSession.SessionOptions,
  ): Promise<ort.InferenceSession | null> {
    const rejected = checkCustomWakeModel();
    if (rejected === null) {
      try {
        const bytes = new Uint8Array(fs.readFileSync(CUSTOM_WAKE_MODEL));
        // ModelProto começa com ir_version (field 1, varint) → 1º byte 0x08.
        if (bytes[0] !== 0x08) {
          throw new Error('cabeçalho não parece um ONNX/protobuf');
        }
        const wake = await ort.InferenceSession.create(bytes, opts);
        await verifyWakeHead(wake);
        console.log(`[wake] modelo PT-BR adicional carregado: ${CUSTOM_WAKE_MODEL}`);
        return wake;
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        console.warn(`[wake] modelo PT-BR rejeitado (${m}) — mantendo o embutido`);
      }
    } else if (rejected !== 'ausente') {
      console.warn(`[wake] modelo PT-BR ignorado (${rejected}) — mantendo o embutido`);
    }
    return null;
  }

  /**
   * Loads the pinned open-source head only when its exact expected checksum
   * and OpenWakeWord input/output contract validate locally. A bad download
   * therefore cannot degrade or replace the embedded detector.
   */
  private async loadOfficialWakeModel(
    opts: ort.InferenceSession.SessionOptions,
  ): Promise<ort.InferenceSession | null> {
    const rejected = checkOfficialWakeModel();
    if (rejected === 'ausente') return null;
    if (rejected !== null) {
      console.warn(`[wake] modelo open-source ignorado (${rejected}) — mantendo o embutido`);
      return null;
    }
    try {
      const bytes = new Uint8Array(fs.readFileSync(OFFICIAL_OPEN_SOURCE_WAKE_MODEL));
      const wake = await ort.InferenceSession.create(bytes, opts);
      await verifyWakeHead(wake);
      console.log(
        `[wake] modelo open-source adicional carregado: ${OFFICIAL_OPEN_SOURCE_WAKE_MODEL}`,
      );
      return wake;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[wake] modelo open-source rejeitado (${message}) — mantendo o embutido`);
      return null;
    }
  }

  /** Espelha o init oficial: mel = ones(76,32); features = ruído de 4 s. */
  private async seedBuffers(
    mel: ort.InferenceSession,
    emb: ort.InferenceSession,
  ): Promise<{ melFrames: Float32Array[]; features: Float32Array[] }> {
    const melFrames: Float32Array[] = [];
    for (let i = 0; i < MEL_WINDOW; i += 1) {
      melFrames.push(new Float32Array(32).fill(1));
    }
    // Embeddings de 4 s de ruído int16 aleatório (janela 76, passo 8).
    const noise = new Float32Array(16_000 * 4);
    for (let i = 0; i < noise.length; i += 1) {
      noise[i] = Math.floor(Math.random() * 2000 - 1000);
    }
    const noiseMel = await this.runMel(mel, noise);
    const features: Float32Array[] = [];
    for (let start = 0; start + MEL_WINDOW <= noiseMel.length; start += 8) {
      const embedding = await this.runEmb(
        emb,
        noiseMel.slice(start, start + MEL_WINDOW),
      );
      features.push(embedding);
      if (features.length >= EMB_WINDOW) break; // 16 bastam para semear
    }
    while (features.length < EMB_WINDOW) {
      features.push(new Float32Array(96));
    }
    return { melFrames, features };
  }

  private async runMel(
    mel: ort.InferenceSession,
    samplesInt16Range: Float32Array,
  ): Promise<Float32Array[]> {
    const out = await mel.run({
      [mel.inputNames[0]]: new ort.Tensor(
        'float32',
        samplesInt16Range,
        [1, samplesInt16Range.length],
      ),
    });
    const data = out[mel.outputNames[0]].data as Float32Array;
    const frames: Float32Array[] = [];
    for (let f = 0; f < data.length / 32; f += 1) {
      const frame = new Float32Array(32);
      for (let i = 0; i < 32; i += 1) frame[i] = data[f * 32 + i] / 10 + 2;
      frames.push(frame);
    }
    return frames;
  }

  private async runEmb(
    emb: ort.InferenceSession,
    window: Float32Array[],
  ): Promise<Float32Array> {
    const flat = new Float32Array(MEL_WINDOW * 32);
    window.forEach((fr, i) => flat.set(fr, i * 32));
    const out = await emb.run({
      [emb.inputNames[0]]: new ort.Tensor('float32', flat, [1, MEL_WINDOW, 32, 1]),
    });
    return Float32Array.from(
      (out[emb.outputNames[0]].data as Float32Array).slice(0, 96),
    );
  }

  /**
   * Libera as sessões ONNX (memória nativa do onnxruntime) e limpa o estado.
   * Sem isto, quit/restart vazava as três sessões — elas nunca eram soltas.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.ready = false;
    this.pcmQueue.clear();
    this.rawTail = new Float32Array(0);
    this.melFrames = [];
    this.features = [];
    this.peakScore = 0;
    this.peakSource = 'embedded';
    this.peakThreshold = THRESHOLD;
    this.peakRms = 0;
    this.scoredChunks = 0;
    const sessions = [
      this.mel,
      this.emb,
      this.baseWake,
      this.customWake,
      this.officialWake,
    ];
    this.mel = null;
    this.emb = null;
    this.baseWake = null;
    this.customWake = null;
    this.officialWake = null;
    await releaseSessions(sessions);
  }

  reset(): void {
    this.pcmQueue.clear();
    this.rawTail = new Float32Array(0);
    // Re-semeia só o mel (barato); features mantêm histórico — o debounce já
    // impede retrigger imediato.
    this.melFrames = [];
    for (let i = 0; i < MEL_WINDOW; i += 1) {
      this.melFrames.push(new Float32Array(32).fill(1));
    }
    this.peakScore = 0;
    this.peakSource = 'embedded';
    this.peakThreshold = THRESHOLD;
    this.peakRms = 0;
    this.scoredChunks = 0;
  }

  /** Alimenta PCM mono 16 kHz normalizado [-1,1]; dispara onDetected. */
  feed(frame: Float32Array): void {
    if (this.disposed) return;
    // Fixed-capacity typed ring: no number[] boxing/splice on the 80 ms hot path.
    const dropped = this.pcmQueue.push(frame);
    if (dropped > 0) {
      this.droppedSinceWarn += Math.ceil(dropped / CHUNK);
      if (this.droppedSinceWarn >= DROP_WARN_EVERY) {
        console.warn(
          `[wake] fila de PCM cheia — ${this.droppedSinceWarn} chunks antigos descartados`,
        );
        this.droppedSinceWarn = 0;
      }
    }
    // Ainda inicializando: os frames ficam na fila (com o mesmo cap) e são
    // processados quando init() completar.
    if (!this.ready || this.busy) return;
    void this.drain();
  }

  private async drain(): Promise<void> {
    this.busy = true;
    try {
      while (!this.disposed && this.pcmQueue.length >= CHUNK) {
        const chunk = this.pcmQueue.shift(CHUNK);
        if (!chunk) break;
        await this.processChunk(chunk);
      }
    } catch (err) {
      console.warn('[wake] inference error:', err instanceof Error ? err.message : err);
      this.reset();
    } finally {
      this.busy = false;
    }
  }

  private async processChunk(samples: Float32Array): Promise<void> {
    const mel = this.mel;
    const emb = this.emb;
    const baseWake = this.baseWake;
    const customWake = this.customWake;
    const officialWake = this.officialWake;
    if (!mel || !emb || !baseWake || this.disposed) return;
    let squaredSum = 0;
    for (let index = 0; index < samples.length; index += 1) {
      squaredSum += samples[index] * samples[index];
    }
    const rms = Math.sqrt(squaredSum / Math.max(1, samples.length));
    this.peakRms = Math.max(this.peakRms, rms);
    this.scoredChunks += 1;
    // Escala int16 (o mel espera amplitude de int16, não [-1,1]).
    const chunk = new Float32Array(samples.length);
    for (let index = 0; index < samples.length; index += 1) {
      chunk[index] = samples[index] * 32768;
    }

    // Mel COM CONTEXTO: últimos 480 samples do chunk anterior + os 1280 novos.
    const withCtx = new Float32Array(this.rawTail.length + chunk.length);
    withCtx.set(this.rawTail, 0);
    withCtx.set(chunk, this.rawTail.length);
    this.rawTail = chunk.slice(chunk.length - CTX);

    const newFrames = await this.runMel(mel, withCtx);
    if (this.disposed) return;
    for (const fr of newFrames) this.melFrames.push(fr);
    if (this.melFrames.length > MEL_MAX) {
      this.melFrames.splice(0, this.melFrames.length - MEL_MAX);
    }

    // UM embedding por chunk, janela = últimos 76 mel frames (como o oficial).
    if (this.melFrames.length >= MEL_WINDOW) {
      const embedding = await this.runEmb(
        emb,
        this.melFrames.slice(-MEL_WINDOW),
      );
      if (this.disposed) return;
      this.features.push(embedding);
      if (this.features.length > FEAT_MAX) this.features.shift();
    }

    if (this.features.length < EMB_WINDOW) return;
    const feat = new Float32Array(EMB_WINDOW * 96);
    this.features.slice(-EMB_WINDOW).forEach((e, i) => feat.set(e, i * 96));
    const embeddedScore = await this.runWakeHead(baseWake, feat);
    if (this.disposed) return;
    const customScore = customWake
      ? await this.runWakeHead(customWake, feat)
      : undefined;
    if (this.disposed) return;
    const officialScore = officialWake
      ? await this.runWakeHead(officialWake, feat)
      : undefined;
    if (this.disposed) return;
    // Keep telemetry finite even if a candidate ONNX model emits NaN. The
    // detection gate below also validates scores, but Math.max(NaN, x) would
    // otherwise poison the diagnostic peak for the whole window.
    const scores: Array<{
      source: WakeScoreTelemetry['source'];
      threshold: number;
      value: number;
    }> = [
      {
        source: 'embedded',
        threshold: WAKE_SCORE_THRESHOLD,
        value: Number.isFinite(embeddedScore) ? embeddedScore : 0,
      },
      {
        source: 'custom',
        threshold: CUSTOM_WAKE_SCORE_THRESHOLD,
        value:
          typeof customScore === 'number' && Number.isFinite(customScore)
            ? customScore
            : 0,
      },
      {
        source: 'official',
        threshold: OFFICIAL_WAKE_SCORE_THRESHOLD,
        value:
          typeof officialScore === 'number' && Number.isFinite(officialScore)
            ? officialScore
            : 0,
      },
    ];
    const highest = scores.reduce((best, candidate) =>
      candidate.value > best.value ? candidate : best,
    );
    const detection = resolveWakeDetection({
      embedded: embeddedScore,
      custom: customScore,
      official: officialScore,
    });
    const now = Date.now();
    if (detection) {
      // Forced telemetry must name the head that crossed its own threshold,
      // not merely the one with the largest raw score.
      this.peakScore = detection.score;
      this.peakSource = detection.source;
      this.peakThreshold = detection.threshold;
    } else if (highest.value > this.peakScore) {
      this.peakScore = highest.value;
      this.peakSource = highest.source;
      this.peakThreshold = highest.threshold;
    }
    const detected = detection !== null;
    this.emitScoreTelemetry(now, detected);
    if (detection && now - this.lastFireAt > DEBOUNCE_MS) {
      this.lastFireAt = now;
      console.log(
        `[wake] "Hey Jarvis" detectado (${detection.source}, score ${detection.score.toFixed(2)})`,
      );
      this.onDetected();
    }
  }

  private async runWakeHead(
    wake: ort.InferenceSession,
    features: Float32Array,
  ): Promise<number> {
    const wakeOut = await wake.run({
      [wake.inputNames[0]]: new ort.Tensor('float32', features, [1, EMB_WINDOW, 96]),
    });
    return (wakeOut[wake.outputNames[0]].data as Float32Array)[0] ?? 0;
  }

  private emitScoreTelemetry(now: number, force = false): void {
    if (!force && now - this.lastScoreLogAt < SCORE_TELEMETRY_MS) return;
    if (!force && this.peakRms < SCORE_TELEMETRY_MIN_RMS) return;
    if (this.scoredChunks === 0) return;
    this.onScore?.({
      peakScore: Number(this.peakScore.toFixed(4)),
      peakRms: Number(this.peakRms.toFixed(4)),
      threshold: this.peakThreshold,
      source: this.peakSource,
      chunks: this.scoredChunks,
    });
    this.peakScore = 0;
    this.peakSource = 'embedded';
    this.peakThreshold = THRESHOLD;
    this.peakRms = 0;
    this.scoredChunks = 0;
    this.lastScoreLogAt = now;
  }
}
