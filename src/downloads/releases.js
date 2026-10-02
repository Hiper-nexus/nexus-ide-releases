export const RELEASE_REPOSITORY = 'https://github.com/Hiper-nexus/nexus-ide-releases';
const HISTORY_LIMIT = 3;
const VERSION = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
// Nomes exatos que o canal Linux x64 publica (nexus-ide/scripts/publish-linux-release.mjs). O Linux só entra no
// catálogo com os TRÊS formatos: um upload pela metade não vira download.
const LINUX_FORMATS = [
  ['deb', version => `nexus-ide_${version}_amd64.deb`],
  ['rpm', version => `nexus-ide-${version}-1.x86_64.rpm`],
  ['zip', version => `NexusIDE-linux-x64-${version}.zip`],
];
const LINUX_CHECKSUMS = 'SHA256SUMS-linux-x64.txt';

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

function findAsset(release, name) {
  return release.assets.find(item => item?.name === name && Number.isFinite(item.size) && item.size > 0
    && safeReleaseUrl(item.browser_download_url, 'download', release.tag_name)
    && new URL(item.browser_download_url).pathname.endsWith('/' + name));
}

export function normalizeReleases(releases) {
  const catalog = { macos: [], windows: [], linux: [] };
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
      const asset = findAsset(release, name);
      if (asset) catalog[os].push({ version, architecture, name, size: asset.size, url: asset.browser_download_url, releaseUrl: release.html_url, publishedAt: release.published_at });
    }
    const files = LINUX_FORMATS.map(([format, nameOf]) => {
      const asset = findAsset(release, nameOf(version));
      return asset && { format, name: asset.name, size: asset.size, url: asset.browser_download_url };
    });
    if (files.every(Boolean)) {
      const sums = findAsset(release, LINUX_CHECKSUMS);
      catalog.linux.push({ version, architecture: 'x64', files, ...(sums ? { checksums: { size: sums.size, url: sums.browser_download_url } } : {}), releaseUrl: release.html_url, publishedAt: release.published_at });
    }
  }
  return Object.fromEntries(Object.entries(catalog).map(([os, rows]) => [os, rows.sort(newestFirst).filter((item, index, all) => all.findIndex(row => row.version === item.version) === index).slice(0, HISTORY_LIMIT)]));
}

export function validateCatalog(catalog) {
  const releases = ['macos', 'windows'].flatMap(os => Array.isArray(catalog?.[os]) ? catalog[os].map(row => ({
    tag_name: `v${row?.version}`, draft: false, prerelease: false, published_at: row?.publishedAt, html_url: row?.releaseUrl,
    assets: [{ name: row?.name, size: row?.size, browser_download_url: row?.url }],
  })) : []);
  // O Linux tem vários arquivos por versão: volta a ser uma release com um asset por arquivo, no mesmo crivo do GitHub.
  const linux = Array.isArray(catalog?.linux) ? catalog.linux.map(row => ({
    tag_name: `v${row?.version}`, draft: false, prerelease: false, published_at: row?.publishedAt, html_url: row?.releaseUrl,
    assets: [
      ...(Array.isArray(row?.files) ? row.files.map(file => ({ name: file?.name, size: file?.size, browser_download_url: file?.url })) : []),
      ...(row?.checksums ? [{ name: LINUX_CHECKSUMS, size: row.checksums.size, browser_download_url: row.checksums.url }] : []),
    ],
  })) : [];
  return normalizeReleases([...releases, ...linux]);
}
