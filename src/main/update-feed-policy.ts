import { isTrustedGithubReleasePath } from './update-repos';

const TRUSTED_UPDATE_HOSTS = new Set([
  'nexuside.app',
  'api.nexuside.app',
]);
const GITHUB_UPDATE_HOST = 'github.com';
const ELECTRON_UPDATE_HOST = 'update.electronjs.org';
const WINDOWS_UPDATE_PATH =
  /^\/Hiper-nexus\/nexus-ide-releases\/win32-x64\/(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;

/** Packaged updates execute code; accept only pinned HTTPS product origins. */
export function validateUpdateFeedUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    const isTrustedNexusHost = TRUSTED_UPDATE_HOSTS.has(hostname);
    const isTrustedGithubRelease =
      hostname === GITHUB_UPDATE_HOST &&
      isTrustedGithubReleasePath(url.pathname);
    const isOfficialWindowsFeed =
      hostname === ELECTRON_UPDATE_HOST &&
      WINDOWS_UPDATE_PATH.test(url.pathname) &&
      url.search === '';
    if (
      url.protocol !== 'https:' ||
      (url.port !== '' && url.port !== '443') ||
      url.username ||
      url.password ||
      url.hash ||
      (!isTrustedNexusHost && !isTrustedGithubRelease && !isOfficialWindowsFeed)
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}
