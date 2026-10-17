import type { SpeakResult } from '../../shared/voice-ipc';

const DEFAULT_MAX_PENDING = 12;
/** Tentativas por relato: a primeira + as devoluções à fila (um turno tomou a voz). */
const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_NARRATION_CHARS = 2_000;

/** Snapshot of everything that can already own the voice when a narration wants it. */
export interface NarrationVoiceState {
  status: string;
  /**
   * `turnExecution.currentToken`: muda quando QUALQUER fluxo abre um turno
   * (wake, PTT, ditado, clique, texto injetado) e também quando o watchdog de
   * status preso invalida o turno. É o sinal de "alguém tomou a voz" que não
   * depende de o HUD estar em `speaking` ou `idle`.
   */
  turnToken: number;
  /** `busy.current` do controller: um turno (wake/ditado/ferramenta) está em voo. */
  turnBusy: boolean;
  /** `handleWake` ainda abrindo o turno (status passa por `idle` no meio). */
  wakeOpening: boolean;
  listening: boolean;
  realtimeTurnActive: boolean;
  /** Áudio do Live tocando ou represado para tocar. */
  liveAudioPending: boolean;
  localAudioAudible: boolean;
  halted: boolean;
}

/**
 * F-1563: `status === 'idle'` não prova voz livre. `handleWake` passa por `idle`
 * antes de a captura abrir (e o `subscribe` do store reage a esse blip), então
 * a narração de handoffs começava junto com o wake e falava por cima do turno.
 */
export function canStartNarration(s: NarrationVoiceState): boolean {
  return (
    !s.halted &&
    s.status === 'idle' &&
    !s.turnBusy &&
    !s.wakeOpening &&
    !s.listening &&
    !s.realtimeTurnActive &&
    !s.liveAudioPending &&
    !s.localAudioAudible
  );
}

/**
 * A síntese leva segundos (14-28 s com a TTS local lenta) e o relato só fala se
 * NINGUÉM tomou a voz nesse meio tempo. A posse NÃO lê `status`: o HUD volta a
 * `idle` sem takeover nenhum (o watchdog de status preso, um evento `dormant` do
 * Live) e, quando a posse exigia `speaking`, o relato era devolvido à fila e
 * sintetizado de novo, em laço, sem nunca falar. Takeover de verdade é o token
 * do turno ter mudado desde o início (`startTurnToken`) ou algum sinal de turno
 * estar ativo agora.
 */
export function narrationStillOwnsVoice(
  s: NarrationVoiceState,
  startTurnToken: number,
  localAudioPlaying = false,
): boolean {
  return (
    !s.halted &&
    s.turnToken === startTurnToken &&
    !s.turnBusy &&
    !s.wakeOpening &&
    !s.listening &&
    !s.realtimeTurnActive &&
    !s.liveAudioPending &&
    !localAudioPlaying
  );
}

export interface NarrationPlayerDeps {
  isMuted(): boolean;
  isHalted(): boolean;
  voiceState(): NarrationVoiceState;
  setStatus(status: 'speaking' | 'idle'): void;
  stopPlayback(): void;
  /** Sintetiza o relato. Precisa rejeitar no deadline da TTS: a síntese nunca é ilimitada. */
  synthesize(text: string): Promise<SpeakResult>;
  playAudio(audioBase64: string, format: string): Promise<unknown>;
  /**
   * Avisa o watchdog de status preso que há uma síntese em curso. Sem isso,
   * `speaking` sem áudio audível por 6 s lia como travamento: o watchdog forçava
   * `idle` e derrubava o relato no meio da síntese.
   */
  setSynthesizing(active: boolean): void;
  /** Devolve o relato à frente da fila. */
  requeue(text: string): void;
  /** O relato foi adiado porque um turno tomou a voz durante a síntese. */
  onDeferred?(state: NarrationVoiceState): void;
}

