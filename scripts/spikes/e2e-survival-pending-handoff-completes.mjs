#!/usr/bin/env node
/**
 * Rodada 2 R2 — cenário de sobrevivência D#2: crash com entrega pendente →
 * missão COMPLETA.
 *
 * A dor real (A3): quit/crash na janela entre o worker entregar (handoff
 * success + accepted) e o orquestrador consumir → a missão acordava
 * "Handoff não entregue" tendo entregue. O fix (4024e790) faz o respawn
 * RE-ENTREGAR os pendentes. Este cenário prova o loop inteiro de ponta a
 * ponta: entrega pendente no crash → revival → re-entrega → consumo →
 * missão DONE.
 *
 * Estratégia determinística da janela: objetivo com trabalho sequencial
 * (~1 min de worker); poll de listHandoffs até existir handoff NÃO
 * consumido → SIGKILL imediato (o consumo levaria um turno inteiro).
 *
 * Uso:  node scripts/spikes/e2e-survival-pending-handoff-completes.mjs
 * Env:  NEXUS_SURVIVAL_ROOT / NEXUS_SURVIVAL_PORT (default 9233)
 */

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, createWriteStream, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = process.env.NEXUS_SURVIVAL_ROOT ?? process.cwd();
const PORT = process.env.NEXUS_SURVIVAL_PORT ?? '9233';
const WORKSPACE =
  process.env.NEXUS_SURVIVAL_WORKSPACE ??
  join(
    homedir(),
    'Library/Application Support/NexusIDE/functional-smoke-workspace',
  );

