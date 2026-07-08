import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(__dirname, 'voice-controller.ts'), 'utf-8');

function clickWakeBlock(): string {
  const start = source.indexOf("if (source === 'click') {");
  const end = source.indexOf('return;', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('click wake order', () => {
  it('plays Classic ack before listen only when Live does not own the voice', () => {
    const block = clickWakeBlock();
    // FIX A: Classic ack is gated by skipClassicAck — Live path opens listen silently.
    expect(block).toContain('if (!skipClassicAck)');
    expect(block).toContain('await playWakePrompt');
    expect(block).toContain('await beginListening');
    // When Classic ack runs, it still precedes beginListening inside that branch.
    const ackIdx = block.indexOf('await playWakePrompt');
    const listenIdx = block.indexOf('await beginListening');
    expect(ackIdx).toBeGreaterThanOrEqual(0);
    expect(listenIdx).toBeGreaterThan(ackIdx);
  });

  it('does not seed click capture with ack pre-roll audio', () => {
    const block = clickWakeBlock();
    expect(block).not.toContain('snapshotPreRoll');
    expect(block).toContain("'click',");
    expect(block).toContain('[],');
  });

  it('keeps mouse wake responsive after speech while preserving a long hard cap', () => {
    expect(source).toContain('const CLICK_WAKE_MIN_LISTEN_MS = 1_125');
    expect(source).toContain('const CLICK_WAKE_MAX_MS = 22_000');
  });
});
