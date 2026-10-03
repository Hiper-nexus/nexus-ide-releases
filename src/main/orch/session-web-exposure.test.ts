import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetSessionWebExposureForTests,
  isSessionWebExposed,
  markSessionWebExposed,
  noteSessionToolCall,
} from './session-web-exposure';

beforeEach(__resetSessionWebExposureForTests);

describe('session web exposure', () => {
  it('retains exposure when the bounded registry fills instead of trusting the oldest live session', () => {
    markSessionWebExposed('old-live-session');
    for (let i = 0; i < 4_096; i++) markSessionWebExposed(`session-${i}`);
    expect(isSessionWebExposed('old-live-session')).toBe(true);
    expect(isSessionWebExposed('session-4095')).toBe(true);
  });

  it('treats uncertain exposure after overflow conservatively', () => {
    for (let i = 0; i < 4_097; i++) markSessionWebExposed(`session-${i}`);
    expect(isSessionWebExposed('new-session-without-evidence')).toBe(true);
    expect(isSessionWebExposed(null)).toBe(false);
  });

  it('classifies shell HTTP from its trusted observer kind, without classifying local shell as web', () => {
    expect(noteSessionToolCall('http', 'Bash', 'shell-http')).toBe(true);
    expect(isSessionWebExposed('http')).toBe(true);
    expect(noteSessionToolCall('local', 'Bash', 'execute')).toBe(false);
    expect(isSessionWebExposed('local')).toBe(false);
    expect(noteSessionToolCall('fetch', 'WebFetch', 'read')).toBe(true);
  });
});
