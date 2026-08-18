#!/usr/bin/env node
/**
 * Rodada 4 D#3 — a jornada do OPERADOR, não a do crash: encerrar missão →
 * clicar Retomar.
 *
 * A dor real (screenshot 2026-08-18): o card "Encerrada pelo operador"
 * anuncia Retomar, o clique explode com "Mission engine resume requires a
 * technical block". Os cenários D#1/D#2 provavam sobrevivência a CRASH —
 * nenhum clicava os botões que o operador clica. Este cenário é o clique:
 * stop (com diálogo nativo aprovado por osascript) → missão bloqueada com
 * selo runtime-closed → Retomar → running de novo com UM orquestrador.
 *
 * Pré-requisitos (idem D#1/D#2):
 *   - npm start responde em NEXUS_REMOTE_DEBUG (default 9235)
 *   - Accessibility permission pro terminal (cliques osascript em sheets)
 *   - workspace scratch do functional-smoke
 *
 * Uso:  node scripts/spikes/e2e-survival-operator-close-resume.mjs
 * Env:  NEXUS_SURVIVAL_ROOT / NEXUS_SURVIVAL_PORT (default 9235)
 *       NEXUS_SURVIVAL_WORKSPACE
 */

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, createWriteStream, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = process.env.NEXUS_SURVIVAL_ROOT ?? process.cwd();
const PORT = process.env.NEXUS_SURVIVAL_PORT ?? '9235';
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
        pending.get(message.id)(message.result?.result?.value);
        pending.delete(message.id);
      }
    });
    const value = await new Promise((resolve, reject) => {
      pending.set(++id, resolve);
      ws.send(
        JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise, returnByValue: true },
        }),
      );
      setTimeout(() => reject(new Error('cdp eval timeout')), 60_000).unref();
    });
    if (value === undefined) throw new Error('cdp sem resultado');
    return value;
  } finally {
    ws.close();
  }
}

