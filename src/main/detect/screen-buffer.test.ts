import { describe, expect, it } from 'vitest';

import { SessionScreenBuffer } from './screen-buffer';

describe('SessionScreenBuffer', () => {
  it('strips ANSI and keeps plain text', () => {
    const buffer = new SessionScreenBuffer();
    buffer.append('s', '\x1b[1;32mgreen\x1b[0m plain\r\nnext');
    expect(buffer.text('s')).toBe('green plain\nnext');
    expect(buffer.contentSeq('s')).toBe(1);
  });

  it('rejoins an OSC sequence split across chunks', () => {
    const buffer = new SessionScreenBuffer();
    buffer.append('s', 'text\x1b]0;partial ti');
    expect(buffer.text('s')).toBe('text');
    buffer.append('s', 'tle\x07rest');
    expect(buffer.text('s')).toBe('textrest');
  });

  it('rejoins a CSI sequence split across chunks', () => {
    const buffer = new SessionScreenBuffer();
    buffer.append('s', 'a\x1b[1;');
    expect(buffer.text('s')).toBe('a');
    buffer.append('s', '32mb');
    expect(buffer.text('s')).toBe('ab');
  });

  it('does not bump contentSeq for pure escape traffic', () => {
    const buffer = new SessionScreenBuffer();
    buffer.append('s', 'visible');
    const seq = buffer.contentSeq('s');
    buffer.append('s', '\x1b]0;title\x07\x1b[2K');
    expect(buffer.contentSeq('s')).toBe(seq);
  });

  it('strips complete trailing escapes without lagging the text', () => {
    const buffer = new SessionScreenBuffer();
    buffer.append('s', 'done\x1b[0m');
    expect(buffer.text('s')).toBe('done');
  });

  it('caps the retained tail', () => {
    const buffer = new SessionScreenBuffer();
    buffer.append('s', 'x'.repeat(300_000));
    expect(buffer.text('s').length).toBeLessThanOrEqual(262_144);
  });

  it('keeps state per session and drops it', () => {
    const buffer = new SessionScreenBuffer();
    buffer.append('a', 'aaa');
    buffer.append('b', 'bbb');
    buffer.drop('a');
    expect(buffer.text('a')).toBe('');
    expect(buffer.text('b')).toBe('bbb');
  });
});
