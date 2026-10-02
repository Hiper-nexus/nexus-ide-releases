import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReleases, validateCatalog } from './releases.js';
const base='https://github.com/Hiper-nexus/nexus-ide-releases/releases';
function release(version,platform='win32-x64-Setup.exe',extra={}){return {tag_name:`v${version}`,draft:false,prerelease:false,published_at:'2026-09-30T10:00:00Z',html_url:`${base}/tag/v${version}`,assets:[{name:`NexusIDE-${version}-${platform}`,size:100,browser_download_url:`${base}/download/v${version}/NexusIDE-${version}-${platform}`}],...extra};}
test('selects newest published installer per OS using semantic versions',()=>{
  const result=normalizeReleases([release('0.9.0'),release('0.10.0'),release('0.8.0','arm64.dmg')]);
  assert.equal(result.windows[0].version,'0.10.0');assert.equal(result.macos[0].version,'0.8.0');
});
test('drafts, prereleases and releases without publication dates are excluded',()=>{
  const result=normalizeReleases([release('2.0.0','arm64.dmg',{draft:true}),release('3.0.0','arm64.dmg',{prerelease:true}),release('4.0.0','arm64.dmg',{published_at:null}),release('1.0.0','arm64.dmg')]);
  assert.deepEqual(result.macos.map(r=>r.version),['1.0.0']);
});
test('external and executable-script URLs are never used as download links',()=>{
  for(const url of ['javascript:alert(1)','https://github.com.evil.test/Hiper-nexus/nexus-ide-releases/releases/download/v1/a.exe','https://github.com/other/repo/releases/download/v1/a.exe']){
    const item=release('1.0.0');item.assets[0].browser_download_url=url;assert.equal(normalizeReleases([item]).windows.length,0);
  }
});
test('does not mistake release metadata or update packages for installers',()=>{
  assert.equal(normalizeReleases([release('1.0.0','full.nupkg'),release('2.0.0','RELEASES')]).windows.length,0);
});
test('keeps three latest Windows releases available with release-note links',()=>{
  const result=normalizeReleases(['1.0.0','1.0.3','1.0.2','1.0.1'].map(v=>release(v)));
  assert.deepEqual(result.windows.map(r=>r.version),['1.0.3','1.0.2','1.0.1']);assert.match(result.windows[0].releaseUrl,/\/tag\/v1.0.3$/);
});

// ---- Linux x64: DEB + RPM + ZIP, os três ou nada ----
const linuxNames = v => [`nexus-ide_${v}_amd64.deb`, `nexus-ide-${v}-1.x86_64.rpm`, `NexusIDE-linux-x64-${v}.zip`];
function linuxRelease(version, names = linuxNames(version), extra = {}) {
  return { tag_name: `v${version}`, draft: false, prerelease: false, published_at: '2026-10-02T12:00:00Z', html_url: `${base}/tag/v${version}`,
    assets: names.map(name => ({ name, size: 100, browser_download_url: `${base}/download/v${version}/${name}` })), ...extra };
}
test('o Linux só entra com DEB, RPM e ZIP juntos (upload pela metade não vira download)', () => {
  assert.equal(normalizeReleases([linuxRelease('1.0.0', linuxNames('1.0.0').slice(0, 2))]).linux.length, 0);
  assert.equal(normalizeReleases([linuxRelease('1.0.0', [])]).linux.length, 0);
  const [row] = normalizeReleases([linuxRelease('1.0.0')]).linux;
  assert.equal(row.version, '1.0.0'); assert.equal(row.architecture, 'x64');
  assert.deepEqual(row.files.map(file => file.format), ['deb', 'rpm', 'zip']);
  assert.match(row.files[0].url, /\/nexus-ide_1\.0\.0_amd64\.deb$/);
  assert.equal(row.checksums, undefined);
});
test('o Linux nomeia o arquivo pela versão da release: pacote de outra versão não vale', () => {
  assert.equal(normalizeReleases([linuxRelease('1.0.0', linuxNames('0.9.0'))]).linux.length, 0);
});
test('a soma SHA-256 do Linux entra quando existe, e só do repositório público', () => {
  const withSums = linuxRelease('1.0.0', [...linuxNames('1.0.0'), 'SHA256SUMS-linux-x64.txt']);
  assert.match(normalizeReleases([withSums]).linux[0].checksums.url, /SHA256SUMS-linux-x64\.txt$/);
  const evil = linuxRelease('1.0.0', [...linuxNames('1.0.0'), 'SHA256SUMS-linux-x64.txt']);
  evil.assets.at(-1).browser_download_url = 'https://evil.example/SHA256SUMS-linux-x64.txt';
  assert.equal(normalizeReleases([evil]).linux[0].checksums, undefined);
});
test('URL de fora ou rascunho nunca vira link de Linux', () => {
  const external = linuxRelease('1.0.0'); external.assets[1].browser_download_url = 'https://github.com/other/repo/releases/download/v1.0.0/nexus-ide-1.0.0-1.x86_64.rpm';
  assert.equal(normalizeReleases([external]).linux.length, 0);
  assert.equal(normalizeReleases([linuxRelease('1.0.0', undefined, { draft: true }), linuxRelease('1.0.1', undefined, { prerelease: true })]).linux.length, 0);
});
test('o Linux sai na mesma release do Mac e do Windows sem atrapalhá-los, e a validação do cache o preserva', () => {
  const all = release('1.0.0', 'arm64.dmg'); all.assets.push(...linuxRelease('1.0.0').assets);
  const catalog = normalizeReleases([all]);
  assert.equal(catalog.macos.length, 1); assert.equal(catalog.linux.length, 1);
  const again = validateCatalog(JSON.parse(JSON.stringify(catalog)));
  assert.deepEqual(again, catalog);
  assert.deepEqual(validateCatalog({ macos: [], windows: [] }).linux, []);
});
