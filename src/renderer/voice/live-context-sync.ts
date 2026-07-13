import { isJarvisLiveEnabled } from './voice-realtime-gates';
import { liveContextText } from './voice-live-ipc';

export const LIVE_CONTEXT_SYNC_INTERVAL_MS = 1_000;

interface LiveContextSynchronizerDependencies {
  readonly isEnabled: () => boolean;
  readonly read: () => string;
  readonly publish: (context: string) => void;
}

/** Publishes fresh structured UI state without flooding the realtime provider. */
export class LiveContextSynchronizer {
  readonly #isEnabled: () => boolean;
  readonly #read: () => string;
  readonly #publish: (context: string) => void;
  #previous = '';

  constructor(dependencies: LiveContextSynchronizerDependencies) {
    this.#isEnabled = dependencies.isEnabled;
    this.#read = dependencies.read;
    this.#publish = dependencies.publish;
  }

  tick(): boolean {
    if (!this.#isEnabled()) {
      this.#previous = '';
      return false;
    }
    const context = this.#read().trim();
    if (!context || context === this.#previous) return false;
    this.#previous = context;
    this.#publish(context);
    return true;
  }
}

export function startLiveContextSync(): () => void {
  const synchronizer = new LiveContextSynchronizer({
    isEnabled: isJarvisLiveEnabled,
    read: liveContextText,
    publish: (context) => window.nexus.voice.liveContextIn(context),
  });
  synchronizer.tick();
  const interval = window.setInterval(
    () => synchronizer.tick(),
    LIVE_CONTEXT_SYNC_INTERVAL_MS,
  );
  return () => window.clearInterval(interval);
}
