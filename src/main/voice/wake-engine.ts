import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as ort from 'onnxruntime-node';
import {
  MELSPEC_ONNX_B64,
  EMBEDDING_ONNX_B64,
  HEY_JARVIS_ONNX_B64,
} from './wake-models';

/**
 * Modelo custom do usuário (ex.: "Ei Jarvis" treinado em PT-BR): se
 * ~/.nexus/models/wake/custom.onnx existir, ele substitui o hey_jarvis
 * embutido. Treino: ver training/ei-jarvis/README.md no repositório.
 */
const CUSTOM_WAKE_MODEL = path.join(
  os.homedir(),
  '.nexus',
  'models',
  'wake',
  'custom.onnx',
);

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
 *   3. hey_jarvis_v0.1.onnx — últimos 16 embeddings → score.
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
// Ambiente marca picos de 0.2-0.4 (um falso disparo real registrado a 0.39);
// um "hey jarvis" de verdade marca ~0.97. 0.55 corta ruído mas acorda com fala normal.
const THRESHOLD = 0.55;
const DEBOUNCE_MS = 2_500;
// Cap da fila de PCM: ~50 chunks (≈4 s de áudio). Se o mic produz mais rápido
// que o drain() consome, descartamos os samples mais ANTIGOS em vez de deixar
// a fila crescer sem limite.
const PCM_QUEUE_MAX = 50 * CHUNK;
const DROP_WARN_EVERY = 50; // 1 warn a cada N chunks descartados
// Limites de sanidade do custom.onnx antes de tocar o runtime nativo.
const CUSTOM_MODEL_MIN_BYTES = 1024;
const CUSTOM_MODEL_MAX_BYTES = 500 * 1024 * 1024;

function fromB64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

/**
 * Sanidade barata do custom.onnx ANTES de entregá-lo ao runtime nativo — um
 * ONNX malformado pode ABORTAR o processo (SIGTRAP), não só lançar em JS.
 * Retorna null se o arquivo é plausível, ou o motivo da rejeição
 * ('ausente' quando simplesmente não existe — caso normal, sem warn).
 */
function checkCustomWakeModel(): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(CUSTOM_WAKE_MODEL);
  } catch {
    return 'ausente';
  }
  if (!stat.isFile()) return 'não é um arquivo regular';
  if (stat.size < CUSTOM_MODEL_MIN_BYTES) return `muito pequeno (${stat.size} bytes)`;
  if (stat.size > CUSTOM_MODEL_MAX_BYTES) return `muito grande (${stat.size} bytes)`;
  return null;
}

export class WakeEngine {
  private mel: ort.InferenceSession | null = null;
  private emb: ort.InferenceSession | null = null;
  private wake: ort.InferenceSession | null = null;

  private pcmQueue: number[] = [];
  private rawTail: Float32Array = new Float32Array(0); // últimos CTX samples
  private melFrames: Float32Array[] = []; // cada frame: [32]
  private features: Float32Array[] = []; // cada: [96]
  private lastFireAt = 0;
  private busy = false;
  private ready = false;
  private disposed = false;
  private droppedSinceWarn = 0;
  private peakScore = 0;
  private lastScoreLogAt = 0;

  constructor(private readonly onDetected: () => void) {}

  async init(): Promise<void> {
    if (this.mel) return;
    const opts: ort.InferenceSession.SessionOptions = {
      executionProviders: ['cpu'],
      interOpNumThreads: 1,
      intraOpNumThreads: 1,
    };
    this.mel = await ort.InferenceSession.create(fromB64(MELSPEC_ONNX_B64), opts);
    this.emb = await ort.InferenceSession.create(fromB64(EMBEDDING_ONNX_B64), opts);
    this.wake = await this.loadWakeModel(opts);
    await this.seedBuffers();
    this.ready = true;
    // Frames que chegaram DURANTE a init ficaram na fila — processa agora
    // (antes disso os primeiros segundos de áudio eram perdidos em silêncio).
    if (!this.disposed && this.pcmQueue.length >= CHUNK && !this.busy) {
      void this.drain();
    }
  }

