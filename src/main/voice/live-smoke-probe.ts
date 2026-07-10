import type {
  JarvisLiveSmokeFailureReason,
  JarvisLiveSmokeTestResult,
} from '../../shared/voice-ipc';
import type { TurnManagedRealtimeProvider } from '../jarvis/realtime/provider';
import type { JarvisLiveSession } from './jarvis-live';

const LIVE_SMOKE_RESPONSE_TIMEOUT_MS = 15_000;

interface ActiveSmokeProbe {
  startedAt: number;
  timer: ReturnType<typeof setTimeout>;
  resolve(result: JarvisLiveSmokeTestResult): void;
  /** Provider PCM deliveries that belong to this diagnostic and await renderer proof. */
  pendingPlaybackIds: Set<string>;
}

export class LiveSmokeProbe {
  private active: ActiveSmokeProbe | null = null;

  constructor(
    private readonly fsm: JarvisLiveSession,
    private readonly now: () => number,
  ) {}

  get isActive(): boolean {
    return this.active !== null;
  }

  failure(reason: JarvisLiveSmokeFailureReason): JarvisLiveSmokeTestResult {
    return {
      ok: false,
      evidence: 'none',
      latencyMs: null,
      reason,
      state: this.fsm.getState(),
    };
  }

  settleFailure(reason: JarvisLiveSmokeFailureReason): void {
    const probe = this.active;
    if (!probe) return;
    this.active = null;
    clearTimeout(probe.timer);
    probe.resolve(this.failure(reason));
  }

  /** Records provider PCM, but deliberately does not make the probe green yet. */
  noteProviderAudio(deliveryId: string): void {
    this.active?.pendingPlaybackIds.add(deliveryId);
  }

  /** Only the renderer can prove that a particular PCM delivery started. */
  settlePlaybackStarted(deliveryId: string): void {
    const probe = this.active;
    if (!probe || !probe.pendingPlaybackIds.has(deliveryId)) return;
    this.active = null;
    clearTimeout(probe.timer);
    probe.resolve({
      ok: true,
      evidence: 'audio',
      latencyMs: Math.max(0, Math.round(this.now() - probe.startedAt)),
      state: this.fsm.getState(),
    });
  }

  /** A playback error on the exact delivery invalidates an active diagnostic. */
  settlePlaybackFailure(deliveryId: string): void {
    const probe = this.active;
    if (!probe || !probe.pendingPlaybackIds.has(deliveryId)) return;
    this.settleFailure('audio_playback_failed');
  }

  /**
   * A response can complete before WebAudio schedules its last IPC chunk. When
   * PCM was delivered, keep waiting for its matching renderer acknowledgement;
   * the diagnostic timeout remains the final guardrail.
   */
  settleResponseDone(): void {
    const probe = this.active;
    if (!probe || probe.pendingPlaybackIds.size > 0) return;
    this.settleFailure('no_audio_response');
  }

  run(
    provider: TurnManagedRealtimeProvider,
    text: string,
  ): Promise<JarvisLiveSmokeTestResult> {
    return new Promise<JarvisLiveSmokeTestResult>((resolve) => {
      const startedAt = this.now();
      const timer = setTimeout(() => {
        this.settleFailure('response_timeout');
      }, LIVE_SMOKE_RESPONSE_TIMEOUT_MS);
      this.active = {
        startedAt,
        timer,
        resolve,
        pendingPlaybackIds: new Set(),
      };
      try {
        provider.sendText(text);
        this.fsm.patchStatus({ status: 'thinking', realtimeReady: true });
      } catch {
        this.settleFailure('provider_error');
      }
    });
  }
}
