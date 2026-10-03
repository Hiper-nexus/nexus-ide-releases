import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetSessionWebExposureForTests,
  isSessionWebExposed,
  markSessionWebExposed,
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

});
