import type {
  RealtimeTranscriptEvent,
  TurnManagedRealtimeProvider,
} from './provider';

/**
 * Placeholder for the Fase 3.5 Gemini Live provider. The legacy Gemini transport
 * still exists under src/main/voice; this stub keeps the new provider factory
 * explicit without pretending the fallback has the OpenAI-compatible contract.
 */
export class GeminiLiveProvider implements TurnManagedRealtimeProvider {
  readonly isReady = false;

  private readonly errorCallbacks: Array<(err: Error) => void> = [];

  connect(): Promise<void> {
    const err = new Error('Gemini Live provider is stubbed for Fase 3.5');
    this.emitError(err);
    return Promise.reject(err);
  }

  sendAudioChunk(_pcm16: Int16Array): void {}

  onTranscript(_cb: (delta: string, final: boolean) => void): void {}

  onRoleTranscript(_cb: (event: RealtimeTranscriptEvent) => void): void {}

  onAudioOut(_cb: (pcm16: Int16Array) => void): void {}

  onError(cb: (err: Error) => void): void {
    this.errorCallbacks.push(cb);
  }

  onInterrupted(_cb: () => void): void {}

  onResponseDone(_cb: () => void): void {}

  interrupt(): void {}

  close(): void {}

  endUserTurn(): void {}

  sendContext(_text: string): void {}

  sendText(_text: string): void {}

  private emitError(err: Error): void {
    for (const cb of this.errorCallbacks) cb(err);
  }
}
