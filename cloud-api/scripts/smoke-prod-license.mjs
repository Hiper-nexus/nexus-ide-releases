#!/usr/bin/env node
// Prova de ponta a ponta, em PRODUÇÃO, de que "cadastro → teste de 15 dias → licença" funciona e de que a licença
// assinada pela API é aceita pela chave pública embutida no app. Se as duas chaves divergirem, todo cliente novo
// fica bloqueado: este é o teste que pega isso.
//
//   node scripts/smoke-prod-license.mjs [--pubkey ../resources/license-pubkey.pem]
//
// Cria UMA conta sintética (e-mail @nexus-e2e.invalid) com um código de login de uso único no D1 de produção, troca o
// código pelo endpoint real (/v1/auth/exchange), confere a licença e APAGA a conta (cascata) mesmo se algo falhar.
// Nada de token ou chave é impresso. Não toca em Stripe nem em conta de cliente.
import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://api.nexuside.app';
const DB = 'nexus-cloud-prod';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pubkeyArg = process.argv.indexOf('--pubkey');
const PUBKEY = resolve(ROOT, pubkeyArg > 0 ? process.argv[pubkeyArg + 1] : '../resources/license-pubkey.pem');
const DAY_MS = 86_400_000;

const b64url = (buffer) => Buffer.from(buffer).toString('base64url');
const sha256Hex = (value) => createHash('sha256').update(value).digest('hex');
const sha256B64Url = (value) => b64url(createHash('sha256').update(value).digest());

function d1(sql) {
  return execFileSync('npx', ['--no-install', 'wrangler', 'd1', 'execute', DB, '--remote', '--json', '--command', sql], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'OK  ' : 'FALHA'} ${name}${detail ? ` — ${detail}` : ''}`); return ok; };

async function main(accountId) {
  const status = (await (await fetch(`${API}/v1/public/status`)).json()).data;
  const trialDays = status.trial?.days ?? 15;
  const maxAgents = status.trial?.maxAgents ?? 6;
  check('API pronta e vendas abertas', status.ready === true && status.billing?.available === true);

  const now = Date.now();
  const verifier = b64url(randomBytes(32));
  const code = b64url(randomBytes(32));
  const email = `${accountId}@nexus-e2e.invalid`;
  d1(`INSERT INTO accounts(id,email,name,created_at,updated_at,role,trial_started_at,trial_expires_at,last_seen_at) VALUES('${accountId}','${email}','E2E sintético',${now},${now},'user',${now},${now + trialDays * DAY_MS},${now})`);
  d1(`INSERT INTO auth_codes(code_hash,account_id,expires_at,created_at,code_challenge) VALUES('${sha256Hex(code)}','${accountId}',${now + 5 * 60_000},${now},'${sha256B64Url(verifier)}')`);

  const exchange = await fetch(`${API}/v1/auth/exchange`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, code_verifier: verifier }) });
  const body = await exchange.json();
  if (!check('troca do código de login por sessão (/v1/auth/exchange)', exchange.status === 200 && body.ok === true, `HTTP ${exchange.status}`)) return;
  const reuse = await fetch(`${API}/v1/auth/exchange`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, code_verifier: verifier }) });
  check('o código de login é de uso único (reuso recusado)', reuse.status === 400);

  const token = body.data.licenca;
  const [header, payload, signature] = token.split('.');
  const publicKey = createPublicKey(readFileSync(PUBKEY, 'utf8'));
  const signed = verify(null, Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url'));
  check('licença assinada pela API É aceita pela chave pública embutida no app', signed, `chave: ${PUBKEY.replace(ROOT, '.')}`);

  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  const ttlHours = (claims.exp - claims.iat) / 3600;
  // Desenho (src/access.ts): no teste o token vem com os recursos Pro (plan=pro) e o teto de agentes do teste (limits.maxAgents).
  check('licença é de TESTE (access=trial) com recursos Pro e teto de agentes', claims.access === 'trial' && claims.plan === 'pro', `access=${claims.access} plan=${claims.plan}`);
  const daysLeft = (Date.parse(claims.trialEndsAt) - now) / DAY_MS;
  check(`o teste termina em ${trialDays} dias`, Math.abs(daysLeft - trialDays) < 0.01, `faltam ${daysLeft.toFixed(2)} dias`);
  check(`limite de ${maxAgents} agentes e sem sync na nuvem`, claims.limits?.maxAgents === maxAgents && claims.limits?.cloudSync === false, `maxAgents=${claims.limits?.maxAgents} cloudSync=${claims.limits?.cloudSync}`);
  check('validade da licença ≤ 24 h (o app renova sozinho)', ttlHours > 0 && ttlHours <= 24, `${ttlHours.toFixed(1)} h`);
  check('emissor e público certos', claims.iss === API && claims.aud === 'nexus-desktop' && claims.sub === accountId);

  const licenseRoute = await fetch(`${API}/v1/license`, { headers: { authorization: `Bearer ${body.data.session}` } });
  check('GET /v1/license com a sessão nova responde 200', licenseRoute.status === 200, `HTTP ${licenseRoute.status}`);
  const activityHeaders = { authorization: `Bearer ${body.data.session}`, 'content-type': 'application/json' };
  const activityBody = JSON.stringify({ agentStarted: true, agentWorking: true, missionCompleted: true });
  const activity = await fetch(`${API}/v1/activity`, { method: 'POST', headers: activityHeaders, body: activityBody });
  const replayActivity = await fetch(`${API}/v1/activity`, { method: 'POST', headers: activityHeaders, body: activityBody });
  check('uso mínimo do app autenticado é aceito e pode ser repetido', activity.status === 200 && replayActivity.status === 200);
  const observed = JSON.parse(d1(`SELECT (SELECT count(*) FROM account_activity WHERE account_id='${accountId}' AND first_agent_at IS NOT NULL AND first_mission_at IS NOT NULL) AS milestones,(SELECT count(*) FROM account_activity_days WHERE account_id='${accountId}') AS days`))[0].results[0];
  check('marcos e dia de uso não duplicam no replay', observed.milestones === 1 && observed.days === 1);
  const extraActivity = await fetch(`${API}/v1/activity`, { method: 'POST', headers: activityHeaders, body: JSON.stringify({ agentStarted: false, agentWorking: false, missionCompleted: false, prompt: 'fixture' }) });
  check('campos de conteúdo são recusados pela medição', extraActivity.status === 400);

  const refreshed = await fetch(`${API}/v1/auth/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refresh: body.data.refresh }) });
  check('a sessão se renova (/v1/auth/refresh)', refreshed.status === 200, `HTTP ${refreshed.status}`);
}

