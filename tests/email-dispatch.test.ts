import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteD1 } from './helpers/sqlite-d1.js';
import { environment, seedAccount, seedSubscription } from './helpers/fixtures.js';
import { DatabaseSync } from 'node:sqlite';
import { sendDueNotices } from '../src/email/dispatch.js';
import { FORBIDDEN_ADDRESS_GLOB, deliverableEmailSql, isDeliverableEmail } from '../src/email/notices.js';
import { verifyNoticeToken } from '../src/email/unsubscribe.js';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 10, 15, 0, 0);
const noSleep = async (): Promise<void> => {};
const SECRET = 'segredo-de-teste-com-bastante-entropia-123456';
const API_KEY = 're_chave_secreta_de_teste';

const ON = { EMAIL_ENABLED: 'true', RESEND_API_KEY: API_KEY, NOTICE_SECRET: SECRET };
const env = (db: SqliteD1, overrides: Record<string, unknown> = {}) => environment(db, { ...ON, ...overrides });

interface Call { readonly url: string; readonly headers: Headers; readonly body: { to: string[]; subject: string; html: string; text: string; headers: Record<string, string> } }
function resend(respond: (call: Call, index: number) => Response = (_call, index) => new Response(JSON.stringify({ id: `em_${index + 1}` }), { status: 200 })) {
  const calls: Call[] = [];
  const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call: Call = { url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) };
    calls.push(call);
    return respond(call, calls.length - 1);
  };
  return { calls, fetchFn };
}
const status = (code: number, name = 'internal_server_error') => () => new Response(JSON.stringify({ name, message: 'x' }), { status: code });

/** Põe a conta no relógio fixo do teste: criada há `createdAgo` e com o teste terminando em `endsIn` (negativo = já terminou). */
function place(db: SqliteD1, id: string, { createdAgo = 30 * DAY, endsIn }: { createdAgo?: number; endsIn: number | null }): void {
  db.sqlite.prepare('UPDATE accounts SET created_at=?, trial_started_at=?, trial_expires_at=? WHERE id=?').run(NOW - createdAgo, NOW - createdAgo, endsIn === null ? null : NOW + endsIn, id);
}
async function seed(db: SqliteD1, id: string, placement: { createdAgo?: number; endsIn: number | null }, options: Parameters<typeof seedAccount>[2] = {}): Promise<void> {
  await seedAccount(db, id, options);
  place(db, id, placement);
}
const notices = (db: SqliteD1) => db.sqlite.prepare('SELECT account_id, kind, sent_at, provider_id FROM account_notices ORDER BY account_id, kind').all().map(row => ({ ...row })) as Array<{ account_id: string; kind: string; sent_at: number; provider_id: string | null }>;
const recipients = (calls: Call[]) => calls.map(call => call.body.to[0]).sort();

test('desligado, ou sem uma das credenciais: não consulta o banco, não chama o Resend e não marca nada', async () => {
  for (const overrides of [{ EMAIL_ENABLED: 'false' }, { RESEND_API_KEY: '' }, { NOTICE_SECRET: '' }]) {
    const db = new SqliteD1();
    await seed(db, 'acc-1', { endsIn: 2 * DAY });
    const before = db.queryCount;
    const { calls, fetchFn } = resend();
    const result = await sendDueNotices(env(db, overrides), { sleep: noSleep, now: NOW, fetchFn });
    assert.deepEqual(result, { skipped: 'disabled' });
    assert.equal(calls.length, 0);
    assert.equal(db.queryCount, before, 'zero consultas');
    assert.deepEqual(notices(db), []);
    db.close();
  }
  const db = new SqliteD1();
  await seed(db, 'acc-1', { endsIn: 2 * DAY });
  const { calls, fetchFn } = resend();
  assert.deepEqual(await sendDueNotices(environment(db), { sleep: noSleep, now: NOW, fetchFn }), { skipped: 'disabled' }, 'o padrão do ambiente é desligado');
  assert.equal(calls.length, 0);
  db.close();
});

