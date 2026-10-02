import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteD1 } from './helpers/sqlite-d1.js';
import { ADMIN_EMAIL, SITE, environment, nativeLogin, seedAccount, webLogin } from './helpers/fixtures.js';
import { count, seedReport } from './helpers/bugs.js';
import { createApp } from '../src/index.js';
import { applyPatch, findReport } from '../src/bugs/admin-store.js';

type Body = { ok: boolean; error?: string; data?: Record<string, any> };
const json = async (response: Response): Promise<Body> => await response.json() as Body;
const SECOND_ADMIN = 'segunda.admin@example.test';
const LIST = '/v1/admin/bug-reports';
const PR = 'https://github.com/nexus/ide/pull/42';

async function setup() {
  const db = new SqliteD1();
  await seedAccount(db, 'admin', { admin: true });
  await seedAccount(db, 'admin2', { admin: true, email: SECOND_ADMIN });
  await seedAccount(db, 'user');
  await seedAccount(db, 'ana', { email: 'ana.reporter@example.test' });
  const env = environment(db, { ADMIN_EMAILS: `${ADMIN_EMAIL},${SECOND_ADMIN}` });
  const app = createApp();
  const call = (path: string, headers: Record<string, string>, init: { method?: string; body?: unknown } = {}) =>
    app.request(path, { method: init.method ?? 'GET', headers, ...(init.body === undefined ? {} : { body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body) }) }, env);
  const admin = await webLogin(db, 'admin');
  const get = async (path: string, headers = admin) => json(await call(path, headers));
  const patch = (id: string, body: unknown, headers = admin) => call(`${LIST}/${id}`, headers, { method: 'PATCH', body });
  const events = (id: string) => (db.sqlite.prepare('SELECT kind, actor_account_id, details_json FROM bug_report_events WHERE report_id = ? ORDER BY created_at, rowid').all(id) as Array<Record<string, string>>)
    .map(row => ({ kind: row.kind, actor: row.actor_account_id, details: JSON.parse(row.details_json) as Record<string, unknown> }));
  return { db, app, env, call, admin, get, patch, events };
}

test('as quatro rotas recusam visitante (401), usuário comum (403) e quem só tem a sessão do app (401)', async () => {
  const { db, call, patch } = await setup();
  const id = seedReport(db, { accountId: 'ana' });
  const user = await webLogin(db, 'user');
  const anonymous = { Origin: SITE, 'Content-Type': 'application/json' };
  for (const path of [LIST, `${LIST}/${id}`, `${LIST}/stats`]) {
    assert.equal((await call(path, anonymous)).status, 401, `visitante em ${path}`);
    assert.equal((await call(path, user)).status, 403, `usuário em ${path}`);
    assert.equal((await call(path, await nativeLogin(db, 'admin'))).status, 401, `Bearer do app em ${path}`);
  }
  assert.equal((await patch(id, { status: 'triaged' }, anonymous)).status, 401);
  assert.equal((await patch(id, { status: 'triaged' }, user)).status, 403);
  assert.equal(count(db, "SELECT count(*) AS n FROM bug_reports WHERE status = 'new'"), 1, 'nada mudou');
  db.close();
});

test('PATCH exige CSRF e a origem do site: sem token, token errado ou origem alheia é 403 e nada muda', async () => {
  const { db, admin, patch } = await setup();
  const id = seedReport(db, { accountId: 'ana' });
  const { 'X-CSRF-Token': _token, ...withoutCsrf } = admin;
  assert.equal((await patch(id, { status: 'triaged' }, withoutCsrf)).status, 403);
  assert.equal((await patch(id, { status: 'triaged' }, { ...admin, 'X-CSRF-Token': 'token-errado' })).status, 403);
  assert.equal((await patch(id, { status: 'triaged' }, { ...admin, Origin: 'https://evil.example' })).status, 403);
  assert.equal(count(db, "SELECT count(*) AS n FROM bug_reports WHERE status = 'new'"), 1);
  assert.equal(count(db, 'SELECT count(*) AS n FROM bug_report_events'), 0);
  db.close();
});

