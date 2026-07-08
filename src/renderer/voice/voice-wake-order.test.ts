import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(__dirname, 'voice-controller.ts'), 'utf-8');

function voiceWakeBlock(): string {
  const marker = '// Wake por voz: mic abre em paralelo com o ack';
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('} catch (err) {', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('voice wake order', () => {
  it('opens the mic in parallel with the audible ack', () => {
    const block = voiceWakeBlock();
    expect(block.indexOf('const listenPromise = beginListening')).toBeGreaterThanOrEqual(0);
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

  it('uses lowered wake capture thresholds', () => {
    expect(source).toContain('const WAKE_MIN_LISTEN_MS = 1_500');
    expect(source).toContain('const WAKE_SILENCE_MS = 700');
  });
});

describe('realtime bridge activation', () => {
  it('enables the realtime audio + action bridge (paridade completa)', () => {
    expect(source).toContain('const REALTIME_ACTION_BRIDGE_ENABLED = true');
    expect(source).toContain('const REALTIME_PROVIDER_AUDIO_ENABLED = true');
  });

  it('keeps the runtime degradation-to-Classic guards in shouldStreamToRealtime', () => {
    // Mesmo com os flags ligados, streamar realtime ainda exige config realtime,
    // credencial (canAttemptRealtime) e um socket saudável (status !== 'error') —
    // sem isso, cai para o Classic. Guarda contra remover a degradação em runtime.
    expect(source).toContain('canAttemptRealtime(info)');
    expect(source).toMatch(/liveState\?\.status !== 'error'/);
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
});
