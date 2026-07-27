import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from './index';

describe('server security headers', () => {
  it.each(['/health', '/billing/success', '/missing'])(
    'emits the same safe baseline for %s',
    async (route) => {
      const response = await request(createApp()).get(route);

      expect(response.headers['x-powered-by']).toBeUndefined();
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['x-frame-options']).toBe('DENY');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      expect(response.headers['permissions-policy']).toBe(
        'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
      );
      expect(response.headers['content-security-policy']).toBe(
        [
          "default-src 'none'",
          "script-src 'none'",
          "style-src 'unsafe-inline'",
          "img-src 'self' data:",
          "connect-src 'none'",
          "font-src 'none'",
          "object-src 'none'",
          "base-uri 'none'",
          "frame-ancestors 'none'",
          "form-action 'none'",
        ].join('; '),
      );
      expect(response.headers['strict-transport-security']).toBeUndefined();
    },
  );
});