test('respostas do painel nunca vão para cache', async () => {
  const { db, call, admin } = await setup();
  const id = seedReport(db, { accountId: 'ana' });
  for (const path of [LIST, `${LIST}/${id}`, `${LIST}/stats`]) assert.match((await call(path, admin)).headers.get('Cache-Control') ?? '', /no-store/, path);
  db.close();
});

test('o navegador do site consegue fazer PATCH: o CORS libera o método só para a origem do site', async () => {
  const { db, app, env } = await setup();
  const preflight = await app.request(`${LIST}/x`, { method: 'OPTIONS', headers: { Origin: SITE, 'Access-Control-Request-Method': 'PATCH', 'Access-Control-Request-Headers': 'content-type,x-csrf-token' } }, env);
  assert.match(preflight.headers.get('Access-Control-Allow-Methods') ?? '', /PATCH/);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), SITE);
  const foreign = await app.request(`${LIST}/x`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'PATCH' } }, env);
  assert.equal(foreign.headers.get('Access-Control-Allow-Origin'), null);
  db.close();
});

test('lista: traz o e-mail de quem reportou, as ocorrências do mesmo fingerprint e nada de e-mail inventado', async () => {
  const { db, get } = await setup();
  const now = Date.now();
  const same = 'f'.repeat(64);
  const first = seedReport(db, { accountId: 'ana', title: 'Terminal fecha', fingerprint: same, createdAt: now - 300 });
  seedReport(db, { accountId: 'user', title: 'Terminal fecha de novo', fingerprint: same, createdAt: now - 200 });
  seedReport(db, { accountId: null, title: 'Relato de conta apagada', createdAt: now - 100 });
  db.sqlite.prepare("UPDATE accounts SET email = 'google:12345' WHERE id = 'user'").run();
  const list = (await get(LIST)).data!;
  const byTitle = Object.fromEntries((list.reports as Array<Record<string, any>>).map(report => [report.title, report]));
  assert.equal(byTitle['Terminal fecha'].reporterEmail, 'ana.reporter@example.test');
  assert.equal(byTitle['Terminal fecha'].occurrences, 2);
  assert.equal(byTitle['Terminal fecha de novo'].occurrences, 2);
  assert.equal(byTitle['Terminal fecha de novo'].reporterEmail, null, 'o provedor:id não é e-mail');
  assert.equal(byTitle['Relato de conta apagada'].reporterEmail, null);
  assert.equal(byTitle['Relato de conta apagada'].occurrences, 1);
  assert.equal(byTitle['Terminal fecha'].id, first);
  assert.deepEqual(Object.keys(byTitle['Terminal fecha']).sort(), ['appVersion', 'category', 'createdAt', 'duplicateOf', 'hasDiagnostics', 'id', 'impact', 'occurrences', 'platform', 'reporterEmail', 'severity', 'status', 'title', 'updatedAt']);
  assert.equal(list.nextCursor, null);
  db.close();
});

test('lista: filtra por status, categoria, gravidade e busca no título (sem tratar % ou _ como curinga)', async () => {
  const { db, get } = await setup();
  seedReport(db, { title: 'Terminal fecha sozinho', status: 'new', category: 'terminal', severity: 'high' });
  seedReport(db, { title: 'Licença não ativa', status: 'triaged', category: 'license', severity: 'blocker' });
  seedReport(db, { title: 'Cobrança duplicada 100% errada', status: 'new', category: 'billing', severity: 'low' });
  const titles = async (query: string) => ((await get(`${LIST}${query}`)).data!.reports as Array<{ title: string }>).map(report => report.title).sort();
  assert.deepEqual(await titles('?status=triaged'), ['Licença não ativa']);
  assert.deepEqual(await titles('?category=terminal'), ['Terminal fecha sozinho']);
  assert.deepEqual(await titles('?severity=low'), ['Cobrança duplicada 100% errada']);
  assert.deepEqual(await titles('?status=new&severity=high'), ['Terminal fecha sozinho']);
  assert.deepEqual(await titles('?q=TERMINAL'), ['Terminal fecha sozinho'], 'busca sem diferenciar caixa');
  assert.deepEqual(await titles('?q=100%25'), ['Cobrança duplicada 100% errada']);
  assert.deepEqual(await titles('?q=%25'), ['Cobrança duplicada 100% errada'], '% é texto, não curinga');
  assert.deepEqual(await titles('?q=_'), [], '_ é texto, não curinga');
  db.close();
});

