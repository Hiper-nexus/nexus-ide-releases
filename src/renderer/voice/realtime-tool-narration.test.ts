import { beforeEach, describe, expect, it } from 'vitest';
import {
  armRealtimeToolNarration,
  clearRealtimeToolNarrations,
  takeSilentRealtimeToolNarration,
} from './realtime-tool-narration';

beforeEach(clearRealtimeToolNarrations);

describe('realtime tool narration fallback', () => {
  it('returns local narration when the provider completed without audio', () => {
    armRealtimeToolNarration('call-1', 'Confirmo?', 10);
    expect(takeSilentRealtimeToolNarration('call-1', 10)).toBe('Confirmo?');
    expect(takeSilentRealtimeToolNarration('call-1', 10)).toBeNull();
  });

  it('does not duplicate narration when provider audio already started', () => {
    armRealtimeToolNarration('call-2', 'Feito.', 20);
    expect(takeSilentRealtimeToolNarration('call-2', 21)).toBeNull();
  });
});
