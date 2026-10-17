const DEFAULT_MAX_PENDING = 12;
const MAX_NARRATION_CHARS = 2_000;

/** Snapshot of everything that can already own the voice when a narration wants it. */
export interface NarrationVoiceState {
  status: string;
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
 * F-1545: `status === 'idle'` não prova voz livre. `handleWake` passa por `idle`
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
 * A síntese leva segundos. `play` marca `speaking` antes dela; se ao voltar o
 * status deixou de ser esse (wake pôs `idle`/`listening`) ou um turno abriu, o
 * áudio já nasceu velho: não toca, a fala volta para a fila.
 */
export function narrationStillOwnsVoice(
  s: NarrationVoiceState,
  localAudioPlaying = false,
): boolean {
  return (
    !s.halted &&
    s.status === 'speaking' &&
    !s.turnBusy &&
    !s.wakeOpening &&
    !s.listening &&
    !s.realtimeTurnActive &&
    !s.liveAudioPending &&
    !localAudioPlaying
  );
}

export interface NarrationQueueOptions {
  canPlay(): boolean;
  play(text: string): Promise<void>;
  onError?(error: unknown): void;
  maxPending?: number;
}

/** Serial report-back queue: busy voice turns defer narration instead of losing it. */
export class NarrationQueue {
  private pending: string[] = [];
  private activeText: string | null = null;
  private draining = false;
  private disposed = false;
  private readonly maxPending: number;

  constructor(private readonly options: NarrationQueueOptions) {
    this.maxPending = Math.max(1, options.maxPending ?? DEFAULT_MAX_PENDING);
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
        this.activeText = text;
        try {
          await this.options.play(text);
        } catch (error) {
          this.options.onError?.(error);
        } finally {
          this.activeText = null;
        }
      }
    } finally {
      this.draining = false;
      if (!this.disposed && this.pending.length > 0 && this.options.canPlay()) {
        this.kick();
      }
    }
  }
}