test('ligado: envia uma vez por conta e tipo, com idempotência, descadastro assinado e marca com o id do provedor', async () => {
  const db = new SqliteD1();
  await seed(db, 'acc-1', { endsIn: 2 * DAY });
  const { calls, fetchFn } = resend();
  const first = await sendDueNotices(env(db), { sleep: noSleep, now: NOW, fetchFn });
  assert.equal(first.skipped, undefined);
  assert.equal(first.sent, 1);
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call!.url, 'https://api.resend.com/emails');
  assert.equal(call!.headers.get('authorization'), `Bearer ${API_KEY}`);
  assert.equal(call!.headers.get('idempotency-key'), 'acc-1:trial_ending_3d');
  assert.deepEqual(call!.body.to, ['acc-1@example.test']);
  assert.match(call!.body.subject, /2 dias/);
  const unsubscribe = new URL(/<(.+)>/.exec(call!.body.headers['List-Unsubscribe'] ?? '')![1]!);
  assert.equal(unsubscribe.origin + unsubscribe.pathname, 'https://api.nexuside.app/v1/notices/unsubscribe');
  assert.equal(unsubscribe.searchParams.get('a'), 'acc-1');
  assert.equal(await verifyNoticeToken(SECRET, 'acc-1', unsubscribe.searchParams.get('t') ?? ''), true);
  assert.equal(call!.body.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.ok(call!.body.html.includes('Você recebeu este aviso porque criou uma conta no NexusIDE'));
  assert.deepEqual(notices(db), [{ account_id: 'acc-1', kind: 'trial_ending_3d', sent_at: NOW, provider_id: 'em_1' }]);

  const second = await sendDueNotices(env(db), { sleep: noSleep, now: NOW + 5 * 60_000, fetchFn });
  assert.equal(second.sent, 0);
  assert.equal(calls.length, 1, 'a segunda execução não envia de novo');
  assert.equal(notices(db).length, 1);
  db.close();
});

test('o e-mail usa o prazo e o limite de agentes configurados, e o preço nunca aparece', async () => {
  const db = new SqliteD1();
  await seed(db, 'acc-1', { createdAgo: 1 * HOUR, endsIn: 7 * DAY - HOUR });
  const { calls, fetchFn } = resend();
  await sendDueNotices(env(db, { TRIAL_DAYS: '7', TRIAL_MAX_AGENTS: '3' }), { sleep: noSleep, now: NOW, fetchFn });
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.body.text, /7 dias/);
  assert.match(calls[0]!.body.text, /até 3 agentes/);
  assert.doesNotMatch(calls[0]!.body.subject + calls[0]!.body.text + calls[0]!.body.html, /R\$|\d+,\d{2}/);
  db.close();
});

test('janelas: cada conta recebe só o aviso do seu momento', async () => {
  const db = new SqliteD1();
  await seed(db, 'welcome-new', { createdAgo: 1 * HOUR, endsIn: 14 * DAY });
  await seed(db, 'welcome-old', { createdAgo: 25 * HOUR, endsIn: 14 * DAY });
  await seed(db, 'in-5d', { endsIn: 5 * DAY });
  await seed(db, 'in-3d', { endsIn: 3 * DAY });
  await seed(db, 'in-1d', { endsIn: 1 * DAY });
  await seed(db, 'ended-2d', { endsIn: -2 * DAY });
  await seed(db, 'ended-8d', { endsIn: -8 * DAY });
  const { calls, fetchFn } = resend();
  await sendDueNotices(env(db), { sleep: noSleep, now: NOW, fetchFn });
  const kinds = Object.fromEntries(notices(db).map(row => [row.account_id, row.kind]));
  assert.deepEqual(kinds, { 'welcome-new': 'welcome', 'in-3d': 'trial_ending_3d', 'in-1d': 'trial_ending_1d', 'ended-2d': 'trial_ended' });
  assert.equal(calls.length, 4);
  db.close();
});

