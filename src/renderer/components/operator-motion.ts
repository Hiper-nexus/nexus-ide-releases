export type OperatorMood = 'idle' | 'celebrating' | 'evolving' | 'sleeping';

export function shouldAnimateOperatorMood(
  mood: OperatorMood,
  reducedMotion: boolean,
  documentVisible: boolean,
): boolean {
  if (reducedMotion || !documentVisible) return false;
  // Sleeping stays still (calm empty states); everything else breathes — idle
  // slowly, celebrating/evolving lively (cadence via operatorFrameMs).
  return mood !== 'sleeping';
}

/** Frame cadence (ms) per mood: idle = slow calm breathing, action = snappy. */
export function operatorFrameMs(mood: OperatorMood): number {
  return mood === 'celebrating' || mood === 'evolving' ? 200 : 640;
}