  /**
   * Carrega o modelo wake: o CUSTOM só entra se passar nas validações baratas
   * (tamanho plausível + cabeçalho de protobuf) E se o runtime aceitar.
   * Qualquer falha cai no hey_jarvis embutido, com log do motivo.
   */
  private async loadWakeModel(
    opts: ort.InferenceSession.SessionOptions,
  ): Promise<ort.InferenceSession> {
    const rejected = checkCustomWakeModel();
    if (rejected === null) {
      try {
        const bytes = new Uint8Array(fs.readFileSync(CUSTOM_WAKE_MODEL));
        // ModelProto começa com ir_version (field 1, varint) → 1º byte 0x08.
        if (bytes[0] !== 0x08) {
          throw new Error('cabeçalho não parece um ONNX/protobuf');
        }
        const wake = await ort.InferenceSession.create(bytes, opts);
        console.log(`[wake] modelo CUSTOM carregado: ${CUSTOM_WAKE_MODEL}`);
        return wake;
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        console.warn(`[wake] modelo CUSTOM rejeitado (${m}) — usando o embutido`);
      }
    } else if (rejected !== 'ausente') {
      console.warn(`[wake] modelo CUSTOM ignorado (${rejected}) — usando o embutido`);
    }
    return ort.InferenceSession.create(fromB64(HEY_JARVIS_ONNX_B64), opts);
  }

  /** Espelha o init oficial: mel = ones(76,32); features = ruído de 4 s. */
  private async seedBuffers(): Promise<void> {
    this.melFrames = [];
    for (let i = 0; i < MEL_WINDOW; i += 1) {
      this.melFrames.push(new Float32Array(32).fill(1));
    }
    // Embeddings de 4 s de ruído int16 aleatório (janela 76, passo 8).
    const noise = new Float32Array(16_000 * 4);
    for (let i = 0; i < noise.length; i += 1) {
      noise[i] = Math.floor(Math.random() * 2000 - 1000);
    }
    const noiseMel = await this.runMel(noise);
    this.features = [];
    for (let start = 0; start + MEL_WINDOW <= noiseMel.length; start += 8) {
      const embedding = await this.runEmb(noiseMel.slice(start, start + MEL_WINDOW));
      this.features.push(embedding);
      if (this.features.length >= EMB_WINDOW) break; // 16 bastam para semear
    }
    while (this.features.length < EMB_WINDOW) {
      this.features.push(new Float32Array(96));
    }
  }

  private async runMel(samplesInt16Range: Float32Array): Promise<Float32Array[]> {
    const out = await this.mel!.run({
      [this.mel!.inputNames[0]]: new ort.Tensor(
        'float32',
        samplesInt16Range,
        [1, samplesInt16Range.length],
      ),
    });
    const data = out[this.mel!.outputNames[0]].data as Float32Array;
    const frames: Float32Array[] = [];
    for (let f = 0; f < data.length / 32; f += 1) {
      const frame = new Float32Array(32);
      for (let i = 0; i < 32; i += 1) frame[i] = data[f * 32 + i] / 10 + 2;
      frames.push(frame);
    }
    return frames;
  }

  private async runEmb(window: Float32Array[]): Promise<Float32Array> {
    const flat = new Float32Array(MEL_WINDOW * 32);
    window.forEach((fr, i) => flat.set(fr, i * 32));
    const out = await this.emb!.run({
      [this.emb!.inputNames[0]]: new ort.Tensor('float32', flat, [1, MEL_WINDOW, 32, 1]),
    });
    return Float32Array.from(
      (out[this.emb!.outputNames[0]].data as Float32Array).slice(0, 96),
    );
  }

