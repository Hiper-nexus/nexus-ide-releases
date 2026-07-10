export function hasRealtimeProviderAudioAnswer(opts: {
  heldChunks: number;
  playedChunks: number;
}): boolean {
  return opts.heldChunks > 0 || opts.playedChunks > 0;
}
