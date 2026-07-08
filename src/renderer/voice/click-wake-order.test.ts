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
  it('plays the audible ack before opening the command capture window', () => {
    const block = clickWakeBlock();
    expect(block.indexOf('await playWakePrompt')).toBeGreaterThanOrEqual(0);
    expect(block.indexOf('await beginListening')).toBeGreaterThan(
      block.indexOf('await playWakePrompt'),
    );
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
