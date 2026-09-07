import { describe, expect, it } from 'vitest';

import { OscTracker } from './osc';

describe('OscTracker', () => {
  it('captures OSC 0/2 titles with BEL and ST terminators', () => {
    const osc = new OscTracker();
    osc.feed('s', 'plain\x1b]0;✳ Claude Code\x07more');
    expect(osc.title('s')).toBe('✳ Claude Code');
    osc.feed('s', '\x1b]2;⠋ Working\x1b\\tail');
    expect(osc.title('s')).toBe('⠋ Working');
  });

  it('captures the OSC 9 progress payload after "9;"', () => {
    const osc = new OscTracker();
    osc.feed('s', '\x1b]9;4;3;\x07');
    expect(osc.progress('s')).toBe('4;3;');
    osc.feed('s', '\x1b]9;4;0;\x1b\\');
    expect(osc.progress('s')).toBe('4;0;');
  });

  it('rejoins sequences split across chunks', () => {
    const osc = new OscTracker();
    osc.feed('s', 'text\x1b]0;Spl');
    expect(osc.title('s')).toBe('');
    osc.feed('s', 'it title\x07rest');
    expect(osc.title('s')).toBe('Split title');
  });

  it('sanitizes control characters and caps length', () => {
    const osc = new OscTracker();
    osc.feed('s', `\x1b]0;ab\x01cd\x07`);
    expect(osc.title('s')).toBe('abcd');
    osc.feed('s', `\x1b]0;${'x'.repeat(400)}\x07`);
    expect(osc.title('s')).toHaveLength(256);
  });

  it('keeps state per session and drops it on exit', () => {
    const osc = new OscTracker();
    osc.feed('a', '\x1b]0;title-a\x07');
    osc.feed('b', '\x1b]0;title-b\x07');
    expect(osc.title('a')).toBe('title-a');
    osc.drop('a');
    expect(osc.title('a')).toBe('');
    expect(osc.title('b')).toBe('title-b');
  });

  it('ignores unknown OSC codes and empty payloads clear the title', () => {
    const osc = new OscTracker();
    osc.feed('s', '\x1b]0;something\x07');
    osc.feed('s', '\x1b]1337;ignored\x07');
    expect(osc.title('s')).toBe('something');
    osc.feed('s', '\x1b]0;\x07');
    expect(osc.title('s')).toBe('');
  });

  it('survives an unterminated sequence without leaking memory', () => {
    const osc = new OscTracker();
    osc.feed('s', `\x1b]0;${'y'.repeat(10_000)}`);
    osc.feed('s', 'next\x1b]0;final\x07');
    expect(osc.title('s')).toBe('final');
  });
});
