import { describe, expect, it } from 'vitest';
import { isSensitiveBrowserMarker, redactPageUrl } from './browser-redaction';

describe('isSensitiveBrowserMarker', () => {
  it.each([
    'password',
    'user-token-field',
    'otp-input',
    'otp_code',
    'session_id',
    'sessionid',
    'jsessionid',
    'mySession',
    'ssoOtp',
    'ssoOtpInput',
    'SSOOtp',
    'expressSession',
    'express-session',
    'express_session',
    'totp',
    'totpCode',
    'userOtp',
    'possessionToken',
    'mw-body sso-otp',
  ])('flags %s', (value) => {
    expect(isSensitiveBrowserMarker(value)).toBe(true);
  });

  it.each([
    // MediaWiki tags every article body with `rootpage-<Title>` — "otp" is
    // embedded inside "rootpage", not a standalone token.
    'rootpage-Brasil',
    'RootPage',
    'mw-jump-link',
    'possession-count',
    'skin-vector rootpage-Brasil page-Brasil',
  ])('does not flag %s', (value) => {
    expect(isSensitiveBrowserMarker(value)).toBe(false);
  });

  it('redacts camelCase OTP/session query keys in page URLs', () => {
    const url = redactPageUrl('https://example.test/?ssoOtp=123456&expressSession=abc');
    expect(url).toContain('ssoOtp=%5BREDACTED%5D');
    expect(url).toContain('expressSession=%5BREDACTED%5D');
  });
});
