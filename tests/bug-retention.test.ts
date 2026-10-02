import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteD1 } from './helpers/sqlite-d1.js';
import { environment, nativeLogin, seedAccount, webLogin } from './helpers/fixtures.js';
import { DAY_MS, count, seedReport, validReport } from './helpers/bugs.js';
import { cleanupExpired, createApp, runScheduled } from '../src/index.js';

const DIAGNOSTICS = JSON.stringify({ events: [{ t: 1, kind: 'pty.exit' }], errors: ['boom'] });
const diagnosticsOf = (db: SqliteD1, id: string) => (db.sqlite.prepare('SELECT diagnostics_json AS d FROM bug_reports WHERE id = ?').get(id) as { d: string | null }).d;

test('a limpeza zera o diagnóstico vencido, mantém o relato e os eventos, e não mexe no que ainda vale', async () => {
  const db = new SqliteD1();
  await seedAccount(db, 'ana');
  const now = Date.now();
  const expired = seedReport(db, { accountId: 'ana', title: 'Relato velho', diagnosticsJson: DIAGNOSTICS, diagnosticsExpiresAt: now - 1 });
  const exactly = seedReport(db, { accountId: 'ana', diagnosticsJson: DIAGNOSTICS, diagnosticsExpiresAt: now });
  const valid = seedReport(db, { accountId: 'ana', diagnosticsJson: DIAGNOSTICS, diagnosticsExpiresAt: now + DAY_MS });
  const without = seedReport(db, { accountId: 'ana', diagnosticsJson: null, diagnosticsExpiresAt: now - DAY_MS });
  db.sqlite.prepare("INSERT INTO bug_report_events(id, report_id, kind, details_json, created_at) VALUES ('e1', ?, 'created', '{}', ?)").run(expired, now);
  await cleanupExpired(db, now);
  assert.equal(diagnosticsOf(db, expired), null, 'vencido: zerado');
  assert.equal(diagnosticsOf(db, exactly), DIAGNOSTICS, 'no instante exato do vencimento ainda vale');
  assert.equal(diagnosticsOf(db, valid), DIAGNOSTICS);
  assert.equal(diagnosticsOf(db, without), null);
  const row = db.sqlite.prepare('SELECT title, description, status FROM bug_reports WHERE id = ?').get(expired) as Record<string, string>;
  assert.deepEqual({ ...row }, { title: 'Relato velho', description: 'Descrição de teste do relato.', status: 'new' }, 'o relato fica');
  assert.equal(count(db, 'SELECT count(*) AS n FROM bug_reports'), 4);
  assert.equal(count(db, 'SELECT count(*) AS n FROM bug_report_events'), 1);
  db.close();
});

test('a retenção é de 180 dias de ponta a ponta: relato enviado hoje perde o diagnóstico depois de 180 dias e não antes', async () => {
  const db = new SqliteD1();
  await seedAccount(db, 'ana');
  await seedAccount(db, 'admin', { admin: true });
  const env = environment(db);
  const created = await createApp().request('/v1/bug-reports', {
    method: 'POST', headers: await nativeLogin(db, 'ana'),
    body: JSON.stringify(validReport({ consent: { diagnostics: true }, diagnostics: { events: [{ t: 1, kind: 'pty.exit' }], errors: ['boom'] } })),
  }, env);
  assert.equal(created.status, 201);
  const { id } = (await created.json() as { data: { id: string } }).data;
  const start = Date.now();
  await runScheduled(env, { now: start + 179 * DAY_MS });
  assert.notEqual(diagnosticsOf(db, id), null, 'aos 179 dias ainda guarda');
  await runScheduled(env, { now: start + 181 * DAY_MS });
  assert.equal(diagnosticsOf(db, id), null, 'aos 181 dias foi zerado');
  const detail = await createApp().request(`/v1/admin/bug-reports/${id}`, { headers: await webLogin(db, 'admin') }, env);
  const body = await detail.json() as { data: { report: { title: string; diagnostics: unknown } } };
  assert.equal(body.data.report.title, 'Terminal fecha sozinho');
  assert.equal(body.data.report.diagnostics, null);
  db.close();
});

test('o cron horário (runScheduled) também faz a limpeza do diagnóstico', async () => {
  const db = new SqliteD1();
  const now = Date.now();
  const id = seedReport(db, { diagnosticsJson: DIAGNOSTICS, diagnosticsExpiresAt: now - DAY_MS });
  await runScheduled(environment(db), { now });
  assert.equal(diagnosticsOf(db, id), null);
  db.close();
});

test('sem a migração 0007 aplicada a limpeza do resto continua e a falha fica no log, sem derrubar o cron', async () => {
  const db = new SqliteD1();
  await seedAccount(db, 'ana');
  const now = Date.now();
  db.sqlite.prepare("INSERT INTO sessions(id, account_id, token_hash, expires_at) VALUES ('velha', 'ana', 'hash-velho', ?)").run(now - 1000);
  db.sqlite.exec('DROP TABLE bug_report_events; DROP TABLE bug_reports;');
  const log = mock.method(console, 'error', () => undefined);
  try {
    await cleanupExpired(db, now);
    assert.equal(count(db, "SELECT count(*) AS n FROM sessions WHERE id = 'velha'"), 0, 'a sessão vencida foi limpa mesmo assim');
    assert.equal(log.mock.callCount(), 1);
    assert.match(String(log.mock.calls[0]!.arguments[0]), /diagnóstico/i);
  } finally { log.mock.restore(); }
  db.close();
});