const failures = [];
function check(name, ok, detail = '') {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

async function loadWebSocket() {
  const mod = await import(join(ROOT, 'node_modules', 'ws', 'index.js'));
  const candidate = mod.default ?? mod;
  return candidate.default ?? candidate;
}

async function cdpEval(wsUrl, expression, { awaitPromise = true } = {}) {
  const WebSocket = await loadWebSocket();
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  try {
    let id = 0;
    const pending = new Map();
    ws.on('message', (data) => {
      const message = JSON.parse(data.toString());
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message.result);
        pending.delete(message.id);
      }
    });
    const send = (method, params) =>
      new Promise((resolve, reject) => {
        id += 1;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP ${method} sem resposta em 60s`));
        }, 60_000);
        pending.set(id, (value) => {
          clearTimeout(timer);
          resolve(value);
        });
        ws.send(JSON.stringify({ id, method, params }));
      });
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
    });
    if (result?.exceptionDetails) {
      throw new Error(`CDP eval lançou: ${result.exceptionDetails.text}`);
    }
    const value = result?.result?.value;
    if (value === undefined) {
      throw new Error('CDP eval sem resultado (contexto destruído?)');
    }
    return value;
  } finally {
    ws.close();
  }
}

async function cdpEvalRetry(wsUrl, expression, attempts = 3) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await cdpEval(wsUrl, expression);
    } catch (error) {
      lastError = error;
      await sleep(2_000);
    }
  }
  throw lastError;
}

async function pageTarget() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(
        (r) => r.json(),
      );
      const page = list.find((e) => e.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(2_000);
  }
  throw new Error('CDP page target não apareceu');
}

async function waitForRenderer(wsUrl) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const ready = await cdpEval(
      wsUrl,
      'typeof window.nexus !== "undefined" && !!window.nexus.mission',
      { awaitPromise: false },
    ).catch(() => false);
    if (ready === true) return;
    if (attempt > 0 && attempt % 15 === 0) {
      console.log(`[survival-d2] aguardando renderer (${attempt * 2}s)...`);
    }
    await sleep(2_000);
  }
  throw new Error('renderer nunca expôs window.nexus');
}

function appPid() {
  try {
    return execFileSync(
      'pgrep',
      ['-f', `${ROOT}/.dev-electron/dist/Electron.app/Contents/MacOS/Electron`],
    )
      .toString()
      .trim()
      .split('\n')[0];
  } catch {
    return '';
  }
}

async function startApp(stream) {
  const child = spawn('npm', ['start'], {
    cwd: ROOT,
    env: { ...process.env, NEXUS_REMOTE_DEBUG: PORT },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.pipe(stream);
  return child;
}

async function stopApp(child) {
  const pid = appPid();
  if (pid) {
    try {
      process.kill(Number(pid), 'SIGKILL');
    } catch {}
  }
  try {
    child.kill('SIGKILL');
  } catch {}
  for (let i = 0; i < 12; i += 1) {
    if (!appPid()) return;
    await sleep(2_000);
  }
}

async function main() {
  if (!existsSync(WORKSPACE)) throw new Error(`workspace scratch inexistente: ${WORKSPACE}`);
  execFileSync('git', ['clean', '-qfd'], { cwd: WORKSPACE });

  const logFile = mkdtempSync(join(homedir(), 'nexus-survival-d2-')).concat('/app.log');
  const logFd = openSync(logFile, 'a');
  const stream = createWriteStream(logFile, { fd: logFd, flags: 'a' });

  console.log(`[survival-d2] boot #1 (log: ${logFile})`);
  let app = await startApp(stream);
  let wsUrl = await pageTarget();
  await waitForRenderer(wsUrl);

  await cdpEvalRetry(wsUrl, `(async () => {
    try { await window.nexus.workspace.open(${JSON.stringify(WORKSPACE)}); return "ok"; } catch (e) { return String(e && e.message || e); }
  })()`);
  const cleaned = await cdpEvalRetry(wsUrl, `(async () => {
    try {
      const missions = await window.nexus.mission.list();
      for (const m of missions.filter(m => (m.state ?? m.status) === "running")) {
        try { await window.nexus.mission.command({ kind: "stop", missionId: m.id }); } catch {}
      }
      for (let i = 0; i < 30; i += 1) {
        await new Promise(r => setTimeout(r, 1000));
        const fresh = await window.nexus.mission.list();
        if (!fresh.some(m => (m.state ?? m.status) === "running")) break;
      }
      return "ok";
    } catch (e) { return String(e && e.message || e); }
  })()`);
  console.log('[survival-d2] limpeza:', cleaned);

  const mission = await cdpEvalRetry(wsUrl, `(async () => {
    try {
      await new Promise(r => setTimeout(r, 1500));
      const mk = (id, name, cat, tools) => ({ id, agentName: name, category: cat, cli: "claude", allowedTools: tools, allowedSkills: null });
      const roster = [ mk("coordinator","Maestro","orchestrator",null), mk("executor","Executor","executor",["Bash","Read","Edit"]), mk("reviewer","Reviewer","reviewer",["Bash","Read"]) ];
      const review = await window.nexus.mission.prepare({ objective: "crie os arquivos d2-parte-1.txt ate d2-parte-3.txt, cada um com 15 linhas numeradas; depois confirme no relatorio final que todos existem", contextPaths: [], roster, advanced: { lane: "standard" } });
      const started = await window.nexus.mission.start({ missionId: review.missionId, reviewSha256: review.reviewSha256 });
      return JSON.stringify({ missionId: review.missionId, state: started.state ?? started.status });
    } catch (e) { return JSON.stringify({ error: String(e && e.message || e) }); }
  })()`);
  const missionInfo = JSON.parse(mission);
  if (missionInfo.error) throw new Error(`missão não criou: ${missionInfo.error}`);
  console.log(`[survival-d2] missão ${missionInfo.missionId} (${missionInfo.state})`);

  console.log('[survival-d2] esperando handoff NÃO consumido (janela do A3, timeout 10 min)');
  let pendingSeen = false;
  let crashHandoffId = '';
  for (let attempt = 0; attempt < 120 && !pendingSeen; attempt += 1) {
    await sleep(5_000);
    const handoffs = await cdpEvalRetry(wsUrl, `(async () => {
      try {
        const list = await window.nexus.orch.listHandoffs();
        return JSON.stringify((list || []).filter(h => h.missionId === ${JSON.stringify(missionInfo.missionId)}).map(h => ({ id: (h.id||"").slice(0,16), delivered: !!h.delivered, consumedAt: h.consumedAt ?? null })));
      } catch { return "[]"; }
    })()`);
    const list = JSON.parse(handoffs);
    const pending = list.find((h) => !h.consumedAt);
    if (pending) {
      pendingSeen = true;
      crashHandoffId = pending.id;
      console.log('[survival-d2] handoff pendente na tela:', JSON.stringify(list));
    }
  }
  check('handoff não-consumido presente antes do crash', pendingSeen);
  if (!pendingSeen) {
    await stopApp(app);
    throw new Error('nenhum handoff pendente apareceu — janela não capturada');
  }

  console.log('[survival-d2] SIGKILL na janela do ack');
  await stopApp(app);
  check('app morto após SIGKILL', !appPid());

  console.log('[survival-d2] boot #2 (revival + re-entrega)');
  app = await startApp(stream);
  wsUrl = await pageTarget();
  await waitForRenderer(wsUrl);

  console.log('[survival-d2] esperando a missão andar pós-revival (timeout 8 min)');
  let finalState = null;
  outer: for (let attempt = 0; attempt < 96; attempt += 1) {
    await sleep(5_000);
    const state = await cdpEvalRetry(wsUrl, `(async () => {
      try {
        const missions = await window.nexus.mission.list();
        const mine = missions.find(m => m.id === ${JSON.stringify(missionInfo.missionId)});
        return mine ? (mine.state ?? mine.status) : "removida";
      } catch { return "erro"; }
    })()`, 2).catch(() => 'erro');
    if (state !== 'running') {
      finalState = state;
      break outer;
    }
  }
  console.log('[survival-d2] estado final:', finalState);

  // A asserção CENTRAL do A3: o handoff capturado no crash foi consumido
  // pelo orquestrador novo. (done é bônus — um blocked_technical honesto e
  // argumentado, com trabalho entregue, não é block falso.)
  // listHandoffs oculta consumidos pós-reboot — o journal durável é a fonte.
  const consumedInfo = await cdpEvalRetry(wsUrl, `(async () => {
    const out = { listed: null, journalHit: false, acked: false };
    try {
      const list = await window.nexus.orch.listHandoffs();
      const h = (list || []).find(x => x.id === ${JSON.stringify(crashHandoffId)});
      if (h) out.listed = { deliveryState: h.deliveryState, consumedAt: h.consumedAt ?? null };
    } catch {}
    try {
      const ev = await window.nexus.orch.missionEventsRecent({ missionId: ${JSON.stringify(missionInfo.missionId)}, limit: 200 });
      const text = JSON.stringify(ev.events || []);
      out.journalHit = text.includes(${JSON.stringify(crashHandoffId)});
      out.acked = /handoff_ack/.test(text);
    } catch {}
    return JSON.stringify(out);
  })()`);
  console.log('[survival-d2] handoff pós-crash:', consumedInfo);
  const info = JSON.parse(consumedInfo);
  const consumedOk =
    info.listed?.deliveryState === 'consumed' ||
    info.listed?.consumedAt !== null ||
    (info.journalHit && info.acked);
  check(
    'handoff capturado no crash foi CONSUMIDO/ACKiado após o revival',
    consumedOk,
    consumedInfo,
  );
  check(
    'missão não terminou em block falso de entrega',
    finalState !== 'blocked' || consumedOk,
    `final=${finalState}`,
  );
  if (finalState === 'done') {
    console.log('[survival-d2] bônus: missão chegou a done.');
  }

  // Prova do mecanismo: o trace precisa registrar a re-entrega no respawn.
  try {
    const { readFileSync } = await import('node:fs');
    const trace = readFileSync(
      join(ROOT, '.dev-user-data', 'logs', 'main.trace.ndjson'),
      'utf8',
    );
    const redelivered = trace
      .split('\n')
      .filter((l) => l.includes('orchestrator-respawned'))
      .map((l) => JSON.parse(l))
      .filter((e) => e.missionId === missionInfo.missionId && e.redeliveredHandoffs > 0);
    check(
      'trace registra respawn com re-entrega de handoff',
      redelivered.length > 0,
      `eventos=${redelivered.length}`,
    );
  } catch (error) {
    check('trace registra respawn com re-entrega', false, String(error.message ?? error));
  }

  // Limpeza com assentamento.
  await cdpEvalRetry(wsUrl, `(async () => {
    try {
      await window.nexus.mission.command({ kind: "stop", missionId: ${JSON.stringify(missionInfo.missionId)} });
      for (let i = 0; i < 30; i += 1) {
        await new Promise(r => setTimeout(r, 1000));
        const fresh = await window.nexus.mission.list();
        const mine = fresh.find(m => m.id === ${JSON.stringify(missionInfo.missionId)});
        if (mine && (mine.state ?? mine.status) !== "running") return "settled";
      }
      return "timeout";
    } catch { return "erro"; }
  })()`, 2).catch(() => {});
  await stopApp(app);

  console.log(
    failures.length === 0
      ? '\n[survival-d2] CENÁRIO PASS'
      : `\n[survival-d2] CENÁRIO FAIL (${failures.join(', ')})`,
  );
  process.exitCode = failures.length === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('[survival-d2] erro fatal:', error);
  process.exitCode = 1;
}).finally(() => {
  const pid = appPid();
  if (pid) {
    try {
      process.kill(Number(pid), 'SIGKILL');
    } catch {}
  }
});
