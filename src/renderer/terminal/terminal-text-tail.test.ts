import { describe, expect, it } from 'vitest';
import { readTerminalTextTail, type TerminalTextBuffer, type TerminalTextLine } from './terminal-text-tail';

function buffer(lines: readonly (string | { text: string; wrapped: boolean })[], cursorY = lines.length - 1) {
  let visits = 0;
  const value: TerminalTextBuffer = {
    length: lines.length, baseY: 0, cursorY,
    getLine(index): TerminalTextLine | undefined {
      visits++;
      const line = lines[index];
      if (line === undefined) return undefined;
      const text = typeof line === 'string' ? line : line.text;
      return {
        isWrapped: typeof line !== 'string' && line.wrapped,
        length: text.length,
        getCell: (index) => index >= 0 && index < text.length
          ? { getWidth: () => 1, getChars: () => text[index]! } : undefined,
        translateToString: (trimRight) => trimRight ? text.trimEnd() : text,
      };
    },
  };
  return { value, visits: () => visits };
}

function tail(value: TerminalTextBuffer, maxChars = 2_400): string {
  return readTerminalTextTail({ normal: value, active: value }, maxChars);
}

describe('readTerminalTextTail', () => {
  it('preserves explicit empty lines and joins wrapped lines without removing their spaces', () => {
    const input = buffer(['old', 'hello ', { text: 'world', wrapped: true }, '', 'next']);
    expect(tail(input.value)).toBe('old\nhello world\n\nnext');
  });

  it('keeps cursor newlines but ignores unused blank rows below it', () => {
    expect(tail(buffer(['hello', '', '', ''], 1).value)).toBe('hello\n');
    expect(tail(buffer(['hello', 'below cursor', ''], 0).value)).toBe('hello\nbelow cursor');
  });

  it('reads only enough history for the requested suffix', () => {
    const input = buffer([...Array.from({ length: 10_000 }, () => 'old history'), 'latest answer']);
    expect(tail(input.value, 6)).toBe('answer');
    expect(input.visits()).toBe(1);
  });

  it('bounds visits even when thousands of wrapped rows contain no text', () => {
    const input = buffer(Array.from({ length: 10_000 }, () => ({ text: '', wrapped: true })));
    expect(tail(input.value, 20)).toBe('');
    expect(input.visits()).toBeLessThanOrEqual(256);
  });

  it('preserves Unicode without cutting a surrogate pair at the boundary', () => {
    const input = buffer(['olá 漢字 e\u0301 😀fim']);
    expect(tail(input.value)).toBe('olá 漢字 e\u0301 😀fim');
    expect(tail(input.value, 4)).toBe('fim');
    expect(tail(input.value, 5)).toBe('😀fim');
  });

  it('includes the active alternate screen after normal history, without reading normal when full', () => {
    const normal = buffer(['old context']);
    const active = buffer(['login expired']);
    expect(readTerminalTextTail({ normal: normal.value, active: active.value })).toBe('old context\nlogin expired');
    const untouched = buffer(['old context']);
    expect(readTerminalTextTail({ normal: untouched.value, active: active.value }, 7)).toBe('expired');
    expect(untouched.visits()).toBe(0);
  });

  it('rejects invalid budgets without visiting the buffer', () => {
    const input = buffer(['content']);
    for (const max of [0, -1, NaN, Infinity]) expect(tail(input.value, max)).toBe('');
    expect(input.visits()).toBe(0);
  });
});