test('lista: pagina por cursor (created_at + id) sem repetir nem pular item, e valida os parâmetros', async () => {
  const { db, call, admin } = await setup();
  const now = Date.now();
  const ids = Array.from({ length: 5 }, (_, i) => seedReport(db, { title: `Relato ${i}`, createdAt: now - i * 1000 }));
  seedReport(db, { title: 'Empate A', createdAt: now - 10_000, id: '00000000-0000-4000-8000-00000000000a' });
  seedReport(db, { title: 'Empate B', createdAt: now - 10_000, id: '00000000-0000-4000-8000-00000000000b' });
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 10; page += 1) {
    const body: Body = await json(await call(`${LIST}?limit=3${cursor ? `&cursor=${cursor}` : ''}`, admin));
    seen.push(...(body.data!.reports as Array<{ title: string }>).map(report => report.title));
    cursor = body.data!.nextCursor as string | null;
    if (cursor === null) break;
  }
  assert.deepEqual(seen, ['Relato 0', 'Relato 1', 'Relato 2', 'Relato 3', 'Relato 4', 'Empate B', 'Empate A']);
  assert.equal(ids.length, 5);
  assert.equal((await call(`${LIST}?limit=101`, admin)).status, 400);
  assert.equal((await call(`${LIST}?limit=0`, admin)).status, 400);
  assert.equal((await call(`${LIST}?status=aberto`, admin)).status, 400);
  assert.equal((await call(`${LIST}?cursor=%25%25`, admin)).status, 400);
  assert.equal((await call(`${LIST}?cursor=${btoa('lixo')}`, admin)).status, 400);
  assert.equal((await call(`${LIST}?desconhecido=1`, admin)).status, 400);
  assert.equal(((await json(await call(`${LIST}?limit=100`, admin))).data!.reports as unknown[]).length, 7);
  db.close();
});

test('detalhe: relato completo com contexto, diagnóstico, linha do tempo em ordem e e-mails SÓ aqui; 404 para id desconhecido', async () => {
  const { db, get, patch } = await setup();
  const id = seedReport(db, { accountId: 'ana', title: 'Terminal fecha', diagnosticsJson: JSON.stringify({ events: [{ t: 1, kind: 'pty.exit' }], errors: ['boom'] }) });
  db.sqlite.prepare("UPDATE bug_reports SET steps = 'passo 1', adapter = 'claude', model = 'opus', pane_count = 3, mission_active = 1, os_version = 'Darwin 27' WHERE id = ?").run(id);
  assert.equal((await patch(id, { status: 'triaged', note: 'Reproduzi aqui.' })).status, 200);
  const { report, events } = (await get(`${LIST}/${id}`)).data! as { report: Record<string, any>; events: Array<Record<string, any>> };
  assert.equal(report.id, id);
  assert.equal(report.description, 'Descrição de teste do relato.');
  assert.equal(report.steps, 'passo 1');
  assert.deepEqual(report.context, { adapter: 'claude', model: 'opus', paneCount: 3, missionActive: true });
  assert.equal(report.osVersion, 'Darwin 27');
  assert.deepEqual(report.diagnostics, { events: [{ t: 1, kind: 'pty.exit' }], errors: ['boom'] });
  assert.equal(report.reporter.email, 'ana.reporter@example.test');
  assert.equal(report.reporter.id, 'ana');
  assert.equal(report.occurrences, 1);
  assert.match(report.diagnosticsExpiresAt, /^\d{4}-/);
  assert.deepEqual(events.map(event => event.kind), ['status_changed', 'note']);
  assert.equal(events[0]!.actor.email, ADMIN_EMAIL);
  assert.deepEqual(events[1]!.details, { note: 'Reproduzi aqui.' });
  assert.equal((await get(`${LIST}/${crypto.randomUUID()}`).then(body => body.ok)), false);
  db.close();
});

