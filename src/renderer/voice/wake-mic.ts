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
import { preferredInputConstraints } from './audio-device-preferences';
import { LiveFrameGate } from './live-frame-gate';
import { PassiveWakeCapture } from './passive-wake-capture';

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
const REALTIME_PREROLL_MS = 750;
const LIVE_FRAME_PREROLL_MS = 750;
/** Pequeno contexto antes da fala para o STT textual não comer o “Hey”. */
const PASSIVE_WAKE_PREROLL_MS = 300;
/** Janela que será reaproveitada quando o STT confirmar o wake. */
const PASSIVE_WAKE_HANDOFF_MS = 2_500;
/**
 * Piso de fala pro VAD passivo (pós-AGC). 0.004 + hangover=mesmo valor fazia
 * ambient SoftAgc segurar o clip aberto até maxMs e DESCARTAR (zero STT).
 * 0.012 onset + hangover 0.006 no PassiveWakeCapture fecha "Jarvis" real.
 */
const PASSIVE_WAKE_RAW_SPEECH_RMS = 0.012;
const PASSIVE_WAKE_POST_AGC_SPEECH_RMS = 0.012;
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

/**
 * Uma frase curta que atravessou o VAD passivo e será checada pelo STT.
 * `preRoll` é entregue ao turno real se o texto confirmar o wake, evitando
 * perder “Hey Jarvis, ...” enquanto a confirmação acontece.
 */
