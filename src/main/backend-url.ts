/**
 * Resolve the backend base URL from NEXUS_BACKEND_URL (L6).
 *
 * The session bearer and OAuth codes are sent to this origin. If the env var is
 * set to a non-HTTPS URL (e.g. an attacker who can set env pointing at
 * http://attacker), those credentials would go out in cleartext. We therefore
 * accept only https:// (plus http://localhost for dev) and otherwise fall back
 * to the production default — fail safe rather than fail open.
 */
const DEFAULT_BACKEND_URL = 'https://api.nexuside.app';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function isAcceptableBackendUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  // Allow plain http only for loopback development endpoints.
  return url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname);
}

export function resolveBackendUrl(
  envValue: string | undefined = process.env.NEXUS_BACKEND_URL,
): string {
  if (envValue && isAcceptableBackendUrl(envValue)) return envValue;
  if (envValue) {
    console.warn(
      '[backend-url] ignoring insecure NEXUS_BACKEND_URL; using HTTPS default',
    );
  }
  return DEFAULT_BACKEND_URL;
}
