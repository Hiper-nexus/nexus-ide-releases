import type { JarvisLiveState } from '../../shared/voice-ipc';
import type { VoiceUiStatus } from './voice-store';

/**
 * The realtime provider can emit `dormant` after a cancelled/finished response
 * while the renderer mic is still actively capturing a wake/click command.
 * Do not let that provider lifecycle event visually close Jarvis mid-listen.
 */
export function voiceHudStatusFromLiveState(
  state: JarvisLiveState,
  isCapturingCommand: boolean,
): VoiceUiStatus | null {
  if (state.status === 'speaking') return 'speaking';
  if (state.status === 'listening' && isCapturingCommand) return 'listening';
  if (state.status === 'dormant') return isCapturingCommand ? null : 'idle';
  return null;
}
