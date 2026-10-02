import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteD1 } from './helpers/sqlite-d1.js';
import { environment, seedAccount } from './helpers/fixtures.js';
import { createApp } from '../src/index.js';
import { buildUnsubscribeUrl, noticeToken, verifyNoticeToken } from '../src/email/unsubscribe.js';

const SECRET = 'segredo-de-teste-com-bastante-entropia-123456';
const BASE = 'https://api.nexuside.app';

const optOut = (db: SqliteD1, id: string): number => Number((db.sqlite.prepare('SELECT notices_opt_out AS v FROM accounts WHERE id=?').get(id) as { v: number }).v);
const env = (db: SqliteD1, overrides: Record<string, unknown> = {}) => environment(db, { NOTICE_SECRET: SECRET, ...overrides });
async function linkFor(id: string, secret = SECRET): Promise<string> { return `/v1/notices/unsubscribe?a=${encodeURIComponent(id)}&t=${await noticeToken(secret, id)}`; }

test('o token é determinístico, em base64url, e muda com a conta e com o segredo', async () => {
  const token = await noticeToken(SECRET, 'acc-1');
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(token, await noticeToken(SECRET, 'acc-1'));
  assert.notEqual(token, await noticeToken(SECRET, 'acc-2'));
  assert.notEqual(token, await noticeToken(`${SECRET}x`, 'acc-1'));
});

test('verifica só o token certo da conta certa; adulterado, de outra conta, vazio ou sem segredo é recusado', async () => {
  const token = await noticeToken(SECRET, 'acc-1');
  assert.equal(await verifyNoticeToken(SECRET, 'acc-1', token), true);
  const flipped = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
  assert.equal(await verifyNoticeToken(SECRET, 'acc-1', flipped), false);
  assert.equal(await verifyNoticeToken(SECRET, 'acc-2', token), false);
  assert.equal(await verifyNoticeToken(SECRET, 'acc-1', ''), false);
  assert.equal(await verifyNoticeToken(SECRET, 'acc-1', token.slice(1)), false);
  assert.equal(await verifyNoticeToken(SECRET, 'acc-1', `${token}extra`), false);
  assert.equal(await verifyNoticeToken('', 'acc-1', token), false, 'segredo vazio nunca valida');
  await assert.rejects(noticeToken('', 'acc-1'), /NOTICE_SECRET/, 'e nunca emite token');
});

test('a URL de descadastro tem o formato do contrato e codifica a conta', async () => {
  const token = await noticeToken(SECRET, 'acc-1');
  assert.equal(buildUnsubscribeUrl(BASE, 'acc-1', token), `${BASE}/v1/notices/unsubscribe?a=acc-1&t=${token}`);
  assert.equal(buildUnsubscribeUrl(`${BASE}/`, 'a b&c', 'tok'), `${BASE}/v1/notices/unsubscribe?a=a+b%26c&t=tok`);
});

test('GET com token válido só mostra a confirmação (botão que envia POST) e NÃO descadastra: scanner de link não pode tirar ninguém da lista', async () => {
  const db = new SqliteD1();
  await seedAccount(db, 'acc-1');
  const app = createApp();
  const link = await linkFor('acc-1');
  for (let visit = 0; visit < 2; visit += 1) {
    const response = await app.request(link, {}, env(db));
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    assert.match(response.headers.get('content-security-policy') ?? '', /form-action 'self'/);
    assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const html = await response.text();
    assert.match(html, /<form method="post" action="\/v1\/notices\/unsubscribe\?a=acc-1&amp;t=[A-Za-z0-9_-]{43}">/);
    assert.match(html, /name="confirm" value="1"/);
    assert.match(html, /Cancelar os avisos/);
    assert.doesNotMatch(html, /Avisos cancelados/);
    assert.equal(optOut(db, 'acc-1'), 0);
  }
  db.close();
});

