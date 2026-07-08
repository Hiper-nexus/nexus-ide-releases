import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(__dirname, 'voice-controller.ts'), 'utf-8');
// Constants and gates moved to sub-modules — check them too.
const sessionStateSource = fs.readFileSync(
  path.join(__dirname, 'voice-session-state.ts'),
  'utf-8',
);
const gatesSource = fs.readFileSync(path.join(__dirname, 'voice-realtime-gates.ts'), 'utf-8');

function voiceWakeBlock(): string {
  const marker = 'const listenPromise = beginListening';
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('} catch (err) {', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('voice wake order', () => {
  it('opens the mic in parallel with (or before) the audible ack', () => {
    const block = voiceWakeBlock();
    // listenPromise is created before the optional ack (Live path skips ack).
    expect(block.indexOf('const listenPromise = beginListening')).toBeGreaterThanOrEqual(0);
    // When Classic ack plays, it comes AFTER listenPromise (parallel pattern).
    expect(block.indexOf('await playWakePrompt')).toBeGreaterThan(
      block.indexOf('const listenPromise = beginListening'),
    );
    expect(block).toContain('await listenPromise');
  });

  it('seeds voice capture with wake pre-roll audio', () => {
    const block = voiceWakeBlock();
    expect(block).toContain('wakePreRoll');
    expect(block).toContain("'wake'");
  });

  it('skips Classic ack when Live owns the voice (shouldSkipClassicWakeAck)', () => {
    // FIX A: Live path guard must exist in the voice-wake block.
    const block = voiceWakeBlock();
    expect(block).toContain('skipClassicAck');
  });

  it('uses lowered wake capture thresholds', () => {
    expect(source).toContain('const WAKE_MIN_LISTEN_MS = 1_500');
    expect(source).toContain('const WAKE_SILENCE_MS = 700');
  });
});

describe('realtime bridge activation', () => {
  it('enables the realtime audio + action bridge (paridade completa)', () => {
    // Constants live in voice-session-state.ts (extracted for size budget).
    expect(sessionStateSource).toContain('const REALTIME_ACTION_BRIDGE_ENABLED = true');
    expect(sessionStateSource).toContain('const REALTIME_PROVIDER_AUDIO_ENABLED = true');
  });

  it('keeps the runtime degradation-to-Classic guards in shouldStreamToRealtime', () => {
    // Gates are in voice-realtime-gates.ts.
    expect(gatesSource).toContain('canAttemptRealtime(info)');
    expect(gatesSource).toMatch(/liveState\?\.status !== 'error'/);
  });
});

describe('wake barge-in guards', () => {
  it('allows interrupting speaking, transcribing, and routing', () => {
    expect(source).toMatch(
      /\['idle', 'listening', 'speaking', 'transcribing', 'routing'\]/,
    );
    expect(source).not.toMatch(
      /if \(voiceStatus === 'transcribing' \|\| voiceStatus === 'routing'\)/,
    );
  });

  it('ignores voice re-wake while Live is mid-reply (stutter guard)', () => {
    expect(source).toContain('shouldIgnoreLiveReWake');
    expect(source).toContain("source === 'voice' && shouldIgnoreLiveReWake");
    expect(gatesSource).toContain('export function shouldIgnoreLiveReWake');
  });

  it('never falls back to Classic TTS after Live wake inject (one voice)', () => {
    expect(source).toContain('jarvis.liveWakeGreetingSilent');
    expect(source).not.toContain('jarvis.liveWakeGreetingFallback');
    expect(source).not.toContain('Classic fala o Olá');
  });

  it('pre-holds Live mic before liveStart so wake inject is not raced by ambient', () => {
    const holdIdx = source.indexOf('willInjectWakeGreeting');
    const liveStartIdx = source.indexOf('forceFresh: willInjectWakeGreeting');
    expect(holdIdx).toBeGreaterThanOrEqual(0);
    expect(liveStartIdx).toBeGreaterThan(holdIdx);
    expect(source).toContain('clearLocalAudioGate()');
    expect(source).toContain('LIVE_WAKE_GREETING_MIC_HOLD_MS = 4_500');
    expect(source).toContain('jarvis.liveWakeGreetingAudio');
    expect(source).toContain('setLocalAudioWithholdUntil');
    expect(source).toContain('jarvis.liveWakeHardRebuildInject');
  });

  it('hard-resets Live before wake greeting inject (sync reset)', () => {
    expect(source).toContain('cancelLiveFollowUp()');
    expect(source).toContain('jarvis.wakeSyncReset');
    expect(source).toContain('liveHardTeardown');
    expect(source).toContain('forceFresh: willInjectWakeGreeting');
  });

  it('does not warm Classic ack/filler audio when Realtime can own voice', () => {
    const warmIndex = source.indexOf('warmAckCache(info.persona.userName ?? \'\')');
    const guardIndex = source.lastIndexOf('if (!canAttemptRealtime(info))', warmIndex);

    expect(warmIndex).toBeGreaterThanOrEqual(0);
    expect(guardIndex).toBeGreaterThanOrEqual(0);
  });
});
