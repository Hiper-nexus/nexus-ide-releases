import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  REMOTE_CLIENT_HTML,
  REMOTE_CLIENT_ICON_SVG,
  REMOTE_CLIENT_MANIFEST,
  REMOTE_CLIENT_SERVICE_WORKER,
} from './remote-client-page';

/**
 * Serve only the static PWA shell. Authentication and operational state stay
 * on the WebSocket; no HTTP route reads project stores or device credentials.
 */
export function serveRemoteClientPage(
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const pathname = new URL(req.url ?? '/', 'https://nexus.local').pathname;
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy':
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
        "connect-src wss: 'self'; img-src 'self'; manifest-src 'self'; " +
        "worker-src 'self'; base-uri 'none'; form-action 'none'; " +
        "frame-ancestors 'none'",
    });
    res.end(REMOTE_CLIENT_HTML);
    return;
  }
  if (req.method === 'GET' && pathname === '/manifest.webmanifest') {
    res.writeHead(200, {
      'Content-Type': 'application/manifest+json; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(REMOTE_CLIENT_MANIFEST);
    return;
  }
  if (req.method === 'GET' && pathname === '/sw.js') {
    res.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Service-Worker-Allowed': '/',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(REMOTE_CLIENT_SERVICE_WORKER);
    return;
  }
  if (req.method === 'GET' && pathname === '/icon.svg') {
    res.writeHead(200, {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
    });
    res.end(REMOTE_CLIENT_ICON_SVG);
    return;
  }
  res.writeHead(404, {
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end('not found');
}
