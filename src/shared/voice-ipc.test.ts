import { describe, expect, it } from 'vitest';
import {
  jarvisLiveAudioPlaybackEventSchema,
  jarvisLiveToolResultInputSchema,
  transcribeRequestSchema,
} from './voice-ipc';

describe('jarvisLiveAudioPlaybackEventSchema', () => {
  it('accepts a bounded renderer acknowledgement for a main-generated delivery', () => {
    expect(
      jarvisLiveAudioPlaybackEventSchema.safeParse({
        id: '5e04e44e-c77f-40aa-b65d-36d8b693dddf',
        outcome: 'started',
      }).success,
    ).toBe(true);
  });

  it('rejects malformed or widened renderer IPC payloads', () => {
    expect(
      jarvisLiveAudioPlaybackEventSchema.safeParse({
        id: 'not-a-delivery-id',
        outcome: 'started',
      }).success,
    ).toBe(false);
    expect(
      jarvisLiveAudioPlaybackEventSchema.safeParse({
        id: '5e04e44e-c77f-40aa-b65d-36d8b693dddf',
        outcome: 'failed',
        error: 'x'.repeat(281),
      }).success,
    ).toBe(false);
    expect(
      jarvisLiveAudioPlaybackEventSchema.safeParse({
        id: '5e04e44e-c77f-40aa-b65d-36d8b693dddf',
        outcome: 'started',
        injected: true,
      }).success,
    ).toBe(false);
  });
});

describe('transcribeRequestSchema', () => {
  const audio = Buffer.from('wav').toString('base64');

  it('allows the bounded passive wake purpose only', () => {
    expect(
      transcribeRequestSchema.safeParse({ audioBase64: audio, purpose: 'passive-wake' }).success,
    ).toBe(true);
    expect(
      transcribeRequestSchema.safeParse({ audioBase64: audio, purpose: 'arbitrary-provider' }).success,
    ).toBe(false);
  });
});

describe('jarvisLiveToolResultInputSchema', () => {
  it.each([
    ['new_agentic_mission', 'modo agêntico aberto'],
    ['read_current_view', 'visão atual lida'],
  ])('accepts the %s tool result', (tool, summary) => {
    expect(
      jarvisLiveToolResultInputSchema.safeParse({
        source: 'realtime',
        tool,
        ok: true,
        summary,
      }).success,
    ).toBe(true);
  });
});