test('detalhe: 404 para id inexistente e diagnóstico nulo depois que a retenção o zerou', async () => {
  const { db, call, admin, get } = await setup();
  assert.equal((await call(`${LIST}/${crypto.randomUUID()}`, admin)).status, 404);
  const id = seedReport(db, { accountId: 'ana', diagnosticsJson: null });
  assert.equal((await get(`${LIST}/${id}`)).data!.report.diagnostics, null);
  db.close();
});

test('stats: conta por status, por categoria e os ABERTOS por gravidade, com zeros nas chaves sem relato (e /stats não vira id)', async () => {
  const { db, call, admin } = await setup();
  seedReport(db, { status: 'new', category: 'ui', severity: 'high' });
  seedReport(db, { status: 'new', category: 'ui', severity: 'low' });
  seedReport(db, { status: 'triaged', category: 'crash', severity: 'blocker' });
  seedReport(db, { status: 'released', category: 'crash', severity: 'blocker' });
  seedReport(db, { status: 'wont_fix', category: 'other', severity: 'high' });
  const response = await call(`${LIST}/stats`, admin);
  assert.equal(response.status, 200);
  const data = (await json(response)).data!;
  assert.equal(data.total, 5);
  assert.deepEqual(data.byStatus, { new: 2, triaged: 1, needs_info: 0, fix_proposed: 0, approved: 0, fixed: 0, released: 1, wont_fix: 1, duplicate: 0 });
  assert.deepEqual(data.byCategory, { crash: 2, terminal: 0, agents: 0, license: 0, billing: 0, ui: 2, performance: 0, other: 1 });
  assert.deepEqual(data.openBySeverity, { low: 1, medium: 0, high: 1, blocker: 1 }, 'liberado e descartado não são abertos');
  db.close();
});

test('PATCH: triagem registra evento com o admin, atualiza updated_at e devolve o relato com a linha do tempo', async () => {
  const { db, patch, events } = await setup();
  const id = seedReport(db, { accountId: 'ana', createdAt: Date.now() - 10_000 });
  const before = (db.sqlite.prepare('SELECT updated_at FROM bug_reports WHERE id = ?').get(id) as { updated_at: number }).updated_at;
  const response = await patch(id, { status: 'triaged' });
  assert.equal(response.status, 200);
  const body = await json(response);
  assert.equal(body.data!.report.status, 'triaged');
  assert.deepEqual(body.data!.events.map((event: { kind: string }) => event.kind), ['status_changed']);
  assert.deepEqual(events(id), [{ kind: 'status_changed', actor: 'admin', details: { from: 'new', to: 'triaged' } }]);
  const after = (db.sqlite.prepare('SELECT updated_at FROM bug_reports WHERE id = ?').get(id) as { updated_at: number }).updated_at;
  assert.ok(after > before, 'updated_at avançou');
  db.close();
});

test('PATCH: transição ilegal é 409 e não grava nada (new->released, new->approved, triaged->approved, fix_proposed->released, mesmo status)', async () => {
  const { db, patch, events } = await setup();
  const cases: Array<[string, string]> = [['new', 'released'], ['new', 'approved'], ['new', 'fix_proposed'], ['triaged', 'approved'], ['triaged', 'released'], ['fix_proposed', 'released'], ['needs_info', 'approved'], ['new', 'new'], ['released', 'approved'], ['wont_fix', 'approved']];
  for (const [from, to] of cases) {
    const id = seedReport(db, { accountId: 'ana', status: from });
    const response = await patch(id, { status: to });
    assert.equal(response.status, 409, `${from} -> ${to}`);
    assert.match((await json(response)).error!, /status|já está|permitida/i);
    assert.equal((db.sqlite.prepare('SELECT status FROM bug_reports WHERE id = ?').get(id) as { status: string }).status, from);
    assert.deepEqual(events(id), []);
  }
  db.close();
});

