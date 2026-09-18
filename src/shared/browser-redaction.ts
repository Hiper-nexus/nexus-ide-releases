import { redactVisibleSecrets } from './vision-ipc';

/**
 * Redaction helpers shared by the isolated browser preload and the main
 * process. The agent never receives raw page text or URLs: both sides apply
 * the same masking so post-action `after` snapshots look exactly like the
 * page-side `read` output.
 */

const SENSITIVE_MARKER =
  /(?:password|passwd|secret|token|api[_ -]?key|access[_ -]?key|private[_ -]?key|authorization|credential|one[_ -]?time|otp|cookie|session)/i;

export function isSensitiveBrowserMarker(value: string): boolean {
  return SENSITIVE_MARKER.test(value);
}

export function redactBrowserText(value: string): string {
  return redactVisibleSecrets(value);
}

export function redactPageUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    const keys = [...new Set([...url.searchParams.keys()])];
    url.search = '';
    keys.slice(0, 32).forEach((key) => {
      url.searchParams.append(key, SENSITIVE_MARKER.test(key) ? '[REDACTED]' : '');
    });
    if (
      url.hash.length > 129 ||
      SENSITIVE_MARKER.test(url.hash) ||
      !/^#[#/a-z0-9._-]*$/i.test(url.hash)
    ) {
      url.hash = url.hash ? '#[REDACTED]' : '';
    }
    // Query values and hash are handled above; the PATH can still carry a
    // secret (magic-link / reset / share token), so redact just the pathname
    // (leaving the already-encoded query values intact).
    url.pathname = redactVisibleSecrets(url.pathname);
    return url.toString();
  } catch {
    return '[invalid URL]';
  }
}