test('o botão da página (POST com confirm=1) descadastra, mostra a confirmação e é idempotente', async () => {
  const db = new SqliteD1();
  await seedAccount(db, 'acc-1');
  const app = createApp();
  const init = { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'confirm=1' };
  const link = await linkFor('acc-1');
  for (let click = 0; click < 2; click += 1) {
    const response = await app.request(link, init, env(db));
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(await response.text(), /Avisos cancelados/);
    assert.equal(optOut(db, 'acc-1'), 1);
  }
  const bad = await app.request('/v1/notices/unsubscribe?a=acc-1&t=nope', init, env(db));
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /Link inválido/);
  db.close();
});

test('GET com token errado, de outra conta, sem parâmetros ou sem segredo configurado: 400 genérico e nada muda', async () => {
  const db = new SqliteD1();
  await seedAccount(db, 'victim');
  await seedAccount(db, 'other');
  const app = createApp();
  const otherToken = await noticeToken(SECRET, 'other');
  const cases: Array<[string, Record<string, unknown>]> = [
    ['/v1/notices/unsubscribe?a=victim&t=nope', {}],
    [`/v1/notices/unsubscribe?a=victim&t=${otherToken}`, {}],
    ['/v1/notices/unsubscribe', {}],
    [`/v1/notices/unsubscribe?a=victim`, {}],
    [`/v1/notices/unsubscribe?t=${otherToken}`, {}],
    [`/v1/notices/unsubscribe?a=victim&t=${'A'.repeat(43)}`, { NOTICE_SECRET: '' }],
    [await linkFor('victim', 'outro-segredo'), {}],
  ];
  for (const [path, overrides] of cases) {
    const response = await app.request(path, {}, env(db, overrides));
    assert.equal(response.status, 400, path);
    const body = await response.text();
    assert.match(body, /link/i);
    assert.doesNotMatch(body, /victim|other|nope/, 'a página não ecoa parâmetros');
  }
  assert.equal(optOut(db, 'victim'), 0);
  assert.equal(optOut(db, 'other'), 0);
  db.close();
});

test('HEAD (pré-visualização de link) não descadastra ninguém', async () => {
  const db = new SqliteD1();
  await seedAccount(db, 'acc-1');
  const response = await createApp().request(await linkFor('acc-1'), { method: 'HEAD' }, env(db));
  assert.equal(response.status, 200);
  assert.equal(optOut(db, 'acc-1'), 0);
  db.close();
});

test('token válido de conta que não existe responde como sucesso (não revela quais contas existem)', async () => {
  const db = new SqliteD1();
  const response = await createApp().request(await linkFor('ghost'), {}, env(db));
  assert.equal(response.status, 200);
  db.close();
});

test('POST one-click (RFC 8058) descadastra e responde 200 sem corpo útil; token errado é 400 e não muda nada', async () => {
  const db = new SqliteD1();
  await seedAccount(db, 'acc-1');
  const app = createApp();
  const init = { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' };
  const bad = await app.request('/v1/notices/unsubscribe?a=acc-1&t=nope', init, env(db));
  assert.equal(bad.status, 400);
  assert.equal(optOut(db, 'acc-1'), 0);
  const good = await app.request(await linkFor('acc-1'), init, env(db));
  assert.equal(good.status, 200);
  assert.deepEqual(await good.json(), { ok: true });
  assert.equal(optOut(db, 'acc-1'), 1);
  db.close();
});

test('as duas rotas passam pelo limitador de requisições da API', async () => {
  const db = new SqliteD1();
  await seedAccount(db, 'acc-1');
  const blocked = env(db, { API_RATE_LIMITER: { limit: async () => ({ success: false }) } });
  const app = createApp();
  assert.equal((await app.request(await linkFor('acc-1'), {}, blocked)).status, 429);
  assert.equal((await app.request(await linkFor('acc-1'), { method: 'POST' }, blocked)).status, 429);
  assert.equal(optOut(db, 'acc-1'), 0);
  db.close();
});
