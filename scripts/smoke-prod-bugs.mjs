#!/usr/bin/env node
// Prova de ponta a ponta, em PRODUÇÃO, das rotas de relato de bug: cria UMA conta sintética (@nexus-e2e.invalid) com um
// código de login de uso único, envia relatos pelo endpoint real, confere validação, limite de 5 por hora, listagem do
// próprio usuário e a ausência de e-mail nas respostas, e APAGA tudo (relatos, eventos e a conta) mesmo se algo falhar.
// Nada de token é impresso. Não toca em conta de cliente.   node scripts/smoke-prod-bugs.mjs
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://api.nexuside.app';
const DB = 'nexus-cloud-prod';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const b64url = (buffer) => Buffer.from(buffer).toString('base64url');
const sha256Hex = (value) => createHash('sha256').update(value).digest('hex');
const sha256B64Url = (value) => b64url(createHash('sha256').update(value).digest());
const d1 = (sql) => execFileSync('npx', ['--no-install', 'wrangler', 'd1', 'execute', DB, '--remote', '--json', '--command', sql], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'OK  ' : 'FALHA'} ${name}${detail ? ` — ${detail}` : ''}`); return ok; };
const report = (n) => ({ title: `Teste sintético de ponta a ponta ${n}`, description: 'Relato criado por scripts/smoke-prod-bugs.mjs e apagado em seguida.', category: 'other', impact: 'annoying',
  app: { version: '0.0.0-smoke', platform: 'darwin', arch: 'arm64' }, consent: { diagnostics: false } });

async function main(accountId) {
  const now = Date.now();
  const verifier = b64url(randomBytes(32));
  const code = b64url(randomBytes(32));
  d1(`INSERT INTO accounts(id,email,name,created_at,updated_at,role,trial_started_at,trial_expires_at,last_seen_at) VALUES('${accountId}','${accountId}@nexus-e2e.invalid','E2E sintético',${now},${now},'user',${now},${now + 15 * 86_400_000},${now})`);
  d1(`INSERT INTO auth_codes(code_hash,account_id,expires_at,created_at,code_challenge) VALUES('${sha256Hex(code)}','${accountId}',${now + 300_000},${now},'${sha256B64Url(verifier)}')`);
  const exchange = await fetch(`${API}/v1/auth/exchange`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, code_verifier: verifier }) });
  const session = (await exchange.json())?.data?.session;
  if (!check('sessão de teste criada pelo endpoint real', exchange.status === 200 && typeof session === 'string')) return;
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${session}` };
  const post = (body, init = {}) => fetch(`${API}/v1/bug-reports`, { method: 'POST', headers, body: JSON.stringify(body), ...init });

  check('sem login: 401', (await fetch(`${API}/v1/bug-reports`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status === 401);
  const invalid = await post({ title: 'x' });
  check('corpo inválido: 400 (esquema estrito)', invalid.status === 400, `HTTP ${invalid.status}`);
  const huge = await fetch(`${API}/v1/bug-reports`, { method: 'POST', headers, body: JSON.stringify({ ...report(0), description: 'a'.repeat(70_000) }) });
  check('corpo acima de 64 KB: 413 antes de parsear', huge.status === 413, `HTTP ${huge.status}`);
  const withSecret = await post({ ...report(1), description: 'Erro ao usar a chave sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 no home /Users/maria/projeto e e-mail maria@example.com' });
  const created = withSecret.status === 201 ? (await withSecret.json()).data : null;
  check('relato válido: 201 com id e status new', withSecret.status === 201 && created?.status === 'new' && typeof created?.id === 'string');
  const stored = JSON.parse(d1(`SELECT description FROM bug_reports WHERE id='${created?.id}'`))[0].results[0]?.description ?? '';
  check('o servidor mascarou chave, caminho do HOME e e-mail antes de gravar', !/sk-ant-api03-abcdef|maria@example\.com|\/Users\/maria/.test(stored), `gravado: ${stored.slice(0, 80)}…`);
  for (let n = 2; n <= 5; n += 1) await post(report(n));
  const sixth = await post(report(6));
  check('o 6º relato na mesma hora: 429 com Retry-After e mensagem em português', sixth.status === 429 && Number(sixth.headers.get('retry-after')) > 0, `HTTP ${sixth.status}`);
  const mine = await fetch(`${API}/v1/bug-reports/mine`, { headers });
  const text = await mine.text();
  const list = JSON.parse(text).data?.reports ?? [];
  check('GET /mine devolve os 5 relatos do próprio usuário', mine.status === 200 && list.length === 5, `${list.length} relatos`);
  check('nenhuma resposta traz e-mail de ninguém', !/@nexus-e2e\.invalid|"email"/.test(text));
  check('o admin NÃO é alcançável com sessão de app (guarda de admin)', (await fetch(`${API}/v1/admin/bug-reports`, { headers })).status === 401);
}

const accountId = `e2e-bug-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
try { await main(accountId); } catch (error) { results.push(false); console.log(`FALHA erro inesperado — ${error instanceof Error ? error.message.split('\n')[0] : 'desconhecido'}`); }
finally {
  try {
    d1(`DELETE FROM bug_reports WHERE account_id='${accountId}'`);
    d1(`DELETE FROM accounts WHERE id='${accountId}'`);
    const left = JSON.parse(d1(`SELECT (SELECT count(*) FROM bug_reports WHERE account_id='${accountId}')+(SELECT count(*) FROM accounts WHERE id='${accountId}')+(SELECT count(*) FROM sessions WHERE account_id='${accountId}') AS rest, (SELECT count(*) FROM bug_reports WHERE title LIKE 'Teste sintético de ponta a ponta%') AS orphans`))[0].results[0];
    check('relatos, sessão e conta sintéticos apagados', left.rest === 0 && left.orphans === 0, `${left.rest} linhas, ${left.orphans} relatos órfãos`);
  } catch (error) { results.push(false); console.log(`FALHA limpeza — apague à mão (${error instanceof Error ? error.message.split('\n')[0] : ''})`); }
}
const failed = results.filter(ok => !ok).length;
console.log(`\n${failed === 0 ? 'TUDO OK' : `${failed} VERIFICAÇÃO(ÕES) FALHARAM`} (${results.length} conferências)`);
process.exit(failed === 0 ? 0 : 1);
