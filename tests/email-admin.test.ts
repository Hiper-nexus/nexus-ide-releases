import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteD1 } from './helpers/sqlite-d1.js';
import { ADMIN_EMAIL, SITE, environment, seedAccount, webLogin } from './helpers/fixtures.js';
import { createApp } from '../src/index.js';

const PATH = '/v1/admin/notices/test';
const ON = { EMAIL_ENABLED: 'true', RESEND_API_KEY: 're_test_chave', NOTICE_SECRET: 'segredo-de-teste-com-bastante-entropia-123456' };

interface Sent { readonly to: string[]; readonly subject: string; readonly html: string; readonly text: string }
async function setup(respond: () => Response = () => new Response(JSON.stringify({ id: 'em_test' }), { status: 200 })) {
  const db = new SqliteD1();
  await seedAccount(db, 'admin', { admin: true });
  await seedAccount(db, 'user');
  const sent: Sent[] = [];
  const fetchFn = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => { sent.push(JSON.parse(String(init?.body))); return respond(); };
  const app = createApp({ fetchFn });
  const post = (headers: Record<string, string>, overrides: Record<string, unknown> = ON) => app.request(PATH, { method: 'POST', headers, body: '{}' }, environment(db, overrides));
  const audit = () => (db.sqlite.prepare("SELECT actor_account_id, target_account_id, action, details FROM admin_audit WHERE action='test_notice'").all() as Array<Record<string, string | null>>).map(row => ({ ...row }));
  return { db, sent, post, audit, admin: await webLogin(db, 'admin') };
}

test('o envio de teste recusa visitante, usuário comum e requisição sem CSRF ou de outra origem, sem enviar nada', async () => {
  const { db, sent, post, admin } = await setup();
  assert.equal((await post({ Origin: SITE, 'Content-Type': 'application/json' })).status, 401);
  assert.equal((await post(await webLogin(db, 'user'))).status, 403);
  const { 'X-CSRF-Token': _token, ...withoutCsrf } = admin;
  assert.equal((await post(withoutCsrf)).status, 403);
  assert.equal((await post({ ...admin, Origin: 'https://evil.example' })).status, 403);
  assert.equal(sent.length, 0);
  db.close();
});

test('sem e-mail configurado o envio de teste explica o que definir e não envia nem audita', async () => {
  for (const overrides of [{}, { ...ON, EMAIL_ENABLED: 'false' }, { ...ON, RESEND_API_KEY: '' }, { ...ON, NOTICE_SECRET: '' }]) {
    const { db, sent, post, audit, admin } = await setup();
    const response = await post(admin, overrides);
    assert.equal(response.status, 503);
    const body = await response.json() as { ok: boolean; error: string };
    assert.equal(body.ok, false);
    assert.match(body.error, /Defina EMAIL_ENABLED, RESEND_API_KEY e NOTICE_SECRET/);
    assert.equal(sent.length, 0);
    assert.deepEqual(audit(), []);
    db.close();
  }
});

test('o envio de teste manda o aviso de 3 dias só para o e-mail do admin que chamou e audita sem o endereço', async () => {
  const { db, sent, post, audit, admin } = await setup();
  const response = await post(admin);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, sent: true });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]!.to, [ADMIN_EMAIL]);
  assert.match(sent[0]!.subject, /3 dias/);
  assert.match(sent[0]!.html, /unsubscribe\?a=admin&amp;t=/);
  const rows = audit();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.actor_account_id, 'admin');
  assert.deepEqual(JSON.parse(rows[0]!.details!), { kind: 'trial_ending_3d', sent: true });
  assert.doesNotMatch(JSON.stringify(rows), /@/, 'nenhum endereço na auditoria');
  assert.equal(Number((db.sqlite.prepare('SELECT count(*) AS n FROM account_notices').get() as { n: number }).n), 0, 'o teste não consome o aviso real');
  db.close();
});

test('se o Resend recusar, a resposta traz o motivo (sem endereço) e a auditoria registra que não saiu', async () => {
  const { db, post, audit, admin } = await setup(() => new Response(JSON.stringify({ name: 'validation_error', message: `The ${ADMIN_EMAIL} domain is not verified` }), { status: 403 }));
  const response = await post(admin);
  assert.equal(response.status, 200);
  const body = await response.json() as { ok: boolean; sent: boolean; reason: string };
  assert.deepEqual(body, { ok: true, sent: false, reason: 'http_403:validation_error' });
  assert.doesNotMatch(JSON.stringify(body), /@/);
  assert.deepEqual(JSON.parse(audit()[0]!.details!), { kind: 'trial_ending_3d', sent: false, reason: 'http_403:validation_error' });
  db.close();
});
