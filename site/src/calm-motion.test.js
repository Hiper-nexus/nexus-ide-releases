import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldCalm, applyCalmMotion, isCalmMotion, CALM_CLASS, MOTION_STORAGE_KEY } from './calm-motion.js';

const LINUX = { platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/152 Safari/537.36' };
const MAC = { platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605 Safari/605' };
const WIN = { platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/152' };
const ANDROID = { platform: 'Linux armv81', userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel) Chrome/152 Mobile' };
const CHROMEOS = { platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; CrOS x86_64 15000.0) Chrome/152' };

test('Linux desktop nasce calmo; Mac, Windows, Android e ChromeOS não', () => {
  assert.equal(shouldCalm(LINUX), true);
  assert.equal(shouldCalm(MAC), false);
  assert.equal(shouldCalm(WIN), false);
  assert.equal(shouldCalm(ANDROID), false);
  assert.equal(shouldCalm(CHROMEOS), false);
});

test('"Reduzir movimento" sempre acalma, mesmo com a escolha total salva', () => {
  assert.equal(shouldCalm({ ...MAC, reducedMotion: true }), true);
  assert.equal(shouldCalm({ ...LINUX, reducedMotion: true, stored: 'total' }), true);
  assert.equal(shouldCalm({ ...LINUX, reducedMotion: true, search: '?movimento=total' }), true);
});

test('o pedido na URL vence a escolha salva e o sistema', () => {
  assert.equal(shouldCalm({ ...LINUX, search: '?movimento=total' }), false);
  assert.equal(shouldCalm({ ...MAC, search: '?movimento=calmo' }), true);
  assert.equal(shouldCalm({ ...LINUX, stored: 'total' }), false);
  assert.equal(shouldCalm({ ...MAC, stored: 'calmo' }), true);
  assert.equal(shouldCalm({ ...LINUX, search: '?movimento=qualquer' }), true);
});

function fakeWindow({ nav, search = '', stored = null, reduced = false, storageThrows = false }) {
  const classes = new Set();
  const saved = {};
  return {
    saved,
    navigator: nav,
    location: { search },
    matchMedia: () => ({ matches: reduced }),
    localStorage: {
      getItem: key => { if (storageThrows) throw new Error('bloqueado'); return key === MOTION_STORAGE_KEY ? stored : null; },
      setItem: (key, value) => { if (storageThrows) throw new Error('bloqueado'); saved[key] = value; },
    },
    document: { documentElement: { classList: {
      toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
      contains: name => classes.has(name),
    } } },
  };
}

test('applyCalmMotion marca o <html>, guarda só o pedido explícito e isCalmMotion lê', () => {
  const linux = fakeWindow({ nav: LINUX });
  assert.equal(applyCalmMotion(linux), true);
  assert.equal(isCalmMotion(linux.document), true);
  assert.deepEqual(linux.saved, {});

  const full = fakeWindow({ nav: LINUX, search: '?movimento=total' });
  assert.equal(applyCalmMotion(full), false);
  assert.equal(isCalmMotion(full.document), false);
  assert.equal(full.saved[MOTION_STORAGE_KEY], 'total');

  const mac = fakeWindow({ nav: MAC });
  assert.equal(applyCalmMotion(mac), false);
  assert.equal(mac.document.documentElement.classList.contains(CALM_CLASS), false);
});

test('armazenamento bloqueado e ambiente quebrado não lançam', () => {
  assert.equal(applyCalmMotion(fakeWindow({ nav: LINUX, storageThrows: true, search: '?movimento=total' })), false);
  assert.equal(applyCalmMotion(fakeWindow({ nav: LINUX, storageThrows: true })), true);
  assert.equal(applyCalmMotion({}), false);
  assert.equal(isCalmMotion(undefined), false);
});