test('PATCH: o caminho completo até released funciona e a APROVAÇÃO grava o admin que autorizou e o que foi aprovado', async () => {
  const { db, app, env, admin, patch, events, call } = await setup();
  const id = seedReport(db, { accountId: 'ana', title: 'Terminal fecha' });
  assert.equal((await patch(id, { status: 'triaged' })).status, 200);
  assert.equal((await patch(id, { status: 'fix_proposed', fixSummary: 'Corrigido o fechamento do terminal ao abrir 3 painéis.', fixPrUrl: PR })).status, 200);
  // A aprovação é de uma pessoa: um segundo admin autoriza, e é ele quem fica registrado.
  const second = await webLogin(db, 'admin2');
  const approved = await patch(id, { status: 'approved' }, second);
  assert.equal(approved.status, 200);
  const approval = events(id).find(event => event.kind === 'approved')!;
  assert.equal(approval.actor, 'admin2', 'o evento approved aponta quem autorizou');
  assert.deepEqual(approval.details, { from: 'fix_proposed', to: 'approved', fixSummary: 'Corrigido o fechamento do terminal ao abrir 3 painéis.', fixPrUrl: PR });
  assert.equal((await patch(id, { status: 'fixed' })).status, 200);
  assert.equal((await patch(id, { status: 'released' })).status, 200);
  assert.deepEqual(events(id).map(event => event.kind), ['status_changed', 'fix_proposed', 'note', 'approved', 'status_changed', 'released']);
  // E agora o autor do relato vê o resumo da correção.
  const mine = await app.request('/v1/bug-reports/mine', { headers: await nativeLogin(db, 'ana') }, env);
  const first = ((await json(mine)).data!.reports as Array<{ status: string; fixSummary: string }>)[0]!;
  assert.equal(first.status, 'released');
  assert.match(first.fixSummary, /Corrigido o fechamento/);
  void admin; void call;
  db.close();
});

test('PATCH: a aprovação não pode ser pulada nem por quem não é admin', async () => {
  const { db, patch } = await setup();
  const id = seedReport(db, { accountId: 'ana', status: 'fix_proposed' });
  assert.equal((await patch(id, { status: 'approved' }, await webLogin(db, 'user'))).status, 403);
  assert.equal((await patch(id, { status: 'released' })).status, 409);
  assert.equal((db.sqlite.prepare('SELECT status FROM bug_reports WHERE id = ?').get(id) as { status: string }).status, 'fix_proposed');
  assert.equal(count(db, "SELECT count(*) AS n FROM bug_report_events WHERE kind = 'approved'"), 0);
  db.close();
});

test('PATCH: recusar a proposta ou retirar a aprovação vira evento rejected', async () => {
  const { db, patch, events } = await setup();
  const proposed = seedReport(db, { status: 'fix_proposed' });
  const approved = seedReport(db, { status: 'approved' });
  assert.equal((await patch(proposed, { status: 'triaged', note: 'A correção mexe no módulo errado.' })).status, 200);
  assert.equal((await patch(approved, { status: 'fix_proposed' })).status, 200);
  assert.deepEqual(events(proposed).map(event => event.kind), ['rejected', 'note']);
  assert.deepEqual(events(approved).map(event => event.kind), ['rejected']);
  db.close();
});

test('PATCH: gravidade e nota viram eventos próprios; gravidade igual à atual é ignorada e sem mudança nenhuma é 409', async () => {
  const { db, patch, events } = await setup();
  const id = seedReport(db, { severity: 'medium' });
  assert.equal((await patch(id, { severity: 'blocker', note: 'Bloqueia o trabalho da pessoa.' })).status, 200);
  assert.deepEqual(events(id), [
    { kind: 'severity_changed', actor: 'admin', details: { from: 'medium', to: 'blocker' } },
    { kind: 'note', actor: 'admin', details: { note: 'Bloqueia o trabalho da pessoa.' } },
  ]);
  assert.equal((await patch(id, { severity: 'blocker' })).status, 409, 'nada mudou');
  assert.equal(count(db, 'SELECT count(*) AS n FROM bug_report_events'), 2);
  db.close();
});

