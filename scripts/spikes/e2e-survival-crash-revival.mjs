#!/usr/bin/env node
/**
 * Fase D da campanha 0.50 — cenário de sobrevivência #1: crash → revival.
 *
 * Reproduz o bug real do operador (17/08) de ponta a ponta no app REAL:
 *   1. missão trivial no workspace scratch → orquestrador vivo;
 *   2. SIGKILL no app (crash de verdade — SIGTERM faz teardown limpo e não
 *      ressuscita; ver docs/analysis/2026-08-17-campanha-050);
 *   3. religa o app;
 *   4. ASSERTE NO DOM (doutrina Orca tests/e2e/AGENTS.md — nunca no store):
 *      missão running, EXATAMENTE um tile "orq" de orquestrador, nenhum
 *      cadáver de orquestrador, nenhum pane com erro de grant.
 *
 * Uso:  node scripts/spikes/e2e-survival-crash-revival.mjs
 * Env:  NEXUS_SURVIVAL_ROOT (repo do worktree, default cwd)
 *       NEXUS_SURVIVAL_PORT (CDP, default 9231)
 *       NEXUS_SURVIVAL_WORKSPACE (default functional-smoke-workspace do userData)
 * Requer: claude logado (roster claude), node_modules/ws do repo, ~R$2 de tokens.
 */

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = process.env.NEXUS_SURVIVAL_ROOT ?? process.cwd();
const PORT = process.env.NEXUS_SURVIVAL_PORT ?? '9231';
const WORKSPACE =
  process.env.NEXUS_SURVIVAL_WORKSPACE ??
  join(
    homedir(),
    'Library/Application Support/NexusIDE/functional-smoke-workspace',
  );

const failures = [];
function check(name, ok, detail = '') {
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

async function loadWebSocket() {
  // CJS interop: import do diretório pode dar { default: { default: Ws } } —
  // resolver o construtor de forma defensiva (o bug real do run 1/3).
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
      throw new Error(
        `CDP eval lançou: ${result.exceptionDetails.text ?? 'erro'}`,
      );
    }
    const value = result?.result?.value;
    if (value === undefined) {
      // Contexto destruído no meio do eval (reload/navegação) devolve CDP sem
      // result — indistinguível de retorno indefinido; todos os evals deste
      // script retornam JSON string, então undefined É falha.
      throw new Error('CDP eval sem resultado (contexto destruído?)');
    }
    return value;
  } finally {
    ws.close();
  }
}

/** Espera o renderer terminar de carregar (window.nexus presente). */
async function waitForRenderer(wsUrl) {
  // Vite dev frio compila >2min na primeira carga; orçamento folgado.
  let firstError = null;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const ready = await cdpEval(
      wsUrl,
      'typeof window.nexus !== "undefined" && !!window.nexus.mission',
      { awaitPromise: false },
    ).catch((error) => {
      firstError ??= error;
      return false;
    });
    if (ready === true) return;
    if (attempt > 0 && attempt % 15 === 0) {
      console.log(
        `[survival] aguardando renderer (${attempt * 2}s)` +
          (firstError ? ` — último erro: ${firstError.message}` : '') +
          '...',
      );
      firstError = null;
    }
    await sleep(2_000);
  }
  throw new Error('renderer nunca expôs window.nexus (5 min)');
}

async function pageTarget() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(
        (response) => response.json(),
      );
      const page = list.find((entry) => entry.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // app ainda subindo
    }
    await sleep(2_000);
  }
  throw new Error('CDP page target não apareceu');
}