test('quem já recebeu o aviso mais urgente da janela não recebe o menos urgente; quem recebeu o 3d ainda recebe o 1d', async () => {
  const db = new SqliteD1();
  await seed(db, 'acc-1', { createdAgo: 2 * HOUR, endsIn: 2 * DAY });
  db.sqlite.prepare("INSERT INTO account_notices(account_id,kind,sent_at) VALUES('acc-1','trial_ending_3d',?)").run(NOW - HOUR);
  const { calls, fetchFn } = resend();
  const result = await sendDueNotices(env(db), { sleep: noSleep, now: NOW, fetchFn });
  assert.equal(result.sent, 0, 'o aviso mais urgente (3d) já saiu; o de boas-vindas não volta');
  assert.equal(calls.length, 0);

  await seed(db, 'acc-2', { endsIn: 12 * HOUR });
  db.sqlite.prepare("INSERT INTO account_notices(account_id,kind,sent_at) VALUES('acc-2','trial_ending_3d',?)").run(NOW - 2 * DAY);
  await sendDueNotices(env(db), { sleep: noSleep, now: NOW, fetchFn });
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.body.subject, /24 horas/);
  db.close();
});

test('nunca avisa Pro, concessão por código, admin, suspensa, descadastrada ou sem e-mail entregável', async () => {
  const db = new SqliteD1();
  const window = { endsIn: 2 * DAY };
  await seed(db, 'eligible', window);
  await seed(db, 'paid', window); await seedSubscription(db, 'paid');
  await seed(db, 'granted', window);
  db.sqlite.prepare("INSERT INTO subscriptions(id,owner_type,account_id,stripe_subscription_id,stripe_customer_id,plan,status,current_period_end) VALUES('row-granted','account','granted','codegrant:code-1:granted','cus_g','pro','active',?)").run(NOW + 30 * DAY);
  await seed(db, 'boss', window, { admin: true });
  await seed(db, 'suspended', window, { suspended: true });
  await seed(db, 'opted-out', window);
  db.sqlite.prepare("UPDATE accounts SET notices_opt_out=1 WHERE id='opted-out'").run();
  await seed(db, 'no-email', window, { email: 'github:123456' });
  const { calls, fetchFn } = resend();
  await sendDueNotices(env(db), { sleep: noSleep, now: NOW, fetchFn });
  assert.deepEqual(recipients(calls), ['eligible@example.test']);
  db.close();
});

test('falha que vale nova tentativa não marca e o lote para após 3 seguidas; a execução seguinte envia tudo', async () => {
  const db = new SqliteD1();
  for (let i = 1; i <= 6; i += 1) await seed(db, `acc-${i}`, { endsIn: 2 * DAY });
  const down = resend(status(503));
  const failed = await sendDueNotices(env(db), { sleep: noSleep, now: NOW, fetchFn: down.fetchFn, log: () => {} });
  assert.equal(down.calls.length, 3, 'para na terceira falha seguida');
  assert.equal(failed.sent, 0);
  assert.equal(failed.stopped, 'consecutive_failures');
  assert.deepEqual(notices(db), []);

  const up = resend();
  const recovered = await sendDueNotices(env(db), { sleep: noSleep, now: NOW + HOUR, fetchFn: up.fetchFn });
  assert.equal(recovered.sent, 6);
  assert.equal(notices(db).length, 6);
  db.close();
});

test('uma falha isolada entre sucessos não derruba o lote (as falhas têm de ser seguidas)', async () => {
  const db = new SqliteD1();
  for (let i = 1; i <= 6; i += 1) await seed(db, `acc-${i}`, { endsIn: 2 * DAY });
  const flaky = resend((_call, index) => index % 2 === 0 ? new Response('{}', { status: 503 }) : new Response(JSON.stringify({ id: `em_${index}` }), { status: 200 }));
  const result = await sendDueNotices(env(db), { sleep: noSleep, now: NOW, fetchFn: flaky.fetchFn, log: () => {} });
  assert.equal(flaky.calls.length, 6);
  assert.equal(result.sent, 3);
  assert.equal(result.failed, 3);
  assert.equal(result.stopped, null);
  db.close();
});

