import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeDownloadConversion, isNexusDownload } from './download-conversion.js';

const BASE = 'https://nexuside.app/';
// Rótulo sintético restrito ao mock; não é importado pelo produto.
const MOCK_SEND_TO = 'AW-953176375/TEST_ONLY_NOT_A_REAL_LABEL';

test('somente instaladores oficiais do NexusIDE e rotas de download são elegíveis', () => {
  for (const href of ['/download/macos', '/download/windows', '/download/linux-deb', 'https://github.com/Hiper-nexus/nexus-ide-releases/releases/download/v0.76.359/NexusIDE-0.76.359-win32-x64-Setup.exe', 'https://github.com/Hiper-nexus/nexus-ide-releases/releases/download/v0.76.358/NexusIDE-0.76.358-arm64.dmg', 'https://github.com/Hiper-nexus/nexus-ide-releases/releases/download/v0.76.359/nexus-ide_0.76.359_amd64.deb']) assert.equal(isNexusDownload(href, BASE), true, href);
  for (const href of ['#download', '/conta/', '/download/windows?email=private@example.test', 'https://evil.test/download/windows', 'https://github.com/Hiper-nexus/nexus-shot-releases/releases/download/v0.1.15/Nexus.Shot_0.1.15_aarch64.dmg', 'https://github.com/Hiper-nexus/nexus-ide-releases/releases/download/v0.76.359/SHA256SUMS-linux-x64.txt', 'https://github.com/Hiper-nexus/nexus-ide-releases/releases/tag/v0.76.359', 'javascript:alert(1)']) assert.equal(isNexusDownload(href, BASE), false, href);
});

test('handler usa mock, exige consentimento e clique real; não cancela navegação nem envia dados pessoais', () => {
  const calls = [], listeners = [];
  let allowed = false;
  const win = { location: { href: BASE }, gtag: (...args) => calls.push(args) };
  const doc = { addEventListener: (name, fn) => { assert.equal(name, 'click'); listeners.push(fn); } };
  const options = { win, doc, sendTo: MOCK_SEND_TO, canMeasure: () => allowed };
  initializeDownloadConversion(options); initializeDownloadConversion(options);
  assert.equal(listeners.length, 1);
  const event = { isTrusted: true, defaultPrevented: false, target: { closest: () => ({ href: BASE + 'download/windows' }) }, preventDefault: () => assert.fail('download não pode ser bloqueado') };
  listeners[0](event);
  assert.equal(calls.length, 0);
  allowed = true;
  listeners[0]({ ...event, isTrusted: false });
  listeners[0]({ ...event, defaultPrevented: true });
  assert.equal(calls.length, 0);
  listeners[0](event);
  assert.deepEqual(calls, [['event', 'conversion', { send_to: MOCK_SEND_TO, transport_type: 'beacon' }]]);
  allowed = false; listeners[0](event);
  assert.equal(calls.length, 1);
});

test('sem label dedicado ou conta incorreta, não há instrumentação', () => {
  for (const sendTo of [undefined, null, '', 'AW-1/OTHER_PRODUCT']) {
    initializeDownloadConversion({ win: {}, doc: { addEventListener: () => assert.fail('sem label validado') }, sendTo, canMeasure: () => true });
  }
});
