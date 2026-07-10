const TRUSTED_UPDATE_HOSTS = new Set([
  'nexuside.app',
  'api.nexuside.app',
]);
const GITHUB_UPDATE_HOST = 'github.com';
const GITHUB_RELEASE_PREFIX = '/cleofasvolarehost/nexus-ide/releases/';

/** Packaged updates execute code; accept only pinned HTTPS product origins. */
export function validateUpdateFeedUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    const isTrustedNexusHost = TRUSTED_UPDATE_HOSTS.has(hostname);
    const isTrustedGithubRelease =
      hostname === GITHUB_UPDATE_HOST &&
      url.pathname.toLowerCase().startsWith(GITHUB_RELEASE_PREFIX);
    if (
      url.protocol !== 'https:' ||
      (url.port !== '' && url.port !== '443') ||
      url.username ||
      url.password ||
      url.hash ||
      (!isTrustedNexusHost && !isTrustedGithubRelease)
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}