test('falha que não vale nova tentativa não marca, não derruba o lote e é registrada uma vez por execução, sem endereço nem chave', async () => {
  const db = new SqliteD1();
  for (let i = 1; i <= 4; i += 1) await seed(db, `acc-${i}`, { endsIn: 2 * DAY });
  const logs: string[] = [];
  const picky = resend((call, index) => index < 2 ? new Response(JSON.stringify({ name: 'validation_error', message: `bad ${call.body.to[0]}` }), { status: 422 }) : new Response(JSON.stringify({ id: 'em_ok' }), { status: 200 }));
  const result = await sendDueNotices(env(db), { sleep: noSleep, now: NOW, fetchFn: picky.fetchFn, log: message => logs.push(message) });
  assert.equal(picky.calls.length, 4);
  assert.equal(result.sent, 2);
  assert.equal(result.failed, 2);
  assert.equal(notices(db).length, 2);
  assert.equal(logs.length, 1, 'uma linha por execução');
  assert.match(logs[0]!, /422/);
  assert.doesNotMatch(logs.join('\n'), new RegExp(`@example\\.test|${API_KEY}|${SECRET}`));
  db.close();
});

test('chave recusada pelo Resend (401/403) é problema do lote inteiro: para na hora', async () => {
  for (const code of [401, 403]) {
    const db = new SqliteD1();
    for (let i = 1; i <= 5; i += 1) await seed(db, `acc-${i}`, { endsIn: 2 * DAY });
    const refused = resend(status(code, 'invalid_api_key'));
    const result = await sendDueNotices(env(db), { sleep: noSleep, now: NOW, fetchFn: refused.fetchFn, log: () => {} });
    assert.equal(refused.calls.length, 1, String(code));
    assert.equal(result.stopped, 'auth');
    assert.deepEqual(notices(db), []);
    db.close();
  }
});

test('o lote é de no máximo 50 envios, por urgência, em poucas consultas ao banco', async () => {
  const db = new SqliteD1();
  for (let i = 1; i <= 60; i += 1) await seed(db, `three-${String(i).padStart(2, '0')}`, { endsIn: 2 * DAY });
  await seed(db, 'urgent-1d', { endsIn: 6 * HOUR });
  await seed(db, 'urgent-ended', { endsIn: -1 * DAY });
  const { calls, fetchFn } = resend();
  const before = db.queryCount;
  const first = await sendDueNotices(env(db), { sleep: noSleep, now: NOW, fetchFn });
  assert.equal(first.sent, 50);
  assert.equal(calls.length, 50);
  assert.ok(recipients(calls).includes('urgent-1d@example.test') && recipients(calls).includes('urgent-ended@example.test'), 'os mais urgentes entram primeiro');
  assert.ok(db.queryCount - before <= 8, `consultas ao banco: ${db.queryCount - before}`);
  const second = await sendDueNotices(env(db), { sleep: noSleep, now: NOW + HOUR, fetchFn });
  assert.equal(second.sent, 12, 'o restante sai na execução seguinte');
  assert.equal(notices(db).length, 62);
  db.close();
});

test('se não der para registrar o envio, o lote para em vez de seguir enviando sem marca', async () => {
  const db = new SqliteD1();
  for (let i = 1; i <= 25; i += 1) await seed(db, `acc-${String(i).padStart(2, '0')}`, { endsIn: 2 * DAY });
  mock.method(db, 'batch', async () => { throw new Error('d1 indisponível'); });
  const { calls, fetchFn } = resend();
  await assert.rejects(sendDueNotices(env(db), { sleep: noSleep, now: NOW, fetchFn }), /d1 indisponível/);
  assert.ok(calls.length <= 10, `parou no primeiro bloco de marcas: ${calls.length}`);
  mock.restoreAll();
  db.close();
});

