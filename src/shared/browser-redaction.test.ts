import { describe, expect, it } from 'vitest';
import { isSensitiveBrowserMarker } from './browser-redaction';

describe('isSensitiveBrowserMarker', () => {
  it('flags real sensitive markers', () => {
    expect(isSensitiveBrowserMarker('password')).toBe(true);
    expect(isSensitiveBrowserMarker('user-token-field')).toBe(true);
    expect(isSensitiveBrowserMarker('otp-input')).toBe(true);
    expect(isSensitiveBrowserMarker('session_id')).toBe(true);
    expect(isSensitiveBrowserMarker('mySession')).toBe(true);
  });

  it('does not flag unrelated words that merely contain the substring', () => {
    // MediaWiki tags every article body with `rootpage-<Title>` — "otp" is
    // embedded inside "rootpage", not a standalone token.
    expect(isSensitiveBrowserMarker('rootpage-Brasil')).toBe(false);
    expect(isSensitiveBrowserMarker('mw-jump-link')).toBe(false);
    // "session" embedded inside an unrelated doubled-s word.
    expect(isSensitiveBrowserMarker('possession-count')).toBe(false);
  });
});