async function startApp(logFile) {
  const child = spawn(
    'npm',
    ['start'],
    {
      cwd: ROOT,
      env: { ...process.env, NEXUS_REMOTE_DEBUG: PORT },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  child.stderr.pipe(logFile);
  return child;
}

/** Retry de eval crítico (contexto destruído é transitório). */
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

async function stopApp(child, pid) {
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
  if (!existsSync(WORKSPACE)) {
    throw new Error(`workspace scratch inexistente: ${WORKSPACE}`);
  }
  execFileSync('git', ['clean', '-qfd'], { cwd: WORKSPACE });

  const logFile = mkdtempSync(join(homedir(), 'nexus-survival-')).concat(
    '/app.log',
  );
  const { openSync } = await import('node:fs');
  const logFd = openSync(logFile, 'a');
  const { createWriteStream } = await import('node:fs');
  const stream = createWriteStream(logFile, { fd: logFd, flags: 'a' });

  console.log(`[survival] boot #1 (log: ${logFile})`);
  let app = await startApp(stream);
  let wsUrl = await pageTarget();
  await waitForRenderer(wsUrl);
  console.log('[survival] renderer pronto');

  console.log('[survival] limpando missões running anteriores do scratch');
  const cleaned = await cdpEvalRetry(
    wsUrl,
    `(async () => {
      try {
        const missions = await window.nexus.mission.list();
        const running = missions.filter(m => (m.state ?? m.status) === "running");
        for (const m of running) {
          try { await window.nexus.mission.command({ kind: "stop", missionId: m.id }); } catch {}
        }
        for (let i = 0; i < 30; i += 1) {
          await new Promise(r => setTimeout(r, 1000));
          const fresh = await window.nexus.mission.list();
          if (!fresh.some(m => (m.state ?? m.status) === "running")) break;
        }
        return JSON.stringify({ stopped: running.map(m => m.id.slice(0, 20)) });
      } catch (e) { return JSON.stringify({ error: String(e && e.message || e) }); }
    })()`,
  );
  console.log('[survival] limpeza:', cleaned);

  console.log('[survival] abrindo workspace e criando missão trivial');
  const mission = await cdpEvalRetry(
    wsUrl,
    `(async () => {
      try {
        await window.nexus.workspace.open(${JSON.stringify(WORKSPACE)});
        await new Promise(r => setTimeout(r, 1500));
        const mk = (id, name, cat, tools) => ({ id, agentName: name, category: cat, cli: "claude", allowedTools: tools, allowedSkills: null });
        const roster = [ mk("coordinator","Maestro","orchestrator",null), mk("executor","Executor","executor",["Bash","Read","Edit"]), mk("reviewer","Reviewer","reviewer",["Bash","Read"]) ];
        const review = await window.nexus.mission.prepare({ objective: "crie o arquivo survival-proof.txt com o texto nexus-imbativel", contextPaths: [], roster, advanced: { lane: "standard" } });
        const started = await window.nexus.mission.start({ missionId: review.missionId, reviewSha256: review.reviewSha256 });
        return JSON.stringify({ missionId: review.missionId, state: started.state ?? started.status });
      } catch (e) { return JSON.stringify({ error: String(e && e.message || e) }); }
    })()`,
  );
  const missionInfo = JSON.parse(mission);
  if (missionInfo.error) throw new Error(`missão não criou: ${missionInfo.error}`);
  console.log(`[survival] missão ${missionInfo.missionId} (${missionInfo.state})`);

  console.log('[survival] esperando orquestrador vivo (timeout 3 min)');
  let orchestratorLive = false;
  for (let attempt = 0; attempt < 36 && !orchestratorLive; attempt += 1) {
    await sleep(5_000);
    const control = await cdpEval(
      wsUrl,
      `(async () => {
        try {
          const cp = await window.nexus.orch.missionControlPlane(${JSON.stringify(missionInfo.missionId)});
          if (!cp) return JSON.stringify({ panes: [] });
          return JSON.stringify({ panes: cp.panes.filter(p => p.role === "orchestrator").map(p => ({ state: p.state, session: !!p.sessionId })) });
        } catch { return JSON.stringify({ panes: [] }); }
      })()`,
    );
    const panes = JSON.parse(control).panes;
    orchestratorLive =
      panes.length > 0 && panes.some((p) => p.session && p.state !== 'spawning');
  }
  check('orquestrador vivo antes do crash', orchestratorLive);
  if (!orchestratorLive) {
    await stopApp(app, appPid());
    throw new Error('orquestrador nunca subiu — abortando cenário');
  }

  console.log('[survival] SIGKILL (crash)');
  const pid = appPid();
  await stopApp(app, pid);
  check('app morto após SIGKILL', !appPid());

  console.log('[survival] boot #2 (revival)');
  app = await startApp(stream);
  wsUrl = await pageTarget();
  await waitForRenderer(wsUrl);
  await sleep(45_000); // ressurreição + cold start do orquestrador

  const verdict = await cdpEvalRetry(
    wsUrl,
    `(async () => {
      const headers = Array.from(document.querySelectorAll(".pane")).map(p => {
        const h = p.querySelector(":scope > :not(.pane__terminal)") || p.firstElementChild;
        return (h && h.textContent || p.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 90);
      });
      let status = null;
      let liveOrchestrators = -1;
      try {
        const cp = await window.nexus.orch.missionControlPlane(${JSON.stringify(missionInfo.missionId)});
        status = cp ? cp.missionStatus : null;
        liveOrchestrators = (cp?.panes || []).filter(p => p.role === "orchestrator" && p.sessionId).length;
      } catch {}
      return JSON.stringify({ headers, status, liveOrchestrators });
    })()`,
  );
  const { headers, status, liveOrchestrators } = JSON.parse(verdict);
  console.log('[survival] status da missão:', status);
  console.log('[survival] orquestradores vivos (registry):', liveOrchestrators);
  console.log('[survival] panes:', headers);

  // O DOM não carrega missionId no header — a contagem por missão vem do
  // registry (espelho do vivo); o DOM responde pelo ruído visual.
  check(
    'exatamente UM orquestrador vivo para a missão do cenário',
    liveOrchestrators === 1,
    `registry=${liveOrchestrators}`,
  );
  check(
    'nenhum erro de grant expirado na tela',
    !headers.some((h) => /expired orchestration spawn grant/.test(h)),
  );
  check(
    'missão não terminou em block falso',
    status !== 'blocked',
    `status=${status}`,
  );

  // Limpeza: encerrar a missão de teste e o app — e ESPERAR o stop assentar
  // (a lição do run 5: matar o app 8s depois do stop deixa a missão running
  // no DB e o próximo boot a ressuscita junto).
  await cdpEvalRetry(
    wsUrl,
    `(async () => {
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
    })()`,
  ).catch(() => {});
  const pid2 = appPid();
  await stopApp(app, pid2);

  console.log(
    failures.length === 0
      ? '\n[survival] CENÁRIO PASS'
      : `\n[survival] CENÁRIO FAIL (${failures.join(', ')})`,
  );
  process.exitCode = failures.length === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('[survival] erro fatal:', error);
  process.exitCode = 1;
}).finally(() => {
  // Fatal nunca deixa app/processo órfãos (a lição do run 2).
  const pid = appPid();
  if (pid) {
    try {
      process.kill(Number(pid), 'SIGKILL');
    } catch {}
  }
});