async function cdpEvalRetry(wsUrl, expression) {
  let lastError;
  for (let attempt = 0; attempt < 10; attempt += 1) {
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
      console.log(`[survival-d3] aguardando renderer (${attempt * 2}s)...`);
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

// Aprovador do diálogo nativo "Encerrar missão" (dialog.showMessageBox vira
// sheet do Electron). Cliques NOMENADOS funcionam; teclado é imune.
const APP_NAMES = ['Electron', 'Nexus', 'NexusIDE', 'Nexus IDE'];
function clickCloseSheet() {
  for (const app of APP_NAMES) {
    const script = `tell application "System Events"
  if exists (process "${app}") then
    tell process "${app}"
      repeat with w in windows
        try
          if exists (sheet 1 of w) then
            if exists (button "Encerrar missão" of sheet 1 of w) then
              click button "Encerrar missão" of sheet 1 of w
              return "clicked"
            end if
          end if
        end try
      end repeat
    end tell
  end if
  return "none"
end tell`;
    try {
      const out = execFileSync('osascript', ['-e', script])
        .toString()
        .trim();
      if (out === 'clicked') return true;
    } catch {}
  }
  return false;
}

async function missionProbe(wsUrl, missionId) {
  const raw = await cdpEvalRetry(wsUrl, `(async () => {
    try {
      const snap = await window.nexus.mission.snapshot(${JSON.stringify(missionId)});
      const cp = await window.nexus.orch.missionControlPlane(${JSON.stringify(missionId)});
      const orchestrators = (cp?.panes || []).filter(p => p.role === "orchestrator" && p.sessionId).length;
      return JSON.stringify({
        state: snap?.state ?? null,
        reason: snap?.stateReason?.code ?? null,
        allowed: snap?.allowedActions ?? [],
        orchestrators,
      });
    } catch (e) { return JSON.stringify({ error: String(e && e.message || e) }); }
  })()`);
  return JSON.parse(raw);
}

async function main() {
  if (!existsSync(WORKSPACE)) throw new Error(`workspace scratch inexistente: ${WORKSPACE}`);
  execFileSync('git', ['clean', '-qfd'], { cwd: WORKSPACE });

  const logFile = mkdtempSync(join(homedir(), 'nexus-survival-d3-')).concat('/app.log');
  const logFd = openSync(logFile, 'a');
  const stream = createWriteStream(logFile, { fd: logFd, flags: 'a' });

  console.log(`[survival-d3] boot #1 (log: ${logFile})`);
  const app = await startApp(stream);
  try {
    const wsUrl = await pageTarget();
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
    console.log('[survival-d3] limpeza:', cleaned);

    const mission = await cdpEvalRetry(wsUrl, `(async () => {
      try {
        await new Promise(r => setTimeout(r, 1500));
        const mk = (id, name, cat, tools) => ({ id, agentName: name, category: cat, cli: "claude", allowedTools: tools, allowedSkills: null });
        const roster = [ mk("coordinator","Maestro","orchestrator",null), mk("executor","Executor","executor",["Bash","Read","Edit"]), mk("reviewer","Reviewer","reviewer",["Bash","Read"]) ];
        const review = await window.nexus.mission.prepare({ objective: "crie o arquivo d3-sinal.txt com 5 linhas numeradas; depois confirme no relatorio final", contextPaths: [], roster, advanced: { lane: "standard" } });
        const started = await window.nexus.mission.start({ missionId: review.missionId, reviewSha256: review.reviewSha256 });
        return JSON.stringify({ missionId: review.missionId, state: started.state ?? started.status });
      } catch (e) { return JSON.stringify({ error: String(e && e.message || e) }); }
    })()`);
    const missionInfo = JSON.parse(mission);
    if (missionInfo.error) throw new Error(`missão não criou: ${missionInfo.error}`);
    const missionId = missionInfo.missionId;
    console.log(`[survival-d3] missão ${missionId} (${missionInfo.state})`);

    // #1 pré: running com UM orquestrador vivo.
    let pre = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      pre = await missionProbe(wsUrl, missionId);
      if (pre.state === 'running' && pre.orchestrators >= 1) break;
      await sleep(5_000);
    }
    check('missão rodando com orquestrador antes do encerramento', pre.state === 'running' && pre.orchestrators >= 1, JSON.stringify(pre));

    // #2 encerramento pelo operador (diálogo nativo aprovado por osascript).
    console.log('[survival-d3] encerrando pelo operador (diálogo nativo)...');
    let stopError = '';
    const stopDone = await Promise.race([
      (async () => {
        try {
          await cdpEvalRetry(wsUrl, `(async () => {
            await window.nexus.mission.command({ kind: "stop", missionId: ${JSON.stringify(missionId)} });
            return "ok";
          })()`);
          return true;
        } catch (e) {
          stopError = String(e && e.message || e);
          return false;
        }
      })(),
      (async () => {
        // Aprova o sheet enquanto o comando espera o clique.
        for (let i = 0; i < 60; i += 1) {
          if (clickCloseSheet()) return 'clicked';
          await sleep(1_000);
        }
        return 'approver-timeout';
      })(),
    ]);
    // Race honesto: quem resolve primeiro pode ser o comando (true) ou o
    // clique do aprovador ('clicked') — os dois provam o caminho; a prova
    // REAL do encerramento é a projeção blocked_user/runtime-closed abaixo.
    check(
      'encerramento confirmado no diálogo nativo',
      stopDone === true || stopDone === 'clicked',
      `${stopDone} ${stopError}`,
    );

    let closed = null;
    for (let attempt = 0; attempt < 24; attempt += 1) {
      closed = await missionProbe(wsUrl, missionId);
      if (closed.state === 'blocked_user') break;
      await sleep(2_500);
    }
    check(
      'missão projetada como Encerrada pelo operador (blocked_user/runtime-closed)',
      closed.state === 'blocked_user' && closed.reason === 'runtime-closed',
      JSON.stringify(closed),
    );
    check(
      'card anuncia Retomar após encerramento',
      Array.isArray(closed.allowed) && closed.allowed.includes('resume'),
      JSON.stringify(closed.allowed),
    );

    // #3 O CLIQUE que explodia: Retomar.
    console.log('[survival-d3] clicando Retomar (o caminho da screenshot)...');
    let resumeError = '';
    const resumed = await cdpEvalRetry(wsUrl, `(async () => {
      try {
        const snap = await window.nexus.mission.command({ kind: "resume", missionId: ${JSON.stringify(missionId)} });
        return JSON.stringify({ state: snap?.state ?? null, reason: snap?.stateReason?.code ?? null });
      } catch (e) { return JSON.stringify({ error: String(e && e.message || e) }); }
    })()`);
    const resumeInfo = JSON.parse(resumed);
    resumeError = resumeInfo.error ?? '';
    check(
      'Retomar NÃO recusa com "requires a technical block"',
      !/technical block/.test(resumeError),
      resumeError || JSON.stringify(resumeInfo),
    );

    // #4 pós: running de novo, selo limpo, UM orquestrador.
    let post = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      post = await missionProbe(wsUrl, missionId);
      if (post.state === 'running' && post.orchestrators >= 1) break;
      await sleep(5_000);
    }
    check('missão voltou a running com orquestrador religado', post.state === 'running' && post.orchestrators >= 1, JSON.stringify(post));
    check('exatamente UM orquestrador após o Retomar', post.orchestrators === 1, `orchestrators=${post.orchestrators}`);

    console.log(`[survival-d3] ${failures.length === 0 ? 'PASS' : 'FAIL'} (${failures.length} falhas)`);
    process.exitCode = failures.length === 0 ? 0 : 1;
  } finally {
    await stopApp(app);
  }
}

main().catch((error) => {
  console.error('[survival-d3] erro fatal:', error);
  process.exitCode = 1;
});