const accountId = `e2e-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
let failure;
try { await main(accountId); } catch (error) { failure = error; console.log(`FALHA erro inesperado — ${error instanceof Error ? error.message.split('\n')[0] : 'desconhecido'}`); }
finally {
  try {
    d1(`DELETE FROM accounts WHERE id='${accountId}'`);
    const left = JSON.parse(d1(`SELECT (SELECT count(*) FROM accounts WHERE id='${accountId}')+(SELECT count(*) FROM sessions WHERE account_id='${accountId}')+(SELECT count(*) FROM refresh_tokens WHERE account_id='${accountId}')+(SELECT count(*) FROM auth_codes WHERE account_id='${accountId}')+(SELECT count(*) FROM account_activity WHERE account_id='${accountId}')+(SELECT count(*) FROM account_activity_days WHERE account_id='${accountId}') AS rest`))[0].results[0].rest;
    check('a conta sintética e tudo que ela criou foram apagados', left === 0, `${left} linhas restantes`);
  } catch (error) { console.log(`FALHA limpeza — apague à mão: DELETE FROM accounts WHERE id='${accountId}' (${error instanceof Error ? error.message.split('\n')[0] : ''})`); results.push({ name: 'limpeza', ok: false }); }
}
const failed = results.filter((r) => !r.ok).length + (failure === undefined ? 0 : 1);
console.log(`\n${failed === 0 && failure === undefined ? 'TUDO OK' : `${failed} VERIFICAÇÃO(ÕES) FALHARAM`} (${results.length} conferências)`);
process.exit(failed === 0 && failure === undefined ? 0 : 1);
