import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteD1 } from './helpers/sqlite-d1.js';
import { SITE, environment, nativeLogin, seedAccount, webLogin } from './helpers/fixtures.js';
import { DAY_MS, count, seedReport, validReport } from './helpers/bugs.js';
import { createApp } from '../src/index.js';

type Body = { ok: boolean; error?: string; data?: Record<string, any> };
const SECRET = 'sk-proj-AbCdEf1234567890abcdef1234567890';

async function setup() {
  const db = new SqliteD1();
  await seedAccount(db, 'ana');
  await seedAccount(db, 'bia');
  const app = createApp();
  const env = environment(db);
  const send = (path: string, headers: Record<string, string>, body?: unknown, method = body === undefined ? 'GET' : 'POST') =>
    app.request(path, { method, headers, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) }, env);
  const post = (headers: Record<string, string>, body: unknown) => send('/v1/bug-reports', headers, body);
  return { db, app, env, send, post, ana: await nativeLogin(db, 'ana'), bia: await nativeLogin(db, 'bia') };
}
const json = async (response: Response): Promise<Body> => await response.json() as Body;

test('POST /v1/bug-reports exige a sessão do app: sem login ou só com cookie do site é 401', async () => {
  const { db, post } = await setup();
  assert.equal((await post({ 'Content-Type': 'application/json' }, validReport())).status, 401);
  assert.equal((await post({ Authorization: 'Bearer token-invalido' }, validReport())).status, 401);
  assert.equal((await post(await webLogin(db, 'ana'), validReport())).status, 401, 'o cookie do site não vale aqui');
  assert.equal(count(db, 'SELECT count(*) AS n FROM bug_reports'), 0);
  db.close();
});

