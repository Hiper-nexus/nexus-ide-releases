import type { NextFunction, Request, Response } from 'express';

/**
 * Baseline emitted by the app itself so a deployment is not dependent on an
 * undocumented reverse-proxy policy. HSTS intentionally remains an edge
 * concern: enabling it (especially includeSubDomains) without owning the full
 * TLS topology can create a persistent outage.
 *
 * The server-rendered pages contain no scripts or forms and use one trusted
 * inline style block, so the policy can stay deliberately narrow.
 */
export function securityHeaders(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  );
  res.setHeader(
    'Content-Security-Policy',
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
  next();
}
