import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  armRealtimeToolNarration,
  clearRealtimeToolNarrations,
  peekRealtimeToolNarration,
  takeSilentRealtimeToolNarration,
  waitForToolNarrationAudio,
} from './realtime-tool-narration';

beforeEach(clearRealtimeToolNarrations);

describe('realtime tool narration fallback', () => {
  it('returns local narration when the provider completed without audio', () => {
    armRealtimeToolNarration('call-1', 'Confirmo?', 10);
    expect(peekRealtimeToolNarration('call-1')?.text).toBe('Confirmo?');
    expect(takeSilentRealtimeToolNarration('call-1', 10)).toBe('Confirmo?');
    expect(takeSilentRealtimeToolNarration('call-1', 10)).toBeNull();
  });

  it('does not duplicate narration when provider audio already started', () => {
    armRealtimeToolNarration('call-2', 'Feito.', 20);
    expect(takeSilentRealtimeToolNarration('call-2', 21)).toBeNull();
  });

  it('waits for provider audio before declaring silence', async () => {
    let played = 10;
    const delay = vi.fn(async () => {
      played = 11;
    });
    await expect(
      waitForToolNarrationAudio(10, () => played, {
        graceMs: 200,
        pollMs: 50,
        delay,
      }),
    ).resolves.toBe('provider');
  });

  it('returns silent when no audio arrives in the grace window', async () => {
    const delay = vi.fn(async () => {});
    await expect(
      waitForToolNarrationAudio(5, () => 5, {
        graceMs: 80,
        pollMs: 20,
        delay,
      }),
    ).resolves.toBe('silent');
  });
});
