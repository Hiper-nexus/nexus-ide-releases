import pcmWorkletUrl from './pcm-processor.js?url';
import {
  mergeChunks,
  downsample,
  encodeWav,
  bytesToBase64,
  type AutoStopOptions,
  type CaptureResult,
} from './voice-capture';

/**
 * Mic sempre-ligado do wake word: stream 16 kHz mono de baixo custo que
 * fatia o PCM em chunks de 1280 amostras (80 ms — o contrato do
 * openWakeWord) e envia ao main via IPC. A detecção acontece lá
 * (onnxruntime); aqui é só captura + fatiamento.
 *
 * FLUIDEZ: o mesmo stream quente também grava os COMANDOS (beginUtterance /
 * finishUtterance) — abrir a escuta é instantâneo, sem novo getUserMedia a
 * cada turno (a maior fonte do "aperto F6 e nada acontece").
 */

const TARGET_SAMPLE_RATE = 16_000;
const CHUNK = 1280;
const SPEECH_RMS = 0.022;
const MIN_SPEECH_MS = 320;

export class WakeMic {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private worklet: AudioWorkletNode | null = null;
  private scriptNode: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private pending: number[] = [];
  private running = false;
  private wakeSuppressedUntil = 0;

  // Utterance capture (comando pós-wake/F6) sobre o MESMO stream quente.
  private uttChunks: Float32Array[] = [];
  private uttActive = false;
  private uttAutoStop: AutoStopOptions | null = null;
  private uttFired = false;
  private uttHeardSpeech = false;
  private uttSpeechMs = 0;
  private uttLastSpeechAt = 0;
  private uttStartedAt = 0;

  // Tap de frames da fala (Jarvis Live realtime): recebe cada frame do mic
  // enquanto o comando está sendo capturado, junto com o sample rate real.
  private uttFrameTap: ((frame: Float32Array, sampleRate: number) => void) | null = null;

  /** Registra (ou limpa) o tap de frames de fala para o transporte realtime. */
  setUtteranceFrameTap(
    tap: ((frame: Float32Array, sampleRate: number) => void) | null,
  ): void {
    this.uttFrameTap = tap;
  }

  isRunning(): boolean {
    return this.running;
  }

  isUtteranceActive(): boolean {
    return this.uttActive;
  }

  /** Pausa curta do detector de wake enquanto a própria Jarvis está falando. */
  suppressWakeDetection(ms: number): void {
    this.wakeSuppressedUntil = Math.max(this.wakeSuppressedUntil, Date.now() + ms);
  }

  /** Abre a escuta de comando INSTANTANEAMENTE (stream já está quente). */
  beginUtterance(autoStop?: AutoStopOptions): void {
    if (!this.running || this.uttActive) return;
    this.uttChunks = [];
    this.uttActive = true;
    this.uttAutoStop = autoStop ?? null;
    this.uttFired = false;
    this.uttHeardSpeech = false;
    this.uttSpeechMs = 0;
    this.uttStartedAt = Date.now();
    this.uttLastSpeechAt = this.uttStartedAt;
  }

  /** Encerra a escuta e devolve o WAV do que foi falado. */
  finishUtterance(): CaptureResult {
    this.uttActive = false;
    const pcm = mergeChunks(this.uttChunks);
    this.uttChunks = [];
    const rate = this.ctx?.sampleRate ?? TARGET_SAMPLE_RATE;
    const down = downsample(pcm, rate, TARGET_SAMPLE_RATE);
    return {
      wavBase64: bytesToBase64(encodeWav(down, TARGET_SAMPLE_RATE)),
      sampleRate: TARGET_SAMPLE_RATE,
      durationSec: down.length / TARGET_SAMPLE_RATE,
      heardSpeech: this.uttHeardSpeech,
    };
  }

  private trackUtterance(frame: Float32Array): void {
    this.uttChunks.push(Float32Array.from(frame));
    // Jarvis Live realtime: espelha o frame para o transporte enquanto fala.
    this.uttFrameTap?.(frame, this.ctx?.sampleRate ?? TARGET_SAMPLE_RATE);
    let sum = 0;
    for (let i = 0; i < frame.length; i += 1) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / Math.max(1, frame.length));
    const now = Date.now();
    if (rms >= SPEECH_RMS) {
      this.uttSpeechMs += (frame.length / (this.ctx?.sampleRate ?? TARGET_SAMPLE_RATE)) * 1000;
      this.uttHeardSpeech = this.uttSpeechMs >= MIN_SPEECH_MS;
      this.uttLastSpeechAt = now;
    }
    const opts = this.uttAutoStop;
    if (!opts || this.uttFired) return;
    if (
      (this.uttHeardSpeech && now - this.uttLastSpeechAt >= opts.silenceMs) ||
      now - this.uttStartedAt >= opts.maxMs
    ) {
      this.uttFired = true;
      opts.onAutoStop();
    }
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: TARGET_SAMPLE_RATE,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    this.ctx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
    this.source = this.ctx.createMediaStreamSource(this.stream);

    const onFrame = (frame: Float32Array) => {
      if (!this.running) return;
      // Comando em gravação: acumula localmente (e NÃO alimenta o detector —
      // senão a própria fala do comando poderia re-disparar o wake).
      if (this.uttActive) {
        this.trackUtterance(frame);
        return;
      }
      if (Date.now() < this.wakeSuppressedUntil) return;
      for (let i = 0; i < frame.length; i += 1) this.pending.push(frame[i]);
      while (this.pending.length >= CHUNK) {
        const chunk = Float32Array.from(this.pending.splice(0, CHUNK));
        window.nexus.voice.sendWakeAudio(chunk.buffer);
      }
    };

    try {
      await this.ctx.audioWorklet.addModule(pcmWorkletUrl);
      const node = new AudioWorkletNode(this.ctx, 'nexus-pcm-processor');
      node.port.onmessage = (e: MessageEvent<Float32Array>) => onFrame(e.data);
      this.source.connect(node);
      node.connect(this.ctx.destination);
      this.worklet = node;
    } catch {
      const node = this.ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = (e) => onFrame(e.inputBuffer.getChannelData(0).slice(0));
      this.source.connect(node);
      node.connect(this.ctx.destination);
      this.scriptNode = node;
    }
    this.running = true;
    console.log('[wake] mic do wake word ligado (openWakeWord, sem key)');
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.pending = [];
    this.wakeSuppressedUntil = 0;
    try {
      this.worklet?.disconnect();
      this.scriptNode?.disconnect();
      this.source?.disconnect();
      this.stream?.getTracks().forEach((t) => t.stop());
      void this.ctx?.close();
    } catch {
      // best-effort
    }
    this.worklet = null;
    this.scriptNode = null;
    this.source = null;
    this.stream = null;
    this.ctx = null;
    console.log('[wake] mic do wake word desligado');
  }
}