test('POST cria o relato (201, status new), grava gravidade média, impressão digital, expiração do diagnóstico e o evento created', async () => {
  const { db, post, ana } = await setup();
  const before = Date.now();
  const response = await post(ana, validReport({ context: { adapter: 'claude', model: 'opus', paneCount: 3, missionActive: true }, app: { version: '0.76.110', platform: 'darwin', arch: 'arm64', osVersion: 'Darwin 27.2.0' } }));
  assert.equal(response.status, 201);
  const body = await json(response);
  assert.deepEqual(Object.keys(body.data!).sort(), ['id', 'status']);
  assert.equal(body.data!.status, 'new');
  const row = db.sqlite.prepare('SELECT * FROM bug_reports WHERE id = ?').get(body.data!.id) as Record<string, any>;
  assert.equal(row.account_id, 'ana');
  assert.equal(row.status, 'new');
  assert.equal(row.severity, 'medium');
  assert.match(row.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(row.adapter, 'claude');
  assert.equal(row.model, 'opus');
  assert.equal(row.pane_count, 3);
  assert.equal(row.mission_active, 1);
  assert.equal(row.os_version, 'Darwin 27.2.0');
  assert.equal(row.steps, null);
  assert.equal(row.diagnostics_json, null);
  assert.ok(row.diagnostics_expires_at >= before + 180 * DAY_MS && row.diagnostics_expires_at <= Date.now() + 180 * DAY_MS, 'expira 180 dias depois da criação');
  const events = db.sqlite.prepare('SELECT kind, actor_account_id FROM bug_report_events WHERE report_id = ?').all(row.id) as Array<Record<string, string>>;
  assert.deepEqual(events.map(event => ({ ...event })), [{ kind: 'created', actor_account_id: 'ana' }]);
  db.close();
});

test('o relato nunca guarda a gravidade enviada: o cliente não decide, e o corpo com severity é recusado', async () => {
  const { db, post, ana } = await setup();
  assert.equal((await post(ana, { ...validReport(), severity: 'blocker' })).status, 400);
  db.close();
});

test('corpo acima de 64 KB é recusado com 413 ANTES de parsear (nem JSON válido precisa ser)', async () => {
  const { db, post, ana } = await setup();
  const garbage = 'x'.repeat(65 * 1024);
  assert.equal((await post(ana, garbage)).status, 413, 'lixo grande: 413, não 400');
  assert.equal((await post(ana, JSON.stringify(validReport({ description: 'y'.repeat(70 * 1024) })))).status, 413);
  const declared = await post({ ...ana, 'Content-Length': String(65 * 1024) }, '{}');
  assert.equal(declared.status, 413, 'o Content-Length declarado já basta');
  assert.equal(count(db, 'SELECT count(*) AS n FROM bug_reports'), 0);
  db.close();
});

test('JSON quebrado, campo desconhecido, consentimento ausente e limites violados dão 400 e não gravam nada', async () => {
  const { db, post, ana } = await setup();
  const cases: unknown[] = [
    '{não é json',
    '',
    { ...validReport(), extra: true },
    (() => { const { consent: _consent, ...rest } = validReport(); return rest; })(),
    validReport({ title: 'cur' }),
    validReport({ description: 'a'.repeat(4001) }),
    validReport({ category: 'seguranca' }),
    validReport({ consent: { diagnostics: 'sim' } }),
    validReport({ app: { version: 'x', platform: 'darwin', arch: 'arm64' } }),
    validReport({ consent: { diagnostics: true }, diagnostics: { events: Array.from({ length: 51 }, () => ({ t: 1, kind: 'k' })), errors: [] } }),
  ];
  for (const body of cases) {
    const response = await post(ana, body);
    assert.equal(response.status, 400, JSON.stringify(body).slice(0, 80));
    assert.equal((await json(response)).ok, false);
  }
  assert.equal(count(db, 'SELECT count(*) AS n FROM bug_reports'), 0);
  db.close();
});

test('o diagnóstico é IGNORADO sem consentimento e guardado (já limpo) com consentimento', async () => {
  const { db, post, ana } = await setup();
  const diagnostics = { events: [{ t: 1_700_000_000_000, kind: 'pty.exit', code: 'ENOENT /Users/fulano/x' }], errors: [`falhou com ${SECRET}`] };
  const without = await json(await post(ana, validReport({ consent: { diagnostics: false }, diagnostics })));
  const withConsent = await json(await post(ana, validReport({ title: 'Outro problema com consentimento', consent: { diagnostics: true }, diagnostics })));
  assert.equal((db.sqlite.prepare('SELECT diagnostics_json AS d FROM bug_reports WHERE id = ?').get(without.data!.id) as { d: string | null }).d, null);
  const stored = (db.sqlite.prepare('SELECT diagnostics_json AS d FROM bug_reports WHERE id = ?').get(withConsent.data!.id) as { d: string }).d;
  assert.doesNotMatch(stored, /fulano|AbCdEf1234567890/);
  assert.deepEqual(JSON.parse(stored), { events: [{ t: 1_700_000_000_000, kind: 'pty.exit', code: 'ENOENT /Users/[usuario]/x' }], errors: ['falhou com [oculto]'] });
  db.close();
});

test('nenhum segredo, caminho de HOME ou e-mail dos campos livres chega ao banco', async () => {
  const { db, post, ana } = await setup();
  const response = await post(ana, validReport({
    title: `Quebra com ${SECRET}`,
    description: 'Minha chave é ghp_1234567890abcdefghijklmnopqrstuvwxyz, escreva para fulano@exemplo.com. Veja /Users/fulano/dev e C:\\Users\\Maria Silva\\app.',
    steps: 'OPENAI_API_KEY=valor-super-secreto\nAuthorization: Bearer abc123DEF456ghi789',
    app: { version: '0.76.110', platform: 'win32', arch: 'x64', osVersion: 'Windows 11 C:\\Users\\Joana' },
    context: { adapter: 'claude', model: 'opus-5-6 re_AbCdEfGh_1234567890abcdefghijklmnop' },
  }));
  assert.equal(response.status, 201);
  const dump = JSON.stringify(db.sqlite.prepare('SELECT * FROM bug_reports').all());
  for (const leak of [SECRET, 'AbCdEf1234567890', 'ghp_1234567890', 'fulano', 'exemplo.com', 'Maria', 'Silva', 'valor-super-secreto', 'abc123DEF456', 'Joana', 're_AbCdEfGh']) {
    assert.ok(!dump.includes(leak), `vazou ${leak}`);
  }
  db.close();
});

test('o sexto relato na mesma hora recebe 429 em português, com Retry-After; outra conta e relatos antigos não contam', async () => {
  const { db, post, ana, bia } = await setup();
  for (let i = 1; i <= 5; i += 1) assert.equal((await post(ana, validReport({ title: `Problema numero ${i} no terminal` }))).status, 201, `relato ${i}`);
  const sixth = await post(ana, validReport({ title: 'Sexto problema no terminal' }));
  assert.equal(sixth.status, 429);
  const body = await json(sixth);
  assert.match(body.error!, /5 relatos/);
  assert.match(body.error!, /hora/);
  const retryAfter = Number(sixth.headers.get('Retry-After'));
  assert.ok(retryAfter > 0 && retryAfter <= 3600, `Retry-After ${retryAfter}`);
  assert.equal(count(db, "SELECT count(*) AS n FROM bug_reports WHERE account_id = 'ana'"), 5, 'o sexto não foi gravado');
  assert.equal(count(db, "SELECT count(*) AS n FROM bug_report_events WHERE kind = 'created'"), 5, 'e não deixou evento órfão');
  assert.equal((await post(bia, validReport())).status, 201, 'o teto é por conta');
  // Passada uma hora, os mais antigos saem da janela.
  db.sqlite.prepare("UPDATE bug_reports SET created_at = ? WHERE account_id = 'ana'").run(Date.now() - 61 * 60 * 1000);
  assert.equal((await post(ana, validReport({ title: 'Depois de uma hora de espera' }))).status, 201);
  db.close();
});

test('o teto de 5 por hora aguenta rajada paralela: nunca grava mais que cinco', async () => {
  const { db, post, ana } = await setup();
  const statuses = (await Promise.all(Array.from({ length: 9 }, (_, i) => post(ana, validReport({ title: `Rajada paralela numero ${i}` })))).then(all => all.map(response => response.status))).sort();
  assert.deepEqual(statuses, [201, 201, 201, 201, 201, 429, 429, 429, 429]);
  assert.equal(count(db, 'SELECT count(*) AS n FROM bug_reports'), 5);
  db.close();
});

test('quem está com o teste vencido ou suspenso ainda consegue reportar (o bug pode ser justamente a licença)', async () => {
  const { db, post } = await setup();
  await seedAccount(db, 'vencido', { trialDays: -3 });
  await seedAccount(db, 'suspenso', { suspended: true });
  assert.equal((await post(await nativeLogin(db, 'vencido'), validReport({ category: 'license' }))).status, 201);
  assert.equal((await post(await nativeLogin(db, 'suspenso'), validReport({ category: 'billing' }))).status, 201);
  db.close();
});

test('GET /v1/bug-reports/mine: 401 sem login; só os relatos de quem pergunta, do mais novo ao mais antigo, sem e-mail de ninguém', async () => {
  const { db, send, ana, bia } = await setup();
  assert.equal((await send('/v1/bug-reports/mine', { 'Content-Type': 'application/json' })).status, 401);
  const now = Date.now();
  const mineOld = seedReport(db, { accountId: 'ana', title: 'Meu relato antigo', createdAt: now - 5000 });
  const mineNew = seedReport(db, { accountId: 'ana', title: 'Meu relato novo', createdAt: now - 1000, status: 'triaged' });
  seedReport(db, { accountId: 'bia', title: 'Relato da Bia' });
  seedReport(db, { accountId: null, title: 'Relato sem dono' });
  const mine = await json(await send('/v1/bug-reports/mine', ana));
  assert.equal(mine.ok, true);
  assert.deepEqual((mine.data!.reports as Array<{ id: string }>).map(report => report.id), [mineNew, mineOld]);
  const dump = JSON.stringify(mine);
  assert.doesNotMatch(dump, /@/, 'nenhum e-mail na resposta do usuário');
  assert.doesNotMatch(dump, /Bia|sem dono/);
  assert.doesNotMatch(dump, /account|fingerprint|diagnostics|severity/i, 'nada de dado interno do triador');
  const first = (mine.data!.reports as Array<Record<string, unknown>>)[0]!;
  assert.deepEqual(Object.keys(first).sort(), ['createdAt', 'fixSummary', 'id', 'status', 'title']);
  assert.equal(first.status, 'triaged');
  assert.match(String(first.createdAt), /^\d{4}-\d{2}-\d{2}T/);
  const other = await json(await send('/v1/bug-reports/mine', bia));
  assert.deepEqual((other.data!.reports as Array<{ title: string }>).map(report => report.title), ['Relato da Bia']);
  db.close();
});

test('mine mostra o resumo da correção só quando o relato foi liberado, e devolve no máximo os 50 mais recentes', async () => {
  const { db, send, ana } = await setup();
  const now = Date.now();
  seedReport(db, { accountId: 'ana', title: 'Corrigido e liberado', status: 'released', fixSummary: 'Corrigimos o fechamento do terminal.', createdAt: now - 100 });
  seedReport(db, { accountId: 'ana', title: 'Correção em andamento', status: 'approved', fixSummary: 'Rascunho interno ainda não liberado.', createdAt: now - 200 });
  for (let i = 0; i < 55; i += 1) seedReport(db, { accountId: 'ana', title: `Extra ${i}`, createdAt: now - 1000 - i });
  const mine = (await json(await send('/v1/bug-reports/mine', ana))).data!.reports as Array<{ title: string; fixSummary: string | null }>;
  assert.equal(mine.length, 50);
  assert.equal(mine[0]!.title, 'Corrigido e liberado');
  assert.equal(mine[0]!.fixSummary, 'Corrigimos o fechamento do terminal.');
  assert.equal(mine[1]!.fixSummary, null, 'rascunho de correção não vaza antes de released');
  assert.doesNotMatch(JSON.stringify(mine), /Rascunho interno/);
  db.close();
});