export interface PassiveWakeUtterance extends CaptureResult {
  preRoll: Float32Array[];
  rawSpeechMs: number;
  rawMaxRms: number;
}

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
  /** Início dos zeros DIGITAIS puros (rms === 0) atuais; 0 = já ouviu sinal
   *  não-zero. Distinto de silentSince: sala quieta tem ruído > 0. */
  private zeroSince = 0;
  /** Log único do RMS do primeiro frame após abrir o grafo (prova sinal). */
  private firstFrameLogged = false;
  /** Ouviu QUALQUER áudio real (acima do piso) neste ciclo de grafo? Distingue
   * grant TCC fantasma (zeros desde o início) de sala silenciosa após fala. */
  private heardRealAudio = false;
  /** Rolling buffer dos frames recentes para não perder comando emendado ao wake. */
  private preRoll: Array<{ at: number; frame: Float32Array }> = [];
  private deviceRestartGeneration = 0;
  private deviceRestartActive = false;
  private deviceRestartQueue: Promise<void> = Promise.resolve();

  /** Stream morreu e a reconstrução esgotou as tentativas. */
  onDied: ((reason: string) => void) | null = null;
  /** Stream reconstruído com sucesso após uma morte. */
  onRecovered: (() => void) | null = null;
  /** Nível ao vivo (0–1) para orb/diagnóstico — mesmo contrato do VoiceCapture. */
  onLevel: ((level: number) => void) | null = null;
  /**
   * Segundo trilho do wake: VAD local produz uma frase curta; o controlador
   * decide se deve enviá-la ao STT e se o texto realmente chama a Jarvis.
   */
  onPassiveUtterance: ((utterance: PassiveWakeUtterance) => void) | null = null;

  private readonly passiveWake = new PassiveWakeCapture({
    rawSpeechRms: PASSIVE_WAKE_RAW_SPEECH_RMS,
    speechHangoverRms: 0.006,
    silenceMs: 900,
    maxMs: 4_500,
    // TV/música no fundo — force-emit só com energia de fala real perto do mic.
    forceEmitMinPeakRms: 0.18,
    cooldownMs: 1_500,
  });

  // Utterance capture (comando pós-wake/F6) sobre o MESMO stream quente.
  private uttChunks: Float32Array[] = [];
  private uttActive = false;
  private uttAutoStop: AutoStopOptions | null = null;
  private uttFired = false;
  private uttHeardSpeech = false;
  private uttSpeechMs = 0;
  /** Speech observed after capture starts; excludes wake pre-roll seed. */
  private uttLiveSpeechMs = 0;
  private uttMaxRms = 0;
  private uttMaxPeak = 0;
  private uttRawMaxRms = 0;
  private uttLastSpeechAt = 0;
  private uttStartedAt = 0;
  private uttDeadline: ReturnType<typeof setTimeout> | null = null;

  // Tap de frames da fala (Jarvis Live realtime): recebe cada frame do mic
  // enquanto o comando está sendo capturado, junto com o sample rate real.
  private uttFrameTap: ((frame: Float32Array, sampleRate: number) => void) | null = null;
  /** Live só recebe áudio após VAD local, com um pequeno pre-roll da fala. */
  private readonly liveFrameGate = new LiveFrameGate(
    Math.round(TARGET_SAMPLE_RATE * (LIVE_FRAME_PREROLL_MS / 1_000)),
  );

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

  /** Há quanto tempo os frames são ZERO digital puro (0 = já ouviu sinal). */
  getZeroMs(): number {
    return this.zeroSince ? Date.now() - this.zeroSince : 0;
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
    this.liveFrameGate.reset();
  }

  /** Cancela uma frase passiva quando um wake acústico/turno real vence a corrida. */
  cancelPassiveWake(): void {
    this.passiveWake.cancel();
  }

  /** Abre a escuta de comando INSTANTANEAMENTE (stream já está quente). */
  beginUtterance(
    autoStop?: AutoStopOptions,
    preRollMs = 0,
    preRollSeed?: Float32Array[],
  ): void {
    if (!this.running) return;
    this.cancelPassiveWake();
    if (this.uttActive) this.cancelUtterance();
    const seeded = preRollSeed?.map((frame) => Float32Array.from(frame)) ?? this.seedPreRoll(preRollMs);
    this.uttChunks = seeded;
    this.uttActive = true;
    this.uttAutoStop = autoStop ?? null;
    this.uttFired = false;
    this.uttHeardSpeech = false;
    this.uttSpeechMs = 0;
    this.uttLiveSpeechMs = 0;
    this.uttMaxRms = 0;
    this.uttMaxPeak = 0;
    this.uttRawMaxRms = 0;
    this.uttStartedAt = Date.now();
    this.uttLastSpeechAt = this.uttStartedAt;
    this.liveFrameGate.reset();
    this.markSeededSpeech(seeded);
    // The local WAV retains the full wake seed for fallback STT. Live gets only
    // the trailing window: enough to preserve a command glued to the wake word,
    // without bursting seconds of wake/silence into automatic VAD.
    const sampleRate = this.ctx?.sampleRate ?? TARGET_SAMPLE_RATE;
    for (const frame of tailFrames(seeded, sampleRate, REALTIME_PREROLL_MS)) {
      this.uttFrameTap?.(frame, sampleRate);
    }
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
    this.liveFrameGate.reset();
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
    const rawSpeechFloor = this.uttAutoStop?.rawSpeechRms ?? RAW_SPEECH_RMS;
    const rawBackedSpeech = rawRms >= rawSpeechFloor && rms >= SPEECH_RMS && peak >= SPEECH_PEAK;
    const strongSpeech = rms >= STRONG_SPEECH_RMS && peak >= STRONG_SPEECH_PEAK;
    const hasSpeech = rawBackedSpeech || strongSpeech;
    // The realtime gate can open on a weaker raw speech onset than the local
    // endpoint detector. This preserves quiet first syllables while still
    // rejecting AGC-amplified room noise.
    const hasLiveSpeech = rawRms >= rawSpeechFloor || strongSpeech;
    if (hasSpeech) {
      const frameMs =
        (frame.length / (this.ctx?.sampleRate ?? TARGET_SAMPLE_RATE)) * 1000;
      this.uttSpeechMs += frameMs;
      this.uttLiveSpeechMs += frameMs;
      this.uttHeardSpeech = this.uttSpeechMs >= MIN_SPEECH_MS;
      this.uttLastSpeechAt = now;
    }
    // Do not stream ambient silence to Gemini while the auto-reply window is
    // open. The gate preserves the start of a real utterance, then forwards
    // its trailing silence so the provider can endpoint normally.
    const sampleRate = this.ctx?.sampleRate ?? TARGET_SAMPLE_RATE;
    for (const queued of this.liveFrameGate.offer(frame, hasLiveSpeech)) {
      this.uttFrameTap?.(queued, sampleRate);
    }
    const opts = this.uttAutoStop;
    if (!opts || this.uttFired) return;
    if (
      shouldEndpointUtterance({
        heardSpeech: this.uttHeardSpeech,
        speechMs: this.uttLiveSpeechMs,
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

  /**
   * Captura uma única frase por VAD para o fallback textual. O áudio só sai
   * desta classe depois de fala real + silêncio; aqui não há STT nem decisão
   * de wake, portanto o stream acústico continua em paralelo sem bloqueio.
   */
  private trackPassiveWake(
    frame: Float32Array,
    rawRms: number,
    preRoll: readonly Float32Array[],
  ): void {
    const listener = this.onPassiveUtterance;
    if (!listener) return;
    const sampleRate = this.ctx?.sampleRate ?? TARGET_SAMPLE_RATE;
    const sample = this.passiveWake.offer({
      frame,
      rawRms,
      now: Date.now(),
      sampleRate,
      preRoll,
    });
    if (!sample) return;

    const pcm = mergeChunks(sample.frames);
    const down = downsample(pcm, sampleRate, TARGET_SAMPLE_RATE);
    const durationSec = down.length / TARGET_SAMPLE_RATE;
    // O VAD inclui o silêncio que confirmou o endpoint. Para o handoff Live
    // isso é nocivo: `beginUtterance` transmite apenas o fim do pre-roll e
    // acabaria entregando silêncio em vez de “Hey Jarvis, ...”. O WAV do STT
    // mantém a frase completa; o seed do turno termina no último frame falado.
    const handoffFrames = tailFrames(
      trimTrailingFrames(sample.frames, sampleRate, sample.trailingSilenceMs),
      sampleRate,
      PASSIVE_WAKE_HANDOFF_MS,
    );
    const utterance: PassiveWakeUtterance = {
      wavBase64: bytesToBase64(encodeWav(down, TARGET_SAMPLE_RATE)),
      sampleRate: TARGET_SAMPLE_RATE,
      durationSec,
      heardSpeech: true,
      maxRms: sample.maxRawRms,
      preRoll: handoffFrames,
      rawSpeechMs: sample.speechMs,
      rawMaxRms: sample.maxRawRms,
    };
    this.log('info', 'wake.passiveSample', 'frase VAD enviada ao STT de wake', {
      durationSec: Number(durationSec.toFixed(2)),
      speechMs: Math.round(sample.speechMs),
      rawMaxRms: Number(sample.maxRawRms.toFixed(5)),
      forcedByMax: Boolean(sample.forcedByMax),
    });
    listener(utterance);
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
    this.zeroSince = 0;
    this.startWatchdog();
    console.log('[wake] mic do wake word ligado (openWakeWord, sem key)');
    this.log('info', 'mic.started', 'wake mic ligado');
  }

  /** Abre stream + grafo de áudio (comum ao start e à reconstrução). */
  private async resolveAudioConstraints(): Promise<MediaTrackConstraints> {
    // Full-duplex: Chromium AEC so mic frames can keep flowing to Gemini Live
    // while she speaks (START_OF_ACTIVITY_INTERRUPTS). SoftAgc stays in-process.
    const base: MediaTrackConstraints = {
      echoCancellation: true,
      noiseSuppression: false,
      autoGainControl: false,
    };
    return preferredInputConstraints(base);
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
      const rms = frameRms(frame);
      // VAD passivo: fala após AGC (senão "Jarvis" longe nunca fecha o clip).
      const speechRms = Math.max(rawRms, rms);
      const isPassiveSpeech =
        rawRms >= PASSIVE_WAKE_RAW_SPEECH_RMS ||
        rms >= PASSIVE_WAKE_POST_AGC_SPEECH_RMS;
      const level = rmsToLevel(rms);
      this.onLevel?.(level);
      // Saúde do mic: acumula quanto tempo em silêncio (RMS abaixo do piso).
      const silent = frameIsSilent(rms);
      if (!silent) this.heardRealAudio = true;
      this.silentSince = silent ? this.silentSince || Date.now() : 0;
      // TCC fantasma: zeros DIGITAIS puros (rms === 0), distintos de sala quieta.
      this.zeroSince = rms === 0 ? this.zeroSince || Date.now() : 0;
      // Obtém o pre-roll ANTES do frame atual para não duplicar a primeira
      // sílaba quando o VAD iniciar a captura passiva logo abaixo.
      const passivePreRoll =
        !this.passiveWake.isActive() && isPassiveSpeech
          ? this.seedPreRoll(PASSIVE_WAKE_PREROLL_MS)
          : [];
      this.rememberPreRoll(frame);
      // Comando em gravação: acumula localmente (e NÃO alimenta o detector —
      // senão a própria fala do comando poderia re-disparar o wake).
      if (this.uttActive) {
        this.cancelPassiveWake();
        this.trackUtterance(frame, speechRms);
        return;
      }
      // Passa speechRms ao VAD (não raw) — Overclock-style: capturar a frase inteira.
      const vadRms = isPassiveSpeech ? Math.max(speechRms, PASSIVE_WAKE_RAW_SPEECH_RMS) : rawRms;
      if (Date.now() < this.wakeSuppressedUntil) {
        // Keep only the STT-verified direct-address path alive while the app is
        // speaking. Provider/local audio is still withheld from Live and from
        // the acoustic detector; echo comparison rejects the app's own words.
        this.trackPassiveWake(frame, vadRms, passivePreRoll);
        return;
      }
      this.trackPassiveWake(frame, vadRms, passivePreRoll);
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
      this.log('info', 'mic.processor', 'audio-worklet ativo');
    } catch (err) {
      this.log('warn', 'mic.processorFallback', 'AudioWorklet falhou; usando ScriptProcessor', {
        error: err instanceof Error ? err.message : String(err),
      });
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
    this.zeroSince = 0;
    this.restartAttempt = 0;
    this.stopWatchdog();
    this.pending = [];
    this.preRoll = [];
    this.cancelPassiveWake();
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

  /** Reabre o stream quente quando o usuário troca a entrada nas Configurações. */
  restartForDeviceChange(): Promise<void> {
    const shouldRestart = this.running || this.restarting || this.deviceRestartActive;
    if (!shouldRestart) return Promise.resolve();
    const generation = ++this.deviceRestartGeneration;
    this.deviceRestartActive = true;
    const task = this.deviceRestartQueue
      .catch(() => {})
      .then(async () => {
        // Coalesce preference bursts that arrive before teardown starts.
        if (generation !== this.deviceRestartGeneration) return;
        this.stop();
        await this.start();
      });
    this.deviceRestartQueue = task.catch(() => {});
    return task.finally(() => {
      if (generation === this.deviceRestartGeneration) {
        this.deviceRestartActive = false;
      }
    });
  }
}

function tailFrames(
  frames: readonly Float32Array[],
  sampleRate: number,
  durationMs: number,
): Float32Array[] {
  let remaining = Math.max(0, Math.ceil((sampleRate * durationMs) / 1000));
  const tail: Float32Array[] = [];
  for (let index = frames.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const frame = frames[index];
    const take = Math.min(frame.length, remaining);
    tail.unshift(Float32Array.from(frame.subarray(frame.length - take)));
    remaining -= take;
  }
  return tail;
}

/** Remove só o silêncio que o endpoint VAD acrescentou ao sample passivo. */
export function trimTrailingFrames(
  frames: readonly Float32Array[],
  sampleRate: number,
  durationMs: number,
): Float32Array[] {
  let remaining = Math.max(0, Math.ceil((sampleRate * durationMs) / 1_000));
  const trimmed = frames.map((frame) => Float32Array.from(frame));
  for (let index = trimmed.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const frame = trimmed[index];
    if (remaining >= frame.length) {
      trimmed.pop();
      remaining -= frame.length;
      continue;
    }
    trimmed[index] = Float32Array.from(frame.subarray(0, frame.length - remaining));
    remaining = 0;
  }
  return trimmed.filter((frame) => frame.length > 0);
}
