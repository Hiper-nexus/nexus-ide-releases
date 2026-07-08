import type { JarvisAction, JarvisLiveToolEvent } from '../../shared/voice-ipc';
import { realtimeArgsToJarvisAction } from '../../shared/voice-realtime-actions';

export function realtimeToolEventToJarvisAction(
  event: JarvisLiveToolEvent,
): JarvisAction | null {
  if (event.source !== 'realtime' || event.name !== 'nexus_action' || !event.callId) {
    return null;
  }
  return realtimeArgsToJarvisAction(event.args ?? {});
}