test('PATCH: a nota do admin também passa pela limpeza de segredos', async () => {
  const { db, patch, events } = await setup();
  const id = seedReport(db);
  await patch(id, { note: 'Cliente colou sk-proj-AbCdEf1234567890abcdef1234567890 no chat, de /Users/fulano/x' });
  assert.doesNotMatch(JSON.stringify(events(id)), /AbCdEf1234567890|fulano/);
  db.close();
});

test('PATCH: duplicata exige o original (existente, diferente do próprio e que não seja duplicata), e reabrir limpa o vínculo', async () => {
  const { db, patch, events } = await setup();
  const original = seedReport(db, { title: 'Original' });
  const copy = seedReport(db, { title: 'Cópia' });
  const other = seedReport(db, { title: 'Outra cópia' });
  assert.equal((await patch(copy, { status: 'duplicate' })).status, 400, 'falta duplicateOf');
  assert.equal((await patch(copy, { duplicateOf: original })).status, 400, 'duplicateOf sem status duplicate');
  assert.equal((await patch(copy, { status: 'duplicate', duplicateOf: copy })).status, 400, 'não é duplicata de si mesmo');
  assert.equal((await patch(copy, { status: 'duplicate', duplicateOf: crypto.randomUUID() })).status, 404, 'original inexistente');
  assert.equal((await patch(copy, { status: 'duplicate', duplicateOf: original })).status, 200);
  assert.equal((db.sqlite.prepare('SELECT duplicate_of FROM bug_reports WHERE id = ?').get(copy) as { duplicate_of: string }).duplicate_of, original);
  assert.deepEqual(events(copy), [{ kind: 'duplicate_marked', actor: 'admin', details: { from: 'new', to: 'duplicate', duplicateOf: original } }]);
  assert.equal((await patch(other, { status: 'duplicate', duplicateOf: copy })).status, 409, 'o alvo já é duplicata: aponte para o original');
  assert.equal((await patch(copy, { status: 'triaged' })).status, 200);
  assert.equal((db.sqlite.prepare('SELECT duplicate_of FROM bug_reports WHERE id = ?').get(copy) as { duplicate_of: string | null }).duplicate_of, null);
  db.close();
});

test('PATCH: corpo estrito (campo desconhecido, vazio, URL http, gravidade inválida) é 400, id desconhecido é 404, corpo gigante é 413', async () => {
  const { db, patch } = await setup();
  const id = seedReport(db);
  for (const body of [{ status: 'triaged', extra: 1 }, {}, { fixPrUrl: 'http://github.com/x/y/pull/1' }, { fixPrUrl: 'javascript:alert(1)' }, { severity: 'critical' }, { note: 'a'.repeat(2001) }, '{quebrado']) {
    assert.equal((await patch(id, body)).status, 400, JSON.stringify(body).slice(0, 60));
  }
  assert.equal((await patch(crypto.randomUUID(), { status: 'triaged' })).status, 404);
  assert.equal((await patch(id, 'x'.repeat(40 * 1024))).status, 413);
  assert.equal(count(db, 'SELECT count(*) AS n FROM bug_report_events'), 0);
  db.close();
});

/** Roda `effect` uma vez, logo depois da primeira instrução que casa com `pattern`: simula o outro admin chegando no meio. */
function interleave(db: SqliteD1, pattern: RegExp, effect: () => Promise<void>, nth = 1): SqliteD1 {
  let armed = true;
  let seen = 0;
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
    get(target, property) {
      if (property === 'bind') return (...values: unknown[]) => wrap(target.bind(...values));
      if (property !== 'first' && property !== 'run' && property !== 'all') return Reflect.get(target, property);
      return async (...args: unknown[]) => {
        const result = await (Reflect.get(target, property) as (...inner: unknown[]) => Promise<unknown>).apply(target, args);
        if (armed && ++seen === nth) { armed = false; await effect(); }
        return result;
      };
    },
  });
  return new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') return (query: string) => armed && pattern.test(query) ? wrap(target.prepare(query)) : target.prepare(query);
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