/** Fala UM relato: sintetiza, revalida a posse da voz e toca. */
export function createNarrationPlayer(
  deps: NarrationPlayerDeps,
): (text: string) => Promise<void> {
  return async (text) => {
    if (deps.isMuted() || deps.isHalted()) return;
    const turnAtStart = deps.voiceState().turnToken;
    try {
      deps.setStatus('speaking');
      deps.stopPlayback();
      let spoken: SpeakResult;
      deps.setSynthesizing(true);
      try {
        spoken = await deps.synthesize(text);
      } finally {
        deps.setSynthesizing(false);
      }
      if (deps.isHalted() || deps.isMuted()) return;
      // Um wake/turno que assumiu a voz nesse meio tempo ganha: o relato volta
      // para a fila em vez de falar por cima dele.
      const state = deps.voiceState();
      if (!narrationStillOwnsVoice(state, turnAtStart)) {
        deps.requeue(text);
        deps.onDeferred?.(state);
        return;
      }
      if (spoken.ok && spoken.mode === 'audio') {
        // O HUD pode ter voltado a `idle` durante a síntese sem que ninguém
        // tomasse a voz: o áudio toca com o estado dele de volta.
        deps.setStatus('speaking');
        await deps.playAudio(spoken.audioBase64, spoken.format);
      }
    } finally {
      if (deps.voiceState().status === 'speaking') deps.setStatus('idle');
    }
  };
}

export interface NarrationQueueOptions {
  canPlay(): boolean;
  play(text: string): Promise<void>;
  onError?(error: unknown): void;
  /** O relato esgotou as tentativas (a voz foi tomada em todas) e foi descartado. */
  onDrop?(text: string, attempts: number): void;
  maxPending?: number;
  /** Tentativas por relato (a primeira + devoluções à fila). Padrão 3. */
  maxAttempts?: number;
}

/** Serial report-back queue: busy voice turns defer narration instead of losing it. */
export class NarrationQueue {
  private pending: string[] = [];
  private activeText: string | null = null;
  private draining = false;
  private disposed = false;
  private readonly maxPending: number;
  private readonly maxAttempts: number;
  /** Quantas vezes cada relato já começou a ser falado (devolução à fila conta). */
  private readonly attempts = new Map<string, number>();

  constructor(private readonly options: NarrationQueueOptions) {
    this.maxPending = Math.max(1, options.maxPending ?? DEFAULT_MAX_PENDING);
    this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  }

  enqueue(rawText: string): void {
    if (this.disposed) return;
    const text = rawText.replace(/\s+/g, ' ').trim().slice(0, MAX_NARRATION_CHARS);
    if (!text || this.activeText === text || this.pending.includes(text)) return;
    if (this.pending.length >= this.maxPending) this.pending.shift();
    this.pending.push(text);
    this.kick();
  }

  /** Devolve uma fala interrompida à frente da fila (turno abriu durante a síntese). */
  requeue(rawText: string): void {
    if (this.disposed) return;
    const text = rawText.replace(/\s+/g, ' ').trim().slice(0, MAX_NARRATION_CHARS);
    if (!text || this.pending.includes(text)) return;
    this.pending.unshift(text);
    if (this.pending.length > this.maxPending) this.pending.pop();
  }

  kick(): void {
    if (this.disposed || this.draining || !this.options.canPlay()) return;
    this.draining = true;
    void this.drain();
  }

  clear(): void {
    this.pending = [];
    this.activeText = null;
    this.attempts.clear();
  }

  /**
   * Drop pending work and make the active drain exit ASAP. Callers must also
   * stop playback; this only prevents further queue items from speaking.
   */
  halt(): void {
    this.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
  }

  get size(): number {
    return this.pending.length;
  }

  private async drain(): Promise<void> {
    try {
      while (!this.disposed && this.pending.length > 0 && this.options.canPlay()) {
        const text = this.pending.shift()!;
        // Cada síntese custa uma chamada de TTS: um relato que a voz tomada
        // devolve à fila sem parar não pode virar um laço de re-sínteses.
        const attempt = (this.attempts.get(text) ?? 0) + 1;
        if (attempt > this.maxAttempts) {
          this.attempts.delete(text);
          this.options.onDrop?.(text, attempt - 1);
          continue;
        }
        this.attempts.set(text, attempt);
        this.activeText = text;
        try {
          await this.options.play(text);
        } catch (error) {
          this.options.onError?.(error);
        } finally {
          this.activeText = null;
        }
        // Falou (ou falhou) sem pedir devolução: a contagem do relato acaba aqui.
        if (!this.pending.includes(text)) this.attempts.delete(text);
      }
    } finally {
      this.draining = false;
      if (!this.disposed && this.pending.length > 0 && this.options.canPlay()) {
        this.kick();
      }
    }
  }
}