test('chave de idempotência já usada com outro corpo (409) quer dizer que o envio anterior saiu: marca e não repete', async () => {
  const db = new SqliteD1();
  await seed(db, 'acc-1', { endsIn: 2 * DAY });
  const logs: string[] = [];
  const { calls, fetchFn } = resend(() => new Response(JSON.stringify({ name: 'invalid_idempotent_request', message: 'x' }), { status: 409 }));
  const result = await sendDueNotices(env(db), { sleep: noSleep, now: NOW, fetchFn, log: message => logs.push(message) });
  assert.equal(result.sent, 1);
  assert.deepEqual(notices(db), [{ account_id: 'acc-1', kind: 'trial_ending_3d', sent_at: NOW, provider_id: null }]);
  assert.deepEqual(logs, []);
  await sendDueNotices(env(db), { sleep: noSleep, now: NOW + HOUR, fetchFn });
  assert.equal(calls.length, 1, 'e a execução seguinte não tenta de novo');
  db.close();
});

test('pedido simultâneo com a mesma chave (409 concurrent) vale nova tentativa: não marca', async () => {
  const db = new SqliteD1();
  await seed(db, 'acc-1', { endsIn: 2 * DAY });
  const { fetchFn } = resend(() => new Response(JSON.stringify({ name: 'concurrent_idempotent_requests', message: 'x' }), { status: 409 }));
  const result = await sendDueNotices(env(db), { sleep: noSleep, now: NOW, fetchFn, log: () => {} });
  assert.equal(result.sent, 0);
  assert.deepEqual(notices(db), []);
  db.close();
});

test('aceito sem id legível ainda é marcado, com provider_id nulo', async () => {
  const db = new SqliteD1();
  await seed(db, 'acc-1', { endsIn: 2 * DAY });
  const { fetchFn } = resend(() => new Response('', { status: 200 }));
  await sendDueNotices(env(db), { sleep: noSleep, now: NOW, fetchFn });
  assert.deepEqual(notices(db), [{ account_id: 'acc-1', kind: 'trial_ending_3d', sent_at: NOW, provider_id: null }]);
  db.close();
});

test('envia em ritmo de 2 por segundo: nenhuma espera antes do primeiro e uma de 550 ms entre os seguintes', async () => {
  const db = new SqliteD1();
  for (let i = 1; i <= 3; i += 1) await seed(db, `acc-${i}`, { endsIn: 2 * DAY });
  const pauses: number[] = [];
  const { fetchFn } = resend();
  await sendDueNotices(env(db), { now: NOW, fetchFn, sleep: async ms => { pauses.push(ms); } });
  assert.deepEqual(pauses, [550, 550]);
  db.close();
});

test('429 do Resend: pausa maior e uma segunda chance no mesmo aviso antes de contar como falha', async () => {
  const db = new SqliteD1();
  for (let i = 1; i <= 3; i += 1) await seed(db, `acc-${i}`, { endsIn: 2 * DAY });
  const pauses: number[] = [];
  const slowDown = resend((_call, index) => index % 2 === 0 ? new Response(JSON.stringify({ name: 'rate_limit_exceeded', message: 'x' }), { status: 429 }) : new Response(JSON.stringify({ id: `em_${index}` }), { status: 200 }));
  const result = await sendDueNotices(env(db), { now: NOW, fetchFn: slowDown.fetchFn, sleep: async ms => { pauses.push(ms); } });
  assert.equal(result.sent, 3);
  assert.equal(slowDown.calls.length, 6);
  assert.deepEqual(pauses, [1500, 550, 1500, 550, 1500]);
  db.close();
});

test('429 que não passa nem na segunda chance conta como falha, e três avisos assim interrompem o lote', async () => {
  const db = new SqliteD1();
  for (let i = 1; i <= 5; i += 1) await seed(db, `acc-${i}`, { endsIn: 2 * DAY });
  const limited = resend(() => new Response(JSON.stringify({ name: 'rate_limit_exceeded', message: 'x' }), { status: 429 }));
  const result = await sendDueNotices(env(db), { now: NOW, fetchFn: limited.fetchFn, sleep: noSleep, log: () => {} });
  assert.equal(limited.calls.length, 6, 'duas tentativas por aviso, três avisos');
  assert.equal(result.stopped, 'consecutive_failures');
  assert.deepEqual(notices(db), []);
  db.close();
});

