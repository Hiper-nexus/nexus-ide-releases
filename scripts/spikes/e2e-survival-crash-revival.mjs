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

async function cdpEval(wsUrl, expression, { awaitPromise = true } = {}) {
  const WebSocket = (await import(join(ROOT, 'node_modules', 'ws'))).default;
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
      new Promise((resolve) => {
        id += 1;
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params }));
      });
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
    });
    return result?.result?.value;
  } finally {
    ws.close();
  }
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

  console.log('[survival] abrindo workspace e criando missão trivial');
  const mission = await cdpEval(
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
  await sleep(45_000); // ressurreição + cold start do orquestrador

  const verdict = await cdpEval(
    wsUrl,
    `(async () => {
      const headers = Array.from(document.querySelectorAll(".pane")).map(p => {
        const h = p.querySelector(":scope > :not(.pane__terminal)") || p.firstElementChild;
        return (h && h.textContent || p.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 90);
      });
      let status = null;
      try {
        const cp = await window.nexus.orch.missionControlPlane(${JSON.stringify(missionInfo.missionId)});
        status = cp ? cp.missionStatus : null;
      } catch {}
      return JSON.stringify({ headers, status });
    })()`,
  );
  const { headers, status } = JSON.parse(verdict);
  console.log('[survival] status da missão:', status);
  console.log('[survival] panes:', headers);

  const orchestratorTiles = headers.filter((h) => /\borq\b/.test(h));
  check(
    'exatamente UM tile de orquestrador (orq)',
    orchestratorTiles.length === 1,
    `tiles=${orchestratorTiles.length}`,
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

  // Limpeza: encerrar a missão de teste e o app.
  await cdpEval(
    wsUrl,
    `(async () => { try { await window.nexus.mission.command({ kind: "stop", missionId: ${JSON.stringify(missionInfo.missionId)} }); } catch {} "ok" })()`,
  ).catch(() => {});
  await sleep(8_000);
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
});
