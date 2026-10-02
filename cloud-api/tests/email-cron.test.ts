import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import worker, { runScheduled } from '../src/index.js';
import { SqliteD1 } from './helpers/sqlite-d1.js';
import { environment, seedAccount } from './helpers/fixtures.js';

const ON = { EMAIL_ENABLED: 'true', RESEND_API_KEY: 're_test', NOTICE_SECRET: 'segredo-de-teste-com-bastante-entropia-123456' };
const DAY = 24 * 60 * 60 * 1000;

function expiredSession(db: SqliteD1): void {
  db.sqlite.prepare("INSERT INTO sessions(id,account_id,token_hash,csrf_hash,channel,expires_at) VALUES('s1','acc-1','h','c','web',?)").run(Date.now() - DAY);
}
const sessions = (db: SqliteD1): number => Number((db.sqlite.prepare('SELECT count(*) AS n FROM sessions').get() as { n: number }).n);
const marks = (db: SqliteD1): number => Number((db.sqlite.prepare('SELECT count(*) AS n FROM account_notices').get() as { n: number }).n);

test('o cron horário limpa e, com e-mail desligado, não chama o Resend nem toca nos avisos', async () => {
  const db = new SqliteD1();
  await seedAccount(db, 'acc-1', { trialDays: 2 });
  expiredSession(db);
  const calls: string[] = [];
  await runScheduled(environment(db), { fetchFn: async (input) => { calls.push(String(input)); return new Response('{}'); } });
  assert.equal(sessions(db), 0, 'a limpeza rodou');
  assert.deepEqual(calls, []);
  assert.equal(marks(db), 0);
  db.close();
});

test('o cron horário, com e-mail ligado, limpa e depois envia o aviso que está na hora', async () => {
  const db = new SqliteD1();
  await seedAccount(db, 'acc-1', { trialDays: 2 });
  expiredSession(db);
  const calls: string[] = [];
  await runScheduled(environment(db, ON), { fetchFn: async (input) => { calls.push(String(input)); return new Response(JSON.stringify({ id: 'em_1' }), { status: 200 }); } });
  assert.equal(sessions(db), 0);
  assert.deepEqual(calls, ['https://api.resend.com/emails']);
  assert.equal(marks(db), 1);
  db.close();
});

test('falha no envio de e-mail é registrada e não desfaz a limpeza nem derruba o cron', async () => {
  const db = new SqliteD1();
  await seedAccount(db, 'acc-1', { trialDays: 2 });
  expiredSession(db);
  const logged = mock.method(console, 'error', () => {});
  // PUBLIC_BASE_URL sem https faz o modelo recusar o link de descadastro: o despacho lança.
  await runScheduled(environment(db, { ...ON, PUBLIC_BASE_URL: 'http://api.exemplo.test' }), { fetchFn: async () => new Response('{}') });
  assert.equal(sessions(db), 0, 'a limpeza já tinha rodado');
  assert.equal(logged.mock.callCount(), 1);
  assert.match(String(logged.mock.calls[0]!.arguments[0]), /avisos por e-mail falharam/);
  mock.restoreAll();
  db.close();
});

test('o handler scheduled entrega o trabalho ao waitUntil, sem e-mail enquanto desligado', async () => {
  const db = new SqliteD1();
  await seedAccount(db, 'acc-1', { trialDays: 2 });
  expiredSession(db);
  const pending: Promise<unknown>[] = [];
  const fetchMock = mock.method(globalThis, 'fetch', async () => new Response('{}'));
  worker.scheduled!({} as ScheduledController, environment(db), { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } } as unknown as ExecutionContext);
  await Promise.all(pending);
  assert.equal(pending.length, 1, 'um só waitUntil');
  assert.equal(sessions(db), 0);
  assert.equal(fetchMock.mock.callCount(), 0);
  mock.restoreAll();
  db.close();
});
