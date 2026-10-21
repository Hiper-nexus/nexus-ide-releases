import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeAdsConsent, CONSENT_KEY, GOOGLE_ADS_ID } from './ads-consent.js';

function fixture({ saved = null, path = '/', host = 'nexuside.app', protocol = 'https:', search = '', existingTag = false, writeFails = false, referrer = '' } = {}) {
  const nodes = Object.fromEntries(['ads-consent', 'ads-preferences', 'ads-accept', 'ads-reject'].map(id => [id, {
    hidden: true, listeners: {}, focused: false,
    addEventListener(name, fn) { this.listeners[name] = fn; },
    focus() { this.focused = true; },
    click() { this.listeners.click(); },
  }]));
  const scripts = [], events = {};
  let value = saved, reloads = 0, replaced = null;
  const win = {
    location: { hostname: host, protocol, pathname: path, search, reload() { reloads++; }, replace(url) { replaced = url; } },
    localStorage: {
      getItem(key) { assert.equal(key, CONSENT_KEY); return value; },
      setItem(key, next) { assert.equal(key, CONSENT_KEY); if (writeFails) throw new Error('blocked'); value = next; },
    },
    addEventListener(name, fn) { events[name] = fn; },
  };
  const doc = {
    referrer,
    getElementById: id => nodes[id],
    querySelector: () => existingTag || scripts[0] || null,
    createElement: name => { assert.equal(name, 'script'); return {}; },
    head: { append: script => scripts.push(script) },
  };
  const init = () => initializeAdsConsent(win, doc);
  return { win, nodes, scripts, events, init, saved: () => JSON.parse(value), reloads: () => reloads, replaced: () => replaced };
}
const savedChoice = (choice, expiresAt = Date.now() + 100000) => JSON.stringify({ choice, expiresAt });
const commands = f => (f.win.dataLayer || []).map(args => [...args]);

test('primeira visita, recusa, dados inválidos ou escolha expirada não carregam Google nem enfileiram pings', () => {
  for (const saved of [null, savedChoice('denied'), '{bad json', savedChoice('granted', 0), savedChoice('unknown')]) {
    const f = fixture({ saved }); f.init();
    assert.equal(f.scripts.length, 0);
    assert.equal(f.win.dataLayer, undefined);
    assert.equal(f.win.gtag, undefined);
    f.nodes['ads-reject'].click();
    assert.equal(f.saved().choice, 'denied');
    assert.equal(f.scripts.length, 0);
    assert.equal(f.reloads(), 0);
  }
});

test('aceite carrega uma única tag validada, com consentimento primeiro e sem conversões ou dados da URL', () => {
  const f = fixture({ search: '?email=private@example.test&gclid=test#secret' }); f.init();
  assert.equal(f.nodes['ads-consent'].hidden, false);
  f.nodes['ads-accept'].click();
  assert.equal(f.scripts[0].src, `https://www.googletagmanager.com/gtag/js?id=${GOOGLE_ADS_ID}`);
  const rows = commands(f);
  assert.equal(rows[0][0], 'consent');
  assert.equal(rows[0][1], 'default');
  assert.deepEqual(Object.values(rows[0][2]), ['denied', 'denied', 'denied', 'denied']);
  assert.equal(rows[1][2].ad_storage, 'granted');
  assert.equal(rows[1][2].ad_user_data, 'denied');
  assert.equal(rows[1][2].ad_personalization, 'denied');
  assert.equal(f.win['ga-disable-G-VJFB612907'], true);
  const jsIndex = rows.findIndex(row => row[0] === 'js');
  assert.ok(rows.findIndex(row => row[0] === 'set' && row[1] === 'user_data' && row[2] === null) < jsIndex);
  assert.ok(rows.findIndex(row => row[0] === 'set' && row[1] === 'allow_enhanced_conversions' && row[2] === false) < jsIndex);
  const config = rows.find(row => row[0] === 'config');
  assert.equal(config[1], GOOGLE_ADS_ID);
  assert.equal(config[2].allow_enhanced_conversions, false);
  assert.equal(config[2].page_location, 'https://nexuside.app/');
  assert.equal(config[2].page_referrer, 'https://nexuside.app/');
  assert.equal(JSON.stringify(rows).includes('private@example'), false);
  assert.equal(rows.some(row => row[0] === 'event'), false);
  f.init(); f.nodes['ads-preferences'].click(); f.nodes['ads-accept'].click();
  assert.equal(f.scripts.length, 1);
  assert.equal(commands(f).filter(row => row[0] === 'config').length, 1);
});

test('escolha válida é respeitada e expira em 180 dias', () => {
  const f = fixture({ saved: savedChoice('granted') }); f.init();
  assert.equal(f.scripts.length, 1);
  assert.equal(f.nodes['ads-consent'].hidden, true);
  f.nodes['ads-preferences'].click();
  assert.equal(f.nodes['ads-consent'].hidden, false);
  f.nodes['ads-accept'].click();
  assert.ok(Math.abs(f.saved().expiresAt - Date.now() - 180 * 86400000) < 1000);
});

test('revogar persiste recusa e recarrega sem enviar atualização ou conversão', () => {
  const f = fixture({ saved: savedChoice('granted') }); const controller = f.init();
  const count = commands(f).length;
  controller.revoke();
  assert.equal(f.saved().choice, 'denied');
  assert.equal(f.reloads(), 1);
  assert.equal(commands(f).length, count);
  const next = fixture({ saved: savedChoice('denied') }); next.init();
  assert.equal(next.scripts.length, 0);
});

test('revogação falha fechada mesmo quando localStorage recusa escrita', () => {
  const f = fixture({ saved: savedChoice('granted'), writeFails: true }); f.init().revoke();
  assert.equal(f.replaced(), 'https://nexuside.app/?privacy=denied');
  const next = fixture({ saved: savedChoice('granted'), search: '?privacy=denied' }); next.init();
  assert.equal(next.scripts.length, 0);
});

test('não carrega tag na conta, admin, comunidade, preview ou HTTP', () => {
  for (const options of [{ path: '/conta/' }, { path: '/admin/' }, { path: '/comunidade/' }, { host: 'comunidade.nexuside.app' }, { host: 'preview.workers.dev' }, { protocol: 'http:' }]) {
    const f = fixture({ ...options, saved: savedChoice('granted') }); f.init();
    assert.equal(f.scripts.length, 0);
    assert.equal(f.win.dataLayer, undefined);
  }
});

test('reutiliza loader existente e respeita mudança de consentimento em outra aba', () => {
  const f = fixture({ saved: savedChoice('granted'), existingTag: true }); f.init();
  assert.equal(f.scripts.length, 0);
  f.events.storage({ key: 'unrelated' });
  assert.equal(f.reloads(), 0);
  f.events.storage({ key: CONSENT_KEY });
  assert.equal(f.reloads(), 1);
});


test('origem com parâmetros ou fragmento potencialmente privado bloqueia o loader mesmo após aceite', () => {
  for (const referrer of ['https://nexuside.app/conta/?email=private@example.test', 'https://example.test/#secret']) {
    const f = fixture({ referrer }); f.init(); f.nodes['ads-accept'].click();
    assert.equal(f.scripts.length, 0);
    assert.equal(f.win.dataLayer, undefined);
  }
});
