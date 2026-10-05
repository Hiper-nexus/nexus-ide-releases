import test from 'node:test';
import assert from 'node:assert/strict';
import { repoAsset, repoRedirectResponse } from './repo.js';

const REPO = 'https://github.com/Hiper-nexus/nexus-ide-releases/releases';
const deb = v => `nexus-ide_${v}_amd64.deb`;
const rpm = v => `nexus-ide-${v}-1.x86_64.rpm`;
const zip = v => `NexusIDE-linux-x64-${v}.zip`;
function release(version, files) {
  return { tag_name: `v${version}`, draft: false, prerelease: false, published_at: '2026-10-05T12:00:00Z', html_url: `${REPO}/tag/v${version}`,
    assets: files.map(name => ({ name, size: 1000, browser_download_url: `${REPO}/download/v${version}/${name}` })) };
}
const MAC = release('0.76.197', ['NexusIDE-0.76.197-arm64.dmg', 'NexusIDE-darwin-arm64-0.76.197.zip']);
const LINUX_200 = release('0.76.200', [deb('0.76.200'), rpm('0.76.200'), zip('0.76.200'), 'Packages', 'InRelease']);
const LINUX_199 = release('0.76.199', [deb('0.76.199'), rpm('0.76.199'), zip('0.76.199')]);
const deps = (releases) => ({ cache: null, fetcher: async () => Response.json(releases) });

const SHA = 'a'.repeat(64);

test('repoAsset aceita só nomes conhecidos do apt', () => {
  for (const name of ['InRelease', 'Release', 'Release.gpg', 'Packages', 'Packages.gz']) assert.deepEqual(repoAsset('apt', name), { name, version: null });
  assert.deepEqual(repoAsset('apt', deb('0.76.200')), { name: deb('0.76.200'), version: '0.76.200' });
  for (const bad of ['', 'Packages.xz', 'packages', 'evil.deb', '../InRelease', 'a/InRelease', 'nexus-ide_1.2_amd64.deb', 'nexus-ide_1.2.3_arm64.deb', 'InRelease\n', 'Release.gpg/', `${deb('0.76.200')}.sig`]) {
    assert.equal(repoAsset('apt', bad), null, JSON.stringify(bad));
  }
});

test('repoAsset do rpm leva repodata/x para o asset rpm-repodata-x e confere o nome do hash', () => {
  assert.deepEqual(repoAsset('rpm', 'repodata/repomd.xml'), { name: 'rpm-repodata-repomd.xml', version: null });
  assert.deepEqual(repoAsset('rpm', 'repodata/repomd.xml.asc'), { name: 'rpm-repodata-repomd.xml.asc', version: null });
  assert.deepEqual(repoAsset('rpm', `repodata/${SHA}-primary.xml.gz`), { name: `rpm-repodata-${SHA}-primary.xml.gz`, version: null });
  assert.deepEqual(repoAsset('rpm', `repodata/${SHA}-filelists.xml.zst`), { name: `rpm-repodata-${SHA}-filelists.xml.zst`, version: null });
  assert.deepEqual(repoAsset('rpm', rpm('0.76.200')), { name: rpm('0.76.200'), version: '0.76.200' });
  for (const bad of ['repodata/', 'repodata/evil', `repodata/${SHA}-primary.sqlite.bz2`, 'repodata/../repomd.xml', 'repodata/a/b', `repodata/${'g'.repeat(64)}-primary.xml.gz`, 'nexus-ide-1.2.3-2.x86_64.rpm', 'x.rpm']) {
    assert.equal(repoAsset('rpm', bad), null, bad);
  }
  assert.equal(repoAsset('outro', 'InRelease'), null);
  assert.equal(repoAsset('apt', 'a'.repeat(200)), null);
  assert.equal(repoAsset('apt', undefined), null);
});

test('redireciona o índice e o pacote para a release Linux mais nova, nunca para a do Mac', async () => {
  const d = deps([MAC, LINUX_199, LINUX_200]);
  const index = await repoRedirectResponse('apt', 'InRelease', d);
  assert.equal(index.status, 302);
  assert.equal(index.headers.get('location'), `${REPO}/download/v0.76.200/InRelease`);
  assert.equal(index.headers.get('x-nexus-version'), '0.76.200');
  const pkg = await repoRedirectResponse('apt', deb('0.76.200'), d);
  assert.equal(pkg.headers.get('location'), `${REPO}/download/v0.76.200/${deb('0.76.200')}`);
  const meta = await repoRedirectResponse('rpm', `repodata/${SHA}-primary.xml.gz`, d);
  assert.equal(meta.headers.get('location'), `${REPO}/download/v0.76.200/rpm-repodata-${SHA}-primary.xml.gz`);
  const rpmFile = await repoRedirectResponse('rpm', rpm('0.76.200'), d);
  assert.equal(rpmFile.headers.get('location'), `${REPO}/download/v0.76.200/${rpm('0.76.200')}`);
});

test('pacote de versão que não é a mais nova dá 404 (o índice só anuncia a mais nova)', async () => {
  const d = deps([LINUX_199, LINUX_200]);
  assert.equal((await repoRedirectResponse('apt', deb('0.76.199'), d)).status, 404);
  assert.equal((await repoRedirectResponse('rpm', rpm('0.76.199'), d)).status, 404);
});

test('sem release Linux completa (3 pacotes) ou com nome inválido: 404, sem redirecionar', async () => {
  const half = release('0.76.201', [deb('0.76.201')]);
  assert.equal((await repoRedirectResponse('apt', 'InRelease', deps([MAC, half]))).status, 404);
  assert.equal((await repoRedirectResponse('apt', '../etc/passwd', deps([MAC, LINUX_200]))).status, 404);
});

test('com o GitHub fora do ar o repositório segue pelo último catálogo conhecido (o snapshot embutido)', async () => {
  const response = await repoRedirectResponse('apt', 'InRelease', { cache: null, fetcher: async () => { throw new Error('offline'); } });
  assert.equal(response.status, 302);
  assert.match(response.headers.get('location'), /^https:\/\/github\.com\/Hiper-nexus\/nexus-ide-releases\/releases\/download\/v\d+\.\d+\.\d+\/InRelease$/u);
});
