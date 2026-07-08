import pcmWorkletUrl from './pcm-processor.js?url';
import {
  mergeChunks,
  downsample,
  encodeWav,
  bytesToBase64,
  downmixChannelsToMono,
  frameRms,
  type AutoStopOptions,
  type CaptureResult,
} from './voice-capture';
import { RESTART_BACKOFF_MS, nextRearmDelay } from './wake-rearm';
import { shouldEndpointUtterance } from './wake-endpoint';
import { frameIsSilent, type MicPermissionState } from './wake-health';
import { SoftAgc } from './agc';
import { rmsToLevel } from './voice-level';

/**
 * Mic sempre-ligado do wake word: stream 16 kHz mono de baixo custo que
 * fatia o PCM em chunks de 1280 amostras (80 ms — o contrato do
 * openWakeWord) e envia ao main via IPC. A detecção acontece lá
 * (onnxruntime); aqui é só captura + fatiamento.
 *
 * FLUIDEZ: o mesmo stream quente também grava os COMANDOS (beginUtterance /
 * finishUtterance) — abrir a escuta é instantâneo, sem novo getUserMedia a
 * cada turno (a maior fonte do "aperto F6 e nada acontece").
 *
 * RESILIÊNCIA (a cura do "morreu sozinha"): o macOS mata streams em silêncio
 * — troca de AirPods, sleep/wake, mudança de dispositivo padrão. O stream
 * morre, isRunning() continua true e o wake fica surdo para sempre. Três
 * defesas (padrão validado no benchmark interno de mic, `mic_recovery.*`):
 *   1. track.onended → reconstrução imediata do stream;
 *   2. watchdog de frames (sem PCM por >8s = stream zumbi → reconstrução);
 *   3. AudioContext suspenso → resume().
 * Reconstrução com backoff (1s/3s/8s); esgotou → onDied(reason) avisa a UI.
 */

const TARGET_SAMPLE_RATE = 16_000;
const CHUNK = 1280;
const SPEECH_RMS = 0.012;
const RAW_SPEECH_RMS = 0.004;
const SPEECH_PEAK = 0.045;
const STRONG_SPEECH_RMS = 0.055;
const STRONG_SPEECH_PEAK = 0.12;
const MIN_SPEECH_MS = 320;
const MAX_PREROLL_MS = 3_000;
/** Ganho inicial do AGC próprio (ver agc.ts) — o valor 12x foi o melhor
 * fixo medido ao vivo em 2026-07-07; o AGC parte dele e adapta. */
const WAKE_INITIAL_GAIN = 24;

const WATCHDOG_INTERVAL_MS = 4_000;
const FRAME_STALL_MS = 8_000;
/**
 * Sinal-zero prolongado: o macOS ENTREGA frames, mas todos zerados (rms:0), ao
 * conceder um grant TCC fantasma (reinstala/atualiza o app e o registro antigo
 * fica inválido). O watchdog de stall (sem frames) não pega isso — os frames
 * chegam. Se NADA de áudio real cruzou o piso desde que o grafo abriu e o
 * silêncio passou disto, reconstrói o stream: reabrir costuma forçar um grant
 * novo e válido. Uma vez por ciclo de grafo (restarting trava reentrância).
 */
const MIC_ZERO_REOPEN_MS = 15_000;
/** Folga sobre o maxMs da captura: se os frames morrerem no meio da fala, o
 * deadline fecha o turno mesmo sem PCM chegando (senão busy trava). */
const UTTERANCE_DEADLINE_SLACK_MS = 1_000;

export class WakeMic {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private worklet: AudioWorkletNode | null = null;
  private scriptNode: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private pending: number[] = [];
  private running = false;
  private wakeSuppressedUntil = 0;
  /** AGC próprio do pipeline (o APM do Chromium fica desligado). */
  private readonly agc = new SoftAgc(WAKE_INITIAL_GAIN);

  // Watchdog do stream (morte silenciosa do mic).
  private lastFrameAt = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private restartAttempt = 0;
  private restarting = false;
  /** True após onDied disparar (rearme lento ativo). Reset em recover/stop. */
  private dead = false;
  /** Início do silêncio contínuo atual (epoch ms); 0 = ouvindo áudio real. */
  private silentSince = 0;
  /** Log único do RMS do primeiro frame após abrir o grafo (prova sinal). */
  private firstFrameLogged = false;
  /** Ouviu QUALQUER áudio real (acima do piso) neste ciclo de grafo? Distingue
   * grant TCC fantasma (zeros desde o início) de sala silenciosa após fala. */
  private heardRealAudio = false;
  /** Rolling buffer dos frames recentes para não perder comando emendado ao wake. */
  private preRoll: Array<{ at: number; frame: Float32Array }> = [];

