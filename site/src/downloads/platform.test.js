import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPlatform, recommendDownload } from './platform.js';

const catalog={macos:[{version:'1.0.0',architecture:'arm64',url:'mac.dmg'}],windows:[{version:'1.0.1',architecture:'x64',url:'windows.exe'}]};
test('Windows x64 recommends its installer',()=>{
  const device=detectPlatform({userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'});
  assert.equal(device.os,'windows');assert.equal(recommendDownload(device,catalog).url,'windows.exe');
});
test('Apple Silicon recommends the ARM Mac installer',()=>{
  const device=detectPlatform({platform:'macOS',architecture:'arm',bitness:'64'});
  assert.equal(recommendDownload(device,catalog).url,'mac.dmg');
});
test('MacIntel platform string alone does not prove an Intel CPU',()=>{
  const device=detectPlatform({platform:'MacIntel',userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'});
  assert.equal(device.architecture,'unknown');assert.equal(recommendDownload(device,catalog).url,'#download');
});
test('known Intel Mac is not sent to an Apple Silicon installer',()=>{
  assert.equal(recommendDownload(detectPlatform({platform:'macOS',architecture:'x86',bitness:'64'}),catalog).url,'#download');
});
test('iPad desktop mode does not receive a Mac recommendation',()=>{
  const device=detectPlatform({platform:'MacIntel',maxTouchPoints:5,userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'});
  assert.equal(device.os,'mobile');assert.equal(recommendDownload(device,catalog).url,'#download');
});
test('Android and Linux retain manual download choices',()=>{
  for(const userAgent of ['Mozilla/5.0 (Linux; Android 15)','Mozilla/5.0 (X11; Linux x86_64)'])assert.equal(recommendDownload(detectPlatform({userAgent}),catalog).url,'#download');
});
test('Windows ARM and 32-bit devices are not promised x64 compatibility',()=>{
  for(const info of [{platform:'Windows',architecture:'arm',bitness:'64'},{platform:'Windows',architecture:'x86',bitness:'32'}])assert.equal(recommendDownload(detectPlatform(info),catalog).url,'#download');
});

test('Linux x64 é reconhecido e continua com escolha manual do pacote (a distribuição decide DEB, RPM ou ZIP)', () => {
  const device = detectPlatform({ platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' });
  assert.deepEqual(device, { os: 'linux', architecture: 'x64' });
  assert.equal(recommendDownload(device, catalog).url, '#download');
});
test('Linux ARM é reconhecido como ARM e não recebe promessa de pacote x64', () => {
  const device = detectPlatform({ platform: 'Linux aarch64', userAgent: 'Mozilla/5.0 (X11; Linux aarch64)' });
  assert.deepEqual(device, { os: 'linux', architecture: 'arm64' });
  assert.equal(recommendDownload(device, catalog).url, '#download');
});
