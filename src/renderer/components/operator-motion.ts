export type OperatorMood = 'idle' | 'celebrating' | 'evolving' | 'sleeping';

export function shouldAnimateOperatorMood(
  mood: OperatorMood,
  reducedMotion: boolean,
  documentVisible: boolean,
): boolean {
  if (reducedMotion || !documentVisible) return false;
  return mood === 'celebrating' || mood === 'evolving';
}
