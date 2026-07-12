export function hasRealtimeProviderAudioAnswer(opts: {
  heldChunks: number;
  playedChunks: number;
}): boolean {
  return opts.heldChunks > 0 || opts.playedChunks > 0;
}

/**
 * An explicit wake/click may legitimately receive provider audio without a
 * final transcript, so it gets one continuity window. An automatic reply
 * window must not renew itself from audio alone: room/TV speech can make the
 * provider answer and otherwise create an endless listen → answer → listen
 * loop. A valid transcript or a correlated tool completion still rearms via
 * their normal paths.
 */
export function shouldRearmAfterAudioOnly(captureReason: string): boolean {
  return captureReason !== 'reply';
}
