import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReleases } from './releases.js';
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
