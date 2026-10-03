import { stripAnsi } from '../../shared/ansi-text';

/**
 * Passive dev-server URL detection over PTY output (VISUAL-EDIT-001, F1.5).
 * Recognizes the URLs dev servers print at boot (Vite "Local:", Next "url:",
 * CRA/webpack "Local:", generic "Listening on …") by matching local/private
 * hosts only — public URLs in the output (docs links) are never dev servers.
 * Pure text → text so every framework banner is testable without a PTY.
 */

const LOCAL_URL_PATTERN = new RegExp(
  'https?://' +
    '(?:localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1?\\]|' +
    '192\\.168\\.\\d{1,3}\\.\\d{1,3}|10\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}|' +
    '172\\.(?:1[6-9]|2\\d|3[01])\\.\\d{1,3}\\.\\d{1,3})' +
    ':\\d{2,5}(?:/[^\\s"\'<>]*)?',
  'gi',
);

const TRAILING_PUNCTUATION = /(?<![.,;:!?)\]}>])[.,;:!?)\]}>]+$/;
const MAX_URLS_PER_CHUNK = 8;

function normalizeDevServerUrl(raw: string): string | null {
  const trimmed = raw.replace(TRAILING_PUNCTUATION, '');
  try {
    const url = new URL(trimmed);
    if (url.hostname === '0.0.0.0' || url.hostname === '[::]' || url.hostname === '::') {
      url.hostname = 'localhost';
    }
    // Preserve the printed shape (with/without trailing slash) — the URL bar
    // shows exactly what the dev server announced.
    return trimmed.replace(/^(https?:\/\/)(0\.0\.0\.0|\[::\])/i, `$1localhost`);
  } catch {
    return null;
  }
}

/** Extract normalized local dev-server URLs from a PTY output chunk. */
export function detectDevServerUrls(chunk: string): string[] {
  if (!chunk) return [];
  const text = stripAnsi(chunk);
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const match of text.matchAll(LOCAL_URL_PATTERN)) {
    const url = normalizeDevServerUrl(match[0]);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
    if (urls.length >= MAX_URLS_PER_CHUNK) break;
  }
  return urls;
}
