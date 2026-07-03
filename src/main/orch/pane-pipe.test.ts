import { describe, expect, it } from 'vitest';
import {
  InjectionGuard,
  MAX_PENDING_LINE,
  canForward,
  extractCompleteLines,
  sanitizeForInjection,
} from './pane-pipe-core';

describe('extractCompleteLines', () => {
  it('extracts complete lines and keeps the trailing partial as rest', () => {
    const result = extractCompleteLines('', 'first\nsecond\npart');
    expect(result.lines).toEqual(['first', 'second']);
    expect(result.rest).toBe('part');
  });

  it('joins a line split across chunk boundaries', () => {
    const a = extractCompleteLines('', 'hel');
    expect(a.lines).toEqual([]);
    expect(a.rest).toBe('hel');

    const b = extractCompleteLines(a.rest, 'lo world\nnext');
    expect(b.lines).toEqual(['hello world']);
    expect(b.rest).toBe('next');
  });

  it('strips the trailing \\r of CRLF line endings', () => {
    const result = extractCompleteLines('', 'one\r\ntwo\r\n');
    expect(result.lines).toEqual(['one', 'two']);
    expect(result.rest).toBe('');
  });

  it('returns empty rest when the chunk ends exactly on a newline', () => {
    const result = extractCompleteLines('tail', ' end\n');
    expect(result.lines).toEqual(['tail end']);
    expect(result.rest).toBe('');
  });

  it('handles a chunk with no newline at all', () => {
    const result = extractCompleteLines('abc', 'def');
    expect(result.lines).toEqual([]);
    expect(result.rest).toBe('abcdef');
  });

  it('preserves empty lines between newlines', () => {
    const result = extractCompleteLines('', 'a\n\nb\n');
    expect(result.lines).toEqual(['a', '', 'b']);
  });

  it('caps a runaway partial line at MAX_PENDING_LINE keeping the tail', () => {
    const huge = 'x'.repeat(MAX_PENDING_LINE + 100) + 'TAIL';
    const result = extractCompleteLines('', huge);
    expect(result.lines).toEqual([]);
    expect(result.rest.length).toBe(MAX_PENDING_LINE);
    expect(result.rest.endsWith('TAIL')).toBe(true);
  });
});

describe('canForward (anti-loop guard)', () => {
  it('refuses a pipe whose source and target are the same pane', () => {
    expect(canForward('pane-1', 'pane-1')).toBe(false);
  });

  it('refuses empty pane ids', () => {
    expect(canForward('', 'pane-2')).toBe(false);
    expect(canForward('pane-1', '')).toBe(false);
  });

  it('allows distinct panes', () => {
    expect(canForward('pane-1', 'pane-2')).toBe(true);
  });
});

describe('InjectionGuard (echo suppression)', () => {
  it('swallows the echo of an injected line exactly once', () => {
    const guard = new InjectionGuard();
    guard.markInjected('sess-b', 'do the thing');
    expect(guard.isEcho('sess-b', 'do the thing')).toBe(true);
    // Second identical line is genuine output, not the echo.
    expect(guard.isEcho('sess-b', 'do the thing')).toBe(false);
  });

  it('matches echoes wrapped in prompt decoration', () => {
    const guard = new InjectionGuard();
    guard.markInjected('sess-b', 'do the thing');
    expect(guard.isEcho('sess-b', '> do the thing')).toBe(true);
  });

  it('is scoped per session', () => {
    const guard = new InjectionGuard();
    guard.markInjected('sess-b', 'hello');
    expect(guard.isEcho('sess-a', 'hello')).toBe(false);
    expect(guard.isEcho('sess-b', 'hello')).toBe(true);
  });

  it('expires entries after the ttl', () => {
    let clock = 0;
    const guard = new InjectionGuard(1_000, () => clock);
    guard.markInjected('sess-b', 'stale');
    clock = 2_000;
    expect(guard.isEcho('sess-b', 'stale')).toBe(false);
  });

  it('clearSession drops all pending echoes for a dead session', () => {
    const guard = new InjectionGuard();
    guard.markInjected('sess-b', 'bye');
    guard.clearSession('sess-b');
    expect(guard.isEcho('sess-b', 'bye')).toBe(false);
  });
});

describe('sanitizeForInjection', () => {
  it('collapses newlines and strips control characters', () => {
    expect(sanitizeForInjection('a\r\nb\x1b[31mc\x07')).toBe('a b[31mc');
  });

  it('trims surrounding whitespace', () => {
    expect(sanitizeForInjection('  hi  ')).toBe('hi');
  });
});
