/** Packaged credentials only go to the official origin. Overrides are development-only. */
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
  packaged: boolean = isPackaged(),
): string {
  if (packaged) return DEFAULT_BACKEND_URL;
  if (envValue && isAcceptableBackendUrl(envValue)) return envValue;
  if (envValue) {
    console.warn(
      '[backend-url] ignoring insecure NEXUS_BACKEND_URL; using HTTPS default',
    );
  }
  return DEFAULT_BACKEND_URL;
}

function isPackaged(): boolean {
  try { return (require('electron') as typeof import('electron')).app?.isPackaged ?? false; }
  catch { return false; }
}
