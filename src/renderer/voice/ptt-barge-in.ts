import type { VoiceUiStatus } from './voice-store';

export type PttStartAction = 'ignore' | 'start' | 'barge-in';

/**
 * PTT is an explicit user gesture.  It may interrupt output, unlike passive
 * wake detection, but must never create a second capture while one is open.
 */
export function pttStartAction(opts: {
  isListening: boolean;
  isBusy: boolean;
  status: VoiceUiStatus;
}): PttStartAction {
  if (opts.isListening) return 'ignore';
  if (opts.status === 'speaking') return 'barge-in';
  return opts.isBusy ? 'ignore' : 'start';
}
