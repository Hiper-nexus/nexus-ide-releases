import { describe, expect, it } from 'vitest';
import {
  isSafeOscCwd,
  Osc133Scanner,
} from './shell-integration-osc133';

describe('Osc133Scanner', () => {
  it('parses A/B/C/D lifecycle and ignores plain text', () => {
    const scanner = new Osc133Scanner();
    const chunk =
      'hello\x1b]133;A\x07prompt\x1b]133;B\x07ls -la\x1b]133;C\x07out\x1b]133;D;0\x07';
    const events = scanner.push(chunk);
    expect(events.map((e) => e.kind)).toEqual([
      'prompt_start',
      'command_start',
      'command_executed',
      'command_finished',
    ]);
    expect(events.at(-1)).toMatchObject({
      kind: 'command_finished',
      exitCode: 0,
    });
  });

  it('handles ST-terminated sequences and split chunks', () => {
    const scanner = new Osc133Scanner();
    expect(scanner.push('\x1b]133;')).toEqual([]);
    expect(scanner.push('E;echo hi\x1b\\')).toEqual([
      { kind: 'command_line', command: 'echo hi' },
    ]);
  });

  it('parses cwd from OSC 133 P and OSC 7', () => {
    const scanner = new Osc133Scanner();
    const events = scanner.push(
      '\x1b]133;P;cwd=/Users/dev/proj\x07\x1b]7;file://host/tmp/work\x07',
    );
    expect(events).toEqual([
      { kind: 'cwd', path: '/Users/dev/proj' },
      { kind: 'cwd', path: '/tmp/work' },
    ]);
  });

  it('does not throw on garbage or missing integration', () => {
    const scanner = new Osc133Scanner();
    expect(scanner.push('just normal shell output\n')).toEqual([]);
    expect(scanner.push('\x1b]999;nope\x07')).toEqual([]);
  });

  it('validates safe absolute cwd only', () => {
    expect(isSafeOscCwd('/tmp/ok')).toBe(true);
    expect(isSafeOscCwd('C:\\Users\\ok')).toBe(true);
    expect(isSafeOscCwd('relative')).toBe(false);
    expect(isSafeOscCwd('~/home')).toBe(false);
    expect(isSafeOscCwd('a\0b')).toBe(false);
  });
});