  /** Stream morreu e a reconstrução esgotou as tentativas. */
  onDied: ((reason: string) => void) | null = null;
  /** Stream reconstruído com sucesso após uma morte. */
  onRecovered: (() => void) | null = null;
  /** Nível ao vivo (0–1) para orb/diagnóstico — mesmo contrato do VoiceCapture. */
  onLevel: ((level: number) => void) | null = null;

  // Utterance capture (comando pós-wake/F6) sobre o MESMO stream quente.
  private uttChunks: Float32Array[] = [];
  private uttActive = false;
  private uttAutoStop: AutoStopOptions | null = null;
  private uttFired = false;
  private uttHeardSpeech = false;
  private uttSpeechMs = 0;
  private uttMaxRms = 0;
  private uttMaxPeak = 0;
  private uttRawMaxRms = 0;
  private uttLastSpeechAt = 0;
  private uttStartedAt = 0;
  private uttDeadline: ReturnType<typeof setTimeout> | null = null;

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

  /** Encaminha evento do ciclo de vida do mic ao log persistente (main). */
  private log(
    level: 'info' | 'warn' | 'error',
    event: string,
    msg?: string,
    data?: Record<string, unknown>,
  ): void {
    window.nexus.voice.logVoice({ level, event, msg, data });
  }

  /** ms em silêncio contínuo; 0 se o mic está ouvindo áudio real. */
  getSilentMs(): number {
    return this.silentSince ? Date.now() - this.silentSince : 0;
  }

