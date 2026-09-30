export const RELEASE_REPOSITORY = 'https://github.com/Hiper-nexus/nexus-ide-releases';
const HISTORY_LIMIT = 3;
const VERSION = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function versionOf(tag) {
  const match = typeof tag === 'string' && tag.match(VERSION);
  return match ? match.slice(1).join('.') : null;
}

function safeReleaseUrl(value, kind, tag) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    const path = `/Hiper-nexus/nexus-ide-releases/releases/${kind}/${tag}`;
    return url.origin === 'https://github.com' && !url.username && !url.password && !url.search && !url.hash
      && (kind === 'tag' ? url.pathname === path : url.pathname.startsWith(path + '/') && url.pathname.slice(path.length + 1).length > 0);
  } catch { return false; }
}

function newestFirst(a, b) {
  const left = a.version.split('.').map(Number), right = b.version.split('.').map(Number);
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return right[index] - left[index];
  return 0;
}

export function normalizeReleases(releases) {
  const catalog = { macos: [], windows: [] };
  if (!Array.isArray(releases)) return catalog;
  for (const release of releases) {
    const version = versionOf(release?.tag_name);
    if (!version || release.draft !== false || release.prerelease !== false
      || typeof release.published_at !== 'string' || !Number.isFinite(Date.parse(release.published_at))
      || !safeReleaseUrl(release.html_url, 'tag', release.tag_name) || !Array.isArray(release.assets)) continue;
    const targets = [
      ['macos', 'arm64', `NexusIDE-${version}-arm64.dmg`],
      ['windows', 'x64', `NexusIDE-${version}-win32-x64-Setup.exe`],
    ];
    for (const [os, architecture, name] of targets) {
      const asset = release.assets.find(item => item?.name === name && Number.isFinite(item.size) && item.size > 0
        && safeReleaseUrl(item.browser_download_url, 'download', release.tag_name)
        && new URL(item.browser_download_url).pathname.endsWith('/' + name));
      if (asset) catalog[os].push({ version, architecture, name, size: asset.size, url: asset.browser_download_url, releaseUrl: release.html_url, publishedAt: release.published_at });
    }
  }
  return Object.fromEntries(Object.entries(catalog).map(([os, rows]) => [os, rows.sort(newestFirst).filter((item, index, all) => all.findIndex(row => row.version === item.version) === index).slice(0, HISTORY_LIMIT)]));
}

export function validateCatalog(catalog) {
  const releases = ['macos', 'windows'].flatMap(os => Array.isArray(catalog?.[os]) ? catalog[os].map(row => ({
    tag_name: `v${row?.version}`, draft: false, prerelease: false, published_at: row?.publishedAt, html_url: row?.releaseUrl,
    assets: [{ name: row?.name, size: row?.size, browser_download_url: row?.url }],
  })) : []);
  return normalizeReleases(releases);
}