test('PATCH: se outro admin mudar o relato DEPOIS da leitura, quem chegou atrasado recebe 409 e não deixa evento nem altera a linha', async () => {
  const { db, app, env, admin, patch, events } = await setup();
  const id = seedReport(db, { accountId: 'ana' });
  const racing = interleave(db, /FROM bug_reports WHERE id=\?$/, async () => { assert.equal((await patch(id, { status: 'needs_info' }, await webLogin(db, 'admin2'))).status, 200); });
  const late = await app.request(`${LIST}/${id}`, { method: 'PATCH', headers: admin, body: JSON.stringify({ status: 'triaged' }) }, { ...env, DB: racing } as CloudflareBindings);
  assert.equal(late.status, 409);
  assert.match((await json(late)).error!, /alterado por outra pessoa/);
  assert.equal((db.sqlite.prepare('SELECT status FROM bug_reports WHERE id = ?').get(id) as { status: string }).status, 'needs_info');
  assert.deepEqual(events(id), [{ kind: 'status_changed', actor: 'admin2', details: { from: 'new', to: 'needs_info' } }], 'só o vencedor deixa evento');
  db.close();
});

test('PATCH: duas mudanças simultâneas nunca deixam o relato em estado inconsistente', async () => {
  const { db, patch } = await setup();
  const id = seedReport(db);
  const [first, second] = await Promise.all([patch(id, { status: 'triaged' }), patch(id, { status: 'needs_info' })]);
  assert.ok([first.status, second.status].every(status => status === 200 || status === 409));
  const finalStatus = (db.sqlite.prepare('SELECT status FROM bug_reports WHERE id = ?').get(id) as { status: string }).status;
  assert.equal(count(db, 'SELECT count(*) AS n FROM bug_report_events'), [first.status, second.status].filter(status => status === 200).length);
  assert.ok(['triaged', 'needs_info'].includes(finalStatus));
  db.close();
});

test('PATCH: corrigir só o resumo ou a URL da correção fica registrado como nota e vale em qualquer status', async () => {
  const { db, patch, events } = await setup();
  const id = seedReport(db, { status: 'triaged' });
  assert.equal((await patch(id, { fixPrUrl: PR })).status, 200);
  const row = db.sqlite.prepare('SELECT fix_pr_url, status FROM bug_reports WHERE id = ?').get(id) as { fix_pr_url: string; status: string };
  assert.deepEqual({ ...row }, { fix_pr_url: PR, status: 'triaged' });
  assert.deepEqual(events(id), [{ kind: 'note', actor: 'admin', details: { updated: ['fixPrUrl'] } }]);
  db.close();
});

test('PATCH: propor ou aprovar uma correção exige o resumo dela (a aprovação tem de autorizar algo concreto)', async () => {
  const { db, patch, events } = await setup();
  const triaged = seedReport(db, { status: 'triaged' });
  assert.equal((await patch(triaged, { status: 'fix_proposed' })).status, 400, 'proposta sem resumo');
  assert.equal((await patch(triaged, { status: 'fix_proposed', fixSummary: 'Corrige o fechamento do terminal.' })).status, 200);
  const empty = seedReport(db, { status: 'fix_proposed' });
  const refused = await patch(empty, { status: 'approved' });
  assert.equal(refused.status, 400, 'aprovação sem resumo');
  assert.match((await json(refused)).error!, /fixSummary/);
  assert.deepEqual(events(empty), []);
  assert.equal((await patch(empty, { status: 'approved', fixSummary: 'Resumo informado na própria aprovação.' })).status, 200);
  assert.deepEqual(events(empty).find(event => event.kind === 'approved')!.details, { from: 'fix_proposed', to: 'approved', fixSummary: 'Resumo informado na própria aprovação.', fixPrUrl: null });
  db.close();
});

