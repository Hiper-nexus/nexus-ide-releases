import test from 'node:test';
import assert from 'node:assert/strict';
import { configFrom, emailConfigured } from '../src/config.js';

const base = { PUBLIC_BASE_URL: 'https://api.nexuside.app', PUBLIC_SITE_URL: 'https://nexuside.app' };

test('sem nenhuma variável de e-mail o padrão é desligado, com o remetente da marca', () => {
  const config = configFrom(base);
  assert.equal(config.EMAIL_ENABLED, 'false');
  assert.equal(config.EMAIL_FROM, 'NexusIDE <avisos@nexuside.app>');
  assert.equal(config.RESEND_API_KEY, '');
  assert.equal(config.NOTICE_SECRET, '');
  assert.equal(emailConfigured(config), false);
});

test('só conta como configurado com o interruptor ligado e as duas credenciais', () => {
  const on = { ...base, EMAIL_ENABLED: 'true', RESEND_API_KEY: 're_x', NOTICE_SECRET: 'segredo' };
  assert.equal(emailConfigured(configFrom(on)), true);
  assert.equal(emailConfigured(configFrom({ ...on, EMAIL_ENABLED: 'false' })), false);
  assert.equal(emailConfigured(configFrom({ ...on, RESEND_API_KEY: '' })), false);
  assert.equal(emailConfigured(configFrom({ ...on, NOTICE_SECRET: '' })), false);
});

test('valor inválido no interruptor falha cedo, como os demais interruptores', () => {
  assert.throws(() => configFrom({ ...base, EMAIL_ENABLED: 'sim' }));
});
