import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setMobileNavOpen } from './nav.js';

test('setMobileNavOpen marca o header e o botão', () => {
  const header = {
    className: '',
    classList: {
      toggle(name, on) {
        header.className = on ? name : '';
      },
    },
  };
  const toggle = {
    attrs: {},
    setAttribute(name, value) { this.attrs[name] = value; },
  };
  setMobileNavOpen(header, toggle, true);
  assert.equal(header.className, 'nav-open');
  assert.equal(toggle.attrs['aria-expanded'], 'true');
  assert.equal(toggle.attrs['aria-label'], 'Fechar menu');
  setMobileNavOpen(header, toggle, false);
  assert.equal(header.className, '');
  assert.equal(toggle.attrs['aria-expanded'], 'false');
  assert.equal(toggle.attrs['aria-label'], 'Abrir menu');
});

const home = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const benchmarks = readFileSync(new URL('../benchmarks/index.html', import.meta.url), 'utf8');
const conta = readFileSync(new URL('../conta/index.html', import.meta.url), 'utf8');
const admin = readFileSync(new URL('../admin/index.html', import.meta.url), 'utf8');
const prizeCss = readFileSync(new URL('./prize.css', import.meta.url), 'utf8');
const tokensCss = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');
const accountCss = readFileSync(new URL('./account.css', import.meta.url), 'utf8');
const pagesJs = readFileSync(new URL('./pages.js', import.meta.url), 'utf8');

function assertProductNav(html, label) {
  assert.match(html, /class="mobile-nav-toggle"/, `${label}: falta o hamburger`);
  assert.match(html, /id="nav-menu"/, `${label}: falta id do menu`);
  assert.match(html, /class="nav-actions"/, `${label}: falta nav-actions`);
  assert.match(html, /href="https:\/\/comunidade\.nexuside\.app\/"[^>]*>Comunidade/, `${label}: falta Comunidade`);
}

test('cada header .nav do produto tem hamburger, nav-actions e Comunidade', () => {
  assertProductNav(home, 'home');
  assertProductNav(benchmarks, 'benchmarks');
  assertProductNav(conta, 'conta');
  assertProductNav(admin, 'admin');
});

test('pages.js declara recommendDownload uma só vez e inicia o menu mobile', () => {
  assert.equal([...pagesJs.matchAll(/async function recommendDownload\(\)/g)].length, 1);
  assert.match(pagesJs, /initMobileNav\(\)/);
});

test('o letreiro parado no celular força max-width e min-width zero nos itens', () => {
  assert.match(prizeCss, /prefers-reduced-motion:reduce/);
  assert.match(prizeCss, /\.prize-marquee-item\{[^}]*max-width:100%[^}]*min-width:0/);
  assert.match(prizeCss, /\.prize-marquee\{[^}]*max-width:100%/);
  assert.match(prizeCss, /overflow-wrap:anywhere/);
});

test('o CSS do menu mobile só altera headers com o botão hamburger', () => {
  assert.match(tokensCss, /\.nav:has\(\.mobile-nav-toggle\)/);
  assert.match(tokensCss, /html\{overflow-x:clip\}/);
  assert.doesNotMatch(accountCss, /\.account-page \.nav-links>a:first-child\{display:none\}/);
});