  /** Estado da permissão de mic (Permissions API / macOS); 'unknown' se indisponível. */
  async checkPermission(): Promise<MicPermissionState> {
    try {
      const res = await navigator.permissions.query({
        name: 'microphone' as PermissionName,
      });
      return (res.state as MicPermissionState) ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }

  isUtteranceActive(): boolean {
    return this.uttActive;
  }

  /** Pausa curta do detector de wake enquanto a própria Jarvis está falando. */
  suppressWakeDetection(ms: number): void {
    this.wakeSuppressedUntil = Math.max(this.wakeSuppressedUntil, Date.now() + ms);
  }

  /** Encerra captura em andamento sem processar (barge-in no novo wake). */
  cancelUtterance(): void {
    if (!this.uttActive) return;
    this.uttActive = false;
    this.uttFired = true;
    if (this.uttDeadline) {
      clearTimeout(this.uttDeadline);
      this.uttDeadline = null;
    }
    this.uttChunks = [];
    this.uttAutoStop = null;
  }

  /** Abre a escuta de comando INSTANTANEAMENTE (stream já está quente). */
  beginUtterance(
    autoStop?: AutoStopOptions,
    preRollMs = 0,
    preRollSeed?: Float32Array[],
  ): void {
    if (!this.running) return;
    if (this.uttActive) this.cancelUtterance();
    const seeded = preRollSeed?.map((frame) => Float32Array.from(frame)) ?? this.seedPreRoll(preRollMs);
    this.uttChunks = seeded;
    this.uttActive = true;
    this.uttAutoStop = autoStop ?? null;
    this.uttFired = false;
    this.uttHeardSpeech = false;
    this.uttSpeechMs = 0;
    this.uttMaxRms = 0;
    this.uttMaxPeak = 0;
    this.uttRawMaxRms = 0;
    this.uttStartedAt = Date.now();
    this.uttLastSpeechAt = this.uttStartedAt;
    this.markSeededSpeech(seeded);
    // Deadline DURO por timer: o auto-stop normal roda dentro do onFrame — se
    // o mic morrer no meio da fala, nenhum frame chega e o turno ficaria
    // aberto para sempre. O timer fecha mesmo com o stream mudo.
    if (autoStop) {
      this.uttDeadline = setTimeout(() => {
        if (this.uttActive && !this.uttFired) {
          this.uttFired = true;
          autoStop.onAutoStop();
        }
      }, autoStop.maxMs + UTTERANCE_DEADLINE_SLACK_MS);
    }
  }

  /** Encerra a escuta e devolve o WAV do que foi falado. */
  finishUtterance(): CaptureResult {
    this.uttActive = false;
    if (this.uttDeadline) {
      clearTimeout(this.uttDeadline);
      this.uttDeadline = null;
    }
    const pcm = mergeChunks(this.uttChunks);
    this.uttChunks = [];
    const rate = this.ctx?.sampleRate ?? TARGET_SAMPLE_RATE;
    const down = downsample(pcm, rate, TARGET_SAMPLE_RATE);
    if (!this.uttHeardSpeech || this.uttMaxRms < SPEECH_RMS) {
      this.log('info', 'utt.weakSignal', 'captura wake/clique com sinal fraco', {
        durationSec: down.length / TARGET_SAMPLE_RATE,
        heardSpeech: this.uttHeardSpeech,
        maxRms: Number(this.uttMaxRms.toFixed(5)),
        maxPeak: Number(this.uttMaxPeak.toFixed(5)),
        rawMaxRms: Number(this.uttRawMaxRms.toFixed(5)),
      });
    }
    return {
      wavBase64: bytesToBase64(encodeWav(down, TARGET_SAMPLE_RATE)),
      sampleRate: TARGET_SAMPLE_RATE,
      durationSec: down.length / TARGET_SAMPLE_RATE,
      heardSpeech: this.uttHeardSpeech,
      maxRms: this.uttMaxRms,
      maxPeak: this.uttMaxPeak,
    };
  }

  private trackUtterance(frame: Float32Array, rawRms: number): void {
    this.uttChunks.push(Float32Array.from(frame));
    // Jarvis Live realtime: espelha o frame para o transporte enquanto fala.
    this.uttFrameTap?.(frame, this.ctx?.sampleRate ?? TARGET_SAMPLE_RATE);
    let sum = 0;
    let peak = 0;
    for (let i = 0; i < frame.length; i += 1) {
      const sample = frame[i];
      sum += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
    }
    const rms = Math.sqrt(sum / Math.max(1, frame.length));
    const now = Date.now();
    this.uttMaxRms = Math.max(this.uttMaxRms, rms);
    this.uttMaxPeak = Math.max(this.uttMaxPeak, peak);
    this.uttRawMaxRms = Math.max(this.uttRawMaxRms, rawRms);
    const rawBackedSpeech = rawRms >= RAW_SPEECH_RMS && rms >= SPEECH_RMS && peak >= SPEECH_PEAK;
    const strongSpeech = rms >= STRONG_SPEECH_RMS && peak >= STRONG_SPEECH_PEAK;
    if (rawBackedSpeech || strongSpeech) {
      this.uttSpeechMs += (frame.length / (this.ctx?.sampleRate ?? TARGET_SAMPLE_RATE)) * 1000;
      this.uttHeardSpeech = this.uttSpeechMs >= MIN_SPEECH_MS;
      this.uttLastSpeechAt = now;
    }
    const opts = this.uttAutoStop;
    if (!opts || this.uttFired) return;
    if (
      shouldEndpointUtterance({
        heardSpeech: this.uttHeardSpeech,
        speechMs: this.uttSpeechMs,
        silentMs: now - this.uttLastSpeechAt,
        totalMs: now - this.uttStartedAt,
        silenceMs: opts.silenceMs,
        minListenMs: opts.minListenMs ?? 0,
        maxMs: opts.maxMs,
      })
    ) {
      this.uttFired = true;
      opts.onAutoStop();
    }
  }

  private rememberPreRoll(frame: Float32Array): void {
    const now = Date.now();
    this.preRoll.push({ at: now, frame: Float32Array.from(frame) });
    const cutoff = now - MAX_PREROLL_MS;
    while (this.preRoll.length > 0 && this.preRoll[0].at < cutoff) {
      this.preRoll.shift();
    }
  }

  private seedPreRoll(ms: number): Float32Array[] {
    if (ms <= 0) return [];
    const cutoff = Date.now() - Math.min(ms, MAX_PREROLL_MS);
    return this.preRoll
      .filter((entry) => entry.at >= cutoff)
      .map((entry) => Float32Array.from(entry.frame));
  }

  snapshotPreRoll(ms: number): Float32Array[] {
    return this.seedPreRoll(ms);
  }

  private markSeededSpeech(chunks: Float32Array[]): void {
    for (const frame of chunks) {
      let sum = 0;
      let peak = 0;
      for (let i = 0; i < frame.length; i += 1) {
        const sample = frame[i];
        sum += sample * sample;
        peak = Math.max(peak, Math.abs(sample));
      }
      const rms = Math.sqrt(sum / Math.max(1, frame.length));
      this.uttMaxRms = Math.max(this.uttMaxRms, rms);
      this.uttMaxPeak = Math.max(this.uttMaxPeak, peak);
      if (rms >= SPEECH_RMS && peak >= SPEECH_PEAK) {
        this.uttSpeechMs += (frame.length / (this.ctx?.sampleRate ?? TARGET_SAMPLE_RATE)) * 1000;
      }
    }
    if (this.uttSpeechMs >= MIN_SPEECH_MS) {
      this.uttHeardSpeech = true;
      this.uttLastSpeechAt = Date.now();
    }
  }

  async start(): Promise<void> {
    if (this.running) return;
    await this.openGraph();
    this.running = true;
    this.restartAttempt = 0;
    this.silentSince = 0;
    this.startWatchdog();
    console.log('[wake] mic do wake word ligado (openWakeWord, sem key)');
    this.log('info', 'mic.started', 'wake mic ligado');
  }

  /** Abre stream + grafo de áudio (comum ao start e à reconstrução). */
  private async resolveAudioConstraints(): Promise<MediaTrackConstraints> {
    const base: MediaTrackConstraints = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    };
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter(
        (device) => device.kind === 'audioinput' && device.deviceId,
      );
      // Prefer the non-"default" USB device entry — "default" routing can
      // deliver zeros in CoreAudio after a TCC reset even when granted.
      const preferred =
        inputs.find((device) => /fifine/i.test(device.label) && device.deviceId !== 'default') ??
        inputs.find((device) => /fifine/i.test(device.label)) ??
        inputs.find((device) => device.deviceId === 'default') ??
        inputs[0];
      if (preferred?.deviceId) {
        return { ...base, deviceId: { ideal: preferred.deviceId } };
      }
    } catch {
      // segue com constraints mínimas
    }
    return base;
  }

  private async openGraph(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: await this.resolveAudioConstraints(),
    });
    // Morte explícita do track (dispositivo removido, permissão revogada):
    // não espere o watchdog — reconstrói na hora.
    for (const track of this.stream.getTracks()) {
      track.addEventListener('ended', () => this.handleStreamDeath('track ended'));
    }
    // Diagnóstico decisivo: qual device o app realmente capturou + settings
    // reais (sampleRate/channelCount/APM podem diferir do pedido). Prova se
    // o app pegou o fifine ou outro device silencioso.
    const audioTrack = this.stream.getAudioTracks()[0];
    if (audioTrack) {
      this.log('info', 'mic.device', `device: ${audioTrack.label || '(sem label)'}`, {
        settings: audioTrack.getSettings(),
      });
    }
    this.firstFrameLogged = false;
    this.heardRealAudio = false;
    this.ctx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume().catch(() => {});
    }
    this.ctx.onstatechange = () => {
      // Sleep/wake do macOS pode deixar o contexto suspenso — retome.
      if (this.ctx?.state === 'suspended' && this.running) {
        void this.ctx.resume().catch(() => {});
      }
    };
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.lastFrameAt = Date.now();

    const onFrame = (frame: Float32Array) => {
      if (!this.running) return;
      this.lastFrameAt = Date.now();
      // AGC próprio (ver agc.ts): o APM do Chromium foi desligado (897ce56)
      // e ganho FIXO não acompanha distância — perto satura, longe some.
      // O SoftAgc mira a FALA em RMS ~0.1 e ignora ruído de fundo.
      const rawRms = this.agc.process(frame);
      // Prova única (por grafo) de que frames têm sinal: RMS do 1º frame.
      if (!this.firstFrameLogged) {
        this.firstFrameLogged = true;
        this.log('info', 'mic.firstFrame', 'primeiro frame recebido', {
          rms: frameRms(frame),
          channelCount: audioTrack?.getSettings().channelCount ?? null,
          contextRate: this.ctx?.sampleRate ?? null,
        });
      }
      const level = rmsToLevel(frameRms(frame));
      this.onLevel?.(level);
      // Saúde do mic: acumula quanto tempo em silêncio (RMS abaixo do piso).
      const silent = frameIsSilent(frameRms(frame));
      if (!silent) this.heardRealAudio = true;
      this.silentSince = silent ? this.silentSince || Date.now() : 0;
      this.rememberPreRoll(frame);
      // Comando em gravação: acumula localmente (e NÃO alimenta o detector —
      // senão a própria fala do comando poderia re-disparar o wake).
      if (this.uttActive) {
        this.trackUtterance(frame, rawRms);
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
      const node = this.ctx.createScriptProcessor(4096, 2, 1);
      node.onaudioprocess = (e) => {
        const buffer = e.inputBuffer;
        const channels: Float32Array[] = [];
        for (let ch = 0; ch < buffer.numberOfChannels; ch += 1) {
          channels.push(buffer.getChannelData(ch).slice(0));
        }
        onFrame(downmixChannelsToMono(channels));
      };
      this.source.connect(node);
      node.connect(this.ctx.destination);
      this.scriptNode = node;
    }
  }

  private startWatchdog(): void {
    this.stopWatchdog();
    this.watchdog = setInterval(() => {
      if (!this.running || this.restarting) return;
      if (Date.now() - this.lastFrameAt > FRAME_STALL_MS) {
        this.handleStreamDeath(`sem frames do mic há ${FRAME_STALL_MS / 1000}s`);
        return;
      }
      // Grant TCC fantasma: frames chegam mas TODOS zerados. Se nada de áudio
      // real cruzou o piso desde a abertura e o silêncio já passou do limiar,
      // reconstrói (reabrir costuma forçar um grant válido). Uma vez por ciclo.
      if (!this.heardRealAudio && this.getSilentMs() > MIC_ZERO_REOPEN_MS) {
        this.handleStreamDeath(`sinal zero há ${MIC_ZERO_REOPEN_MS / 1000}s (grant TCC fantasma?)`);
      }
    }, WATCHDOG_INTERVAL_MS);
  }

  private stopWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  /** Stream morreu em silêncio: reconstrói com backoff e NUNCA desiste.
   *  Esgotado o backoff rápido (1s/3s/8s), dispara onDied (UI avisa) e entra
   *  num rearme lento infinito a cada 30s até o dispositivo voltar. */
  private handleStreamDeath(reason: string): void {
    if (!this.running || this.restarting) return;
    this.restarting = true;
    this.restartAttempt = 0;
    this.dead = false;
    console.warn(`[wake] stream do mic morreu (${reason}) — reconstruindo`);
    this.log('warn', 'mic.died', `stream morreu: ${reason}`);
    this.teardownGraph();
    this.scheduleRestart(reason);
  }

  private scheduleRestart(reason: string): void {
    const attempt = this.restartAttempt;
    // Primeira entrada no rearme lento: avisa a UI (onDied) — mas continua
    // tentando. Antes daqui o mic ficava morto até toggle manual.
    if (attempt >= RESTART_BACKOFF_MS.length && !this.dead) {
      this.dead = true;
      console.warn('[wake] backoff rápido esgotou — rearme lento a cada 30s');
      this.log('warn', 'mic.slowRearm', 'rearme lento (a cada 30s)', { reason });
      this.onDied?.(reason);
    }
    this.restartAttempt += 1;
    this.restartTimer = setTimeout(() => {
      void this.openGraph()
        .then(() => {
          this.restarting = false;
          this.dead = false;
          this.restartAttempt = 0;
          this.lastFrameAt = Date.now();
          console.log('[wake] mic reconstruído com sucesso');
          this.log('info', 'mic.recovered', 'stream reconstruído');
          this.onRecovered?.();
        })
        .catch(() => this.scheduleRestart(reason));
    }, nextRearmDelay(attempt));
  }

  /** Derruba só o grafo de áudio (mantém o estado running/watchdog). */
  private teardownGraph(): void {
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
  }

  stop(): void {
    if (!this.running && !this.restarting) return;
    this.running = false;
    this.restarting = false;
    this.dead = false;
    this.silentSince = 0;
    this.restartAttempt = 0;
    this.stopWatchdog();
    this.pending = [];
    this.preRoll = [];
    this.wakeSuppressedUntil = 0;
    if (this.uttDeadline) {
      clearTimeout(this.uttDeadline);
      this.uttDeadline = null;
    }
    this.uttActive = false;
    this.onLevel?.(0);
    this.teardownGraph();
    console.log('[wake] mic do wake word desligado');
    this.log('info', 'mic.stopped', 'wake mic desligado');
  }
}