test('PATCH: depois de aprovada, a correção fica TRAVADA (o que foi aprovado não muda sem revogar a aprovação)', async () => {
  const { db, patch, events } = await setup();
  const id = seedReport(db, { status: 'approved', fixSummary: 'Resumo aprovado.', fixPrUrl: PR });
  const swap = await patch(id, { fixPrUrl: 'https://github.com/outro/repo/pull/9' });
  assert.equal(swap.status, 409);
  assert.match((await json(swap)).error!, /aprovad/i);
  assert.equal((await patch(id, { fixSummary: 'Outro resumo, depois da aprovação.' })).status, 409);
  assert.equal((await patch(id, { status: 'released', fixPrUrl: 'https://github.com/outro/repo/pull/9' })).status, 409, 'nem trocando junto com a liberação');
  const row = db.sqlite.prepare('SELECT fix_summary, fix_pr_url, status FROM bug_reports WHERE id = ?').get(id) as Record<string, string>;
  assert.deepEqual({ ...row }, { fix_summary: 'Resumo aprovado.', fix_pr_url: PR, status: 'approved' });
  assert.deepEqual(events(id), []);
  // Os mesmos valores, uma nota e a liberação seguem permitidos; para mudar a correção é preciso retirar a aprovação.
  assert.equal((await patch(id, { fixSummary: 'Resumo aprovado.', note: 'Conferido.' })).status, 200);
  assert.equal((await patch(id, { status: 'fix_proposed', fixSummary: 'Resumo novo, a aprovar de novo.' })).status, 200);
  assert.equal((db.sqlite.prepare('SELECT status FROM bug_reports WHERE id = ?').get(id) as { status: string }).status, 'fix_proposed');
  db.close();
});

test('PATCH: um original que já tem duplicatas não vira duplicata (evita cadeias); sem filhos, vira', async () => {
  const { db, patch } = await setup();
  const original = seedReport(db, { title: 'Original' });
  const child = seedReport(db, { title: 'Filho', status: 'duplicate', duplicateOf: original });
  const root = seedReport(db, { title: 'Outra raiz' });
  const refused = await patch(original, { status: 'duplicate', duplicateOf: root });
  assert.equal(refused.status, 409);
  assert.match((await json(refused)).error!, /duplicata/i);
  assert.equal((db.sqlite.prepare('SELECT status FROM bug_reports WHERE id = ?').get(original) as { status: string }).status, 'new');
  assert.equal((await patch(child, { status: 'triaged' })).status, 200, 'solta o filho');
  assert.equal((await patch(original, { status: 'duplicate', duplicateOf: root })).status, 200, 'agora sem filhos');
  db.close();
});

test('PATCH: se o original virar duplicata no meio do caminho, quem chegou atrasado recebe 409 (sem ciclo A<->B)', async () => {
  const { db, app, env, admin, patch, events } = await setup();
  const a = seedReport(db, { title: 'A' });
  const b = seedReport(db, { title: 'B' });
  const c = seedReport(db, { title: 'C' });
  // A pede para ser duplicata de B; depois de A ler o próprio relato E o original B, B vira duplicata de C.
  const racing = interleave(db, /FROM bug_reports WHERE id=\?$/, async () => { assert.equal((await patch(b, { status: 'duplicate', duplicateOf: c })).status, 200); }, 2);
  const late = await app.request(`${LIST}/${a}`, { method: 'PATCH', headers: admin, body: JSON.stringify({ status: 'duplicate', duplicateOf: b }) }, { ...env, DB: racing } as CloudflareBindings);
  assert.equal(late.status, 409);
  assert.equal((db.sqlite.prepare('SELECT status, duplicate_of FROM bug_reports WHERE id = ?').get(a) as { status: string }).status, 'new');
  assert.deepEqual(events(a), []);
  db.close();
});

test('applyPatch recusa um nome de coluna que não esteja na lista fixa (nada de SQL montado com texto de fora)', async () => {
  const { db } = await setup();
  const id = seedReport(db);
  const current = (await findReport(db, id))!;
  const forged = { columns: { 'status=status, severity': 'blocker' }, events: [] } as never;
  await assert.rejects(applyPatch(db, current, forged, 'admin', Date.now()), /coluna/i);
  assert.equal((db.sqlite.prepare('SELECT severity FROM bug_reports WHERE id = ?').get(id) as { severity: string }).severity, 'medium');
  db.close();
});