test('as segundas chances também contam no teto de 50 chamadas ao Resend por execução', async () => {
  const db = new SqliteD1();
  for (let i = 1; i <= 40; i += 1) await seed(db, `acc-${String(i).padStart(2, '0')}`, { endsIn: 2 * DAY });
  const slowDown = resend((_call, index) => index % 2 === 0 ? new Response('{}', { status: 429 }) : new Response(JSON.stringify({ id: `em_${index}` }), { status: 200 }));
  const result = await sendDueNotices(env(db), { now: NOW, fetchFn: slowDown.fetchFn, sleep: noSleep });
  assert.equal(slowDown.calls.length, 50);
  assert.equal(result.sent, 25);
  assert.equal(notices(db).length, 25, 'o resto fica para a execução seguinte');
  db.close();
});

test('o disjuntor conta falhas SEGUIDAS: uma recusa definitiva no meio zera a contagem', async () => {
  const db = new SqliteD1();
  for (let i = 1; i <= 6; i += 1) await seed(db, `acc-${i}`, { endsIn: 2 * DAY });
  const mixed = resend((_call, index) => index % 2 === 0 ? new Response('{}', { status: 503 }) : new Response(JSON.stringify({ name: 'validation_error', message: 'x' }), { status: 422 }));
  const result = await sendDueNotices(env(db), { now: NOW, fetchFn: mixed.fetchFn, sleep: noSleep, log: () => {} });
  assert.equal(mixed.calls.length, 6);
  assert.equal(result.stopped, null);
  assert.equal(result.failed, 6);
  db.close();
});

test('endereço que o SQL aceitaria mas a regra de entrega recusa não ocupa as 50 vagas do lote', async () => {
  const db = new SqliteD1();
  for (let i = 1; i <= 50; i += 1) await seed(db, `bad-${String(i).padStart(2, '0')}`, { endsIn: 36 * HOUR }, { email: `o'brien${i}@example.test` });
  await seed(db, 'good', { endsIn: 60 * HOUR });
  const { calls, fetchFn } = resend();
  const result = await sendDueNotices(env(db), { now: NOW, fetchFn, sleep: noSleep });
  assert.equal(result.candidates, 1, 'os endereços inválidos nem entram na consulta');
  assert.deepEqual(recipients(calls), ['good@example.test']);
  db.close();
});

test('o espelho em SQL da regra de endereço concorda com isDeliverableEmail', () => {
  const sqlite = new DatabaseSync(':memory:');
  const statement = sqlite.prepare(`SELECT ${deliverableEmailSql('email', '?2')} AS ok FROM (SELECT ?1 AS email)`);
  const samples = [
    'ana@example.com', 'a.b+c@sub.example.co', 'x@y.z', 'a-b_c@d-e.fr', 'Ana.Silva@Example.COM', 'a@b..c', 'ünï@exemplo.com.br',
    "o'brien@x.com", 'a@localhost', 'a@b', 'a b@c.d', 'a@b.c ', 'a@@b.c', 'a@b@c.d', '@b.c', 'a@.c', 'a@b.', '', 'github:123456', 'google:subject-1',
    'a<b>@c.d', 'a"b@c.d', 'a,b@c.d', 'a;b@c.d', 'a:b@c.d', 'a(b)@c.d', 'a[b]@c.d', 'a\\b@c.d', 'a\tb@c.d', 'a\nb@c.d', 'a\rb@c.d',
    `${'a'.repeat(249)}@b.co`, `${'a'.repeat(250)}@b.co`,
  ];
  for (const sample of samples) {
    const sql = Number((statement.get(sample, FORBIDDEN_ADDRESS_GLOB) as { ok: number }).ok) === 1;
    assert.equal(sql, isDeliverableEmail(sample), JSON.stringify(sample));
  }
  sqlite.close();
});