  /**
   * Libera as sessões ONNX (memória nativa do onnxruntime) e limpa o estado.
   * Sem isto, quit/restart vazava as três sessões — elas nunca eram soltas.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.ready = false;
    this.pcmQueue = [];
    this.rawTail = new Float32Array(0);
    this.melFrames = [];
    this.features = [];
    const sessions = [this.mel, this.emb, this.wake];
    this.mel = null;
    this.emb = null;
    this.wake = null;
    for (const session of sessions) {
      try {
        await session?.release();
      } catch {
        // sessão já liberada / runtime encerrando
      }
    }
  }

  reset(): void {
    this.pcmQueue = [];
    this.rawTail = new Float32Array(0);
    // Re-semeia só o mel (barato); features mantêm histórico — o debounce já
    // impede retrigger imediato.
    this.melFrames = [];
    for (let i = 0; i < MEL_WINDOW; i += 1) {
      this.melFrames.push(new Float32Array(32).fill(1));
    }
  }

  /** Alimenta PCM mono 16 kHz normalizado [-1,1]; dispara onDetected. */
  feed(frame: Float32Array): void {
    if (this.disposed) return;
    for (let i = 0; i < frame.length; i += 1) this.pcmQueue.push(frame[i]);
    // Cap: se o mic envia mais rápido que o drain() consome, descarta os
    // samples mais ANTIGOS em vez de crescer sem limite (warn throttled).
    const excess = this.pcmQueue.length - PCM_QUEUE_MAX;
    if (excess > 0) {
      this.pcmQueue.splice(0, excess);
      this.droppedSinceWarn += Math.ceil(excess / CHUNK);
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
        const chunk = this.pcmQueue.splice(0, CHUNK);
        await this.processChunk(chunk);
      }
    } catch (err) {
      console.warn('[wake] inference error:', err instanceof Error ? err.message : err);
      this.reset();
    } finally {
      this.busy = false;
    }
  }

  private async processChunk(samples: number[]): Promise<void> {
    if (!this.mel || !this.emb || !this.wake) return;
    // Escala int16 (o mel espera amplitude de int16, não [-1,1]).
    const chunk = Float32Array.from(samples, (v) => v * 32768);

    // Mel COM CONTEXTO: últimos 480 samples do chunk anterior + os 1280 novos.
    const withCtx = new Float32Array(this.rawTail.length + chunk.length);
    withCtx.set(this.rawTail, 0);
    withCtx.set(chunk, this.rawTail.length);
    this.rawTail = chunk.slice(chunk.length - CTX);

    const newFrames = await this.runMel(withCtx);
    for (const fr of newFrames) this.melFrames.push(fr);
    if (this.melFrames.length > MEL_MAX) {
      this.melFrames.splice(0, this.melFrames.length - MEL_MAX);
    }

    // UM embedding por chunk, janela = últimos 76 mel frames (como o oficial).
    if (this.melFrames.length >= MEL_WINDOW) {
      const embedding = await this.runEmb(this.melFrames.slice(-MEL_WINDOW));
      this.features.push(embedding);
      if (this.features.length > FEAT_MAX) this.features.shift();
    }

    if (this.features.length < EMB_WINDOW) return;
    const feat = new Float32Array(EMB_WINDOW * 96);
    this.features.slice(-EMB_WINDOW).forEach((e, i) => feat.set(e, i * 96));
    const wakeOut = await this.wake.run({
      [this.wake.inputNames[0]]: new ort.Tensor('float32', feat, [1, EMB_WINDOW, 96]),
    });
    const score = (wakeOut[this.wake.outputNames[0]].data as Float32Array)[0];
    const now = Date.now();
    if (score > this.peakScore) this.peakScore = score;
    // Telemetria discreta: só quando há sinal, no máx. 1 linha/5s.
    if (now - this.lastScoreLogAt > 5_000 && this.peakScore >= 0.05) {
      console.log(`[wake] pico de score: ${this.peakScore.toFixed(3)}`);
      this.peakScore = 0;
      this.lastScoreLogAt = now;
    }
    if (score >= THRESHOLD && now - this.lastFireAt > DEBOUNCE_MS) {
      this.lastFireAt = now;
      console.log(`[wake] "Hey Jarvis" detectado (score ${score.toFixed(2)})`);
      this.onDetected();
    }
  }
}
