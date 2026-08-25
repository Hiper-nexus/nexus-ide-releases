/**
 * Five DEV missions, one at a time, Encerrar between runs.
 * Pré-requisito: NEXUS_REMOTE_DEBUG=9222 npm start
 */
import WebSocket from 'ws';

const PORT = process.env.NEXUS_CDP_PORT ?? '9222';
const PASTED = new Set(['submitted', 'acknowledged', 'consumed']);
const NOT_WORKER_FROM = new Set([
  'Coordenar e revisar',
  'nexus-delegation-supervisor',
]);
const PREFERRED_CLIS = ['codex', 'claude', 'glm', 'grok', 'kimi'];
const OPERATOR_MARK = 'nexus:operator-approved';

const MISSIONS = [
  {
    id: 'ask-2x2',
    kind: 'ask',
    goal: 'How much is 2x2 and they have to answer you.',
    expectAnswer:
      /2\s*[x×*]\s*2\s*=\s*4|\[nexus\] resultado[^\n]*\b4\b|resposta[^.\n]{0,80}\b4\b/i,
    deadlineMs: 360_000,
  },
  {
    id: 'ask-1plus1',
    kind: 'ask',
    goal: 'pergunte aos panes quanto é 1+1',
    expectAnswer:
      /1\s*\+\s*1\s*=\s*2|\[nexus\] resultado[^\n]*\b2\b|resposta[^.\n]{0,80}\b2\b/i,
    deadlineMs: 360_000,
  },
  {
    id: 'listed-two-files',
    kind: 'work',
    goal:
      '1. crie o arquivo e2e-battery/hello.txt contendo exatamente hello\n' +
      '2. crie o arquivo e2e-battery/world.txt contendo exatamente world',
    deadlineMs: 360_000,
  },
  {
    id: 'ui-landing',
    kind: 'work',
    goal: 'crie e2e-battery/landing.html com um h1 Hello E2E e um parágrafo curto',
    deadlineMs: 360_000,
  },
  {
    id: 'ask-3x3-en',
    kind: 'ask',
    goal: 'How much is 3x3 and they have to answer you.',
    expectAnswer:
      /3\s*[x×*]\s*3\s*=\s*9|\[nexus\] resultado[^\n]*\b9\b|resposta[^.\n]{0,80}\b9\b/i,
    deadlineMs: 360_000,
  },
];

const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
const targets = await res.json();
const page = targets.find(
  (t) =>
    t.type === 'page' &&
    (t.url.includes('localhost') || t.url.includes('nexus-app')) &&
    !t.url.includes('pet.html'),
);
if (!page) {
  console.error('renderer não encontrado');
  process.exit(2);
}

const ws = new WebSocket(page.webSocketDebuggerUrl, {
  maxPayload: 256 * 1024 * 1024,
});
let seq = 0;
const pending = new Map();
const send = (method, params = {}, timeoutMs = 90_000) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => reject(new Error(`${method} timeout`)), timeoutMs);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
ws.on('message', (raw) => {
  const msg = JSON.parse(String(raw));
  if (!msg.id || !pending.has(msg.id)) return;
  const { resolve, reject, timer } = pending.get(msg.id);
  clearTimeout(timer);
  pending.delete(msg.id);
  if (msg.error) reject(new Error(msg.error.message));
  else resolve(msg.result);
});
await new Promise((resolve, reject) => {
  ws.on('open', resolve);
  ws.on('error', reject);
  setTimeout(() => reject(new Error('ws open timeout')), 10_000);
});

const evaluateOnce = async (expression, timeoutMs = 120_000) => {
  const result = await send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    timeoutMs,
  );
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text,
    );
  }
  return result.result?.value;
};

const evaluate = async (expression, timeoutMs = 120_000) => {
  let last = null;
  for (let i = 0; i < 6; i += 1) {
    try {
      return await evaluateOnce(
        expression,
        i === 0 ? timeoutMs : Math.min(timeoutMs, 30_000),
      );
    } catch (error) {
      last = error;
      if (!String(error?.message || error).includes('timeout')) throw error;
      console.log(`cdp retry ${i}: ${error.message}`);
      await new Promise((r) => setTimeout(r, 4_000));
    }
  }
  throw last;
};

const probe = await evaluate(`(async () => {
  const auth = await window.nexus.providers.authStatus();
  const ws = await window.nexus.workspace.get();
  return { auth, workspace: ws?.current?.path ?? null };
})()`);
const present = (probe.auth || [])
  .filter((row) => row.state === 'ok')
  .map((row) => row.adapterId)
  .filter((id) => PREFERRED_CLIS.includes(id));
console.log('workspace', probe.workspace);
console.log('clis', present);
if (!probe.workspace) {
  console.error('FAIL: sem workspace');
  process.exit(1);
}
if (present.length === 0) {
  console.error('FAIL: sem CLI autenticada');
  process.exit(1);
}
for (let i = 0; i < 120; i += 1) {
  const rootKids = await evaluate(
    `document.getElementById("root")?.children.length ?? 0`,
  );
  if (rootKids > 0) {
    console.log('renderer root children', rootKids);
    break;
  }
  if (i === 119) {
    console.error('FAIL: renderer root vazio');
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 1_000));
}

// Claude often reports authStatus=ok but mission.start rejects
// "não está autenticado para missões". Prefer grok/glm for Maestro.
const orchCli = present.includes('grok')
  ? 'grok'
  : present.includes('glm')
    ? 'glm'
    : present.includes('codex')
      ? 'codex'
      : present[0];
console.log('orchCli', orchCli);
const workerClis = present.filter((id) => id !== orchCli);
const pick = (i) => workerClis[i % Math.max(workerClis.length, 1)] || orchCli;
const role = (id, agentName, category, cli) => ({
  id,
  agentName,
  category,
  cli,
  allowedTools: null,
  allowedSkills: null,
});
const roster = [
  role('coordenar-e-revisar', 'Coordenar e revisar', 'orchestrator', orchCli),
  role('implementar-interface', 'Implementar interface', 'executor', pick(0)),
  role('implementar-motor', 'Implementar motor', 'executor', pick(1)),
  role('verificar-o-resultado', 'Verificar o resultado', 'reviewer', pick(2)),
];
const ROSTER_WORKER_NAMES = new Set(
  roster.filter((row) => row.category !== 'orchestrator').map((row) => row.agentName),
);
const selected = process.env.NEXUS_E2E_ONLY
  ? MISSIONS.filter((row) => row.id === process.env.NEXUS_E2E_ONLY)
  : MISSIONS;
if (process.env.NEXUS_E2E_ONLY && selected.length === 0) {
  console.error('FAIL: unknown NEXUS_E2E_ONLY', process.env.NEXUS_E2E_ONLY);
  process.exit(2);
}

const snapshotOf = (missionId) =>
  evaluate(`(async () => {
    const orch = window.nexus.orch;
    const missions = await orch.listMissions();
    const mission = (missions || []).find((m) => m.id === ${JSON.stringify(missionId)}) || null;
    const panes = (await orch.listMissionPanes(${JSON.stringify(missionId)})) || [];
    const handoffs = ((await orch.listHandoffs()) || []).filter(
      (h) => h.missionId === ${JSON.stringify(missionId)},
    );
    return {
      status: mission?.status ?? null,
      intentState: mission?.intentState ?? null,
      description: String(mission?.description || ''),
      panes: panes.map((p) => ({
        id: p.paneId || p.id,
        role: p.role,
        kind: p.kind,
        title: p.title,
        agentName: p.agentName,
        state: p.state,
        adapterId: p.adapterId,
        missionId: p.missionId,
        readOnly: p.readOnly === true,
      })),
      handoffs: handoffs.map((h) => ({
        from: h.fromAgent,
        status: h.status,
        deliveryState: h.deliveryState,
        summary: String(h.summary || '').slice(0, 220),
      })),
    };
  })()`);

const maestroPtyOf = (missionId) =>
  evaluate(`(async () => {
    const listed = (await window.nexus.orch.listMissionPanes(${JSON.stringify(missionId)})) || [];
    const orchRow = listed.find((p) => p.role === 'orchestrator') || null;
    const panes = [...document.querySelectorAll('.pane')];
    const orchPanes = panes.filter((el) =>
      el.querySelector('.toolbar__badge--orch'),
    );
    const live = orchPanes.filter(
      (el) => !el.classList.contains('pane--state-exited'),
    );
    const orch = live[0] || orchPanes[0] || null;
    const stateClass = orch
      ? [...orch.classList].find((c) => c.startsWith('pane--state-'))
      : null;
    const cssState = stateClass
      ? stateClass.replace('pane--state-', '')
      : null;
    const orchPaneId = orchRow?.paneId || orchRow?.id || null;
    const excerpt =
      orchPaneId && typeof window.__nexusGetScrollbackExcerpt === 'function'
        ? String(window.__nexusGetScrollbackExcerpt(orchPaneId) || '')
        : '';
    const rows = orch?.querySelector('.xterm-rows, .xterm-screen, .xterm');
    const text = (excerpt || String(rows?.innerText || '')).slice(-8000);
    return {
      text,
      state: cssState || orchRow?.state || null,
    };
  })()`);

const extraWorkersOf = (workers) => {
  const seen = new Set();
  return workers.filter((pane) => {
    const name = String(pane.agentName || '').trim();
    if (!name || !ROSTER_WORKER_NAMES.has(name) || seen.has(name)) return true;
    seen.add(name);
    return false;
  });
};

const encerrar = (missionId) =>
  evaluate(`(async () => {
    try {
      await window.nexus.orch.closeMissionRuntime(${JSON.stringify(missionId)});
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  })()`);

const leftovers = await evaluate(`(async () => {
  const missions = await window.nexus.orch.listMissions();
  const live = (missions || []).filter((m) => m.status === 'running');
  for (const m of live) {
    try { await window.nexus.orch.closeMissionRuntime(m.id); } catch {}
  }
  return live.map((m) => m.id);
})()`);
console.log('encerrar leftovers', leftovers);

const results = [];

for (const spec of selected) {
  console.log(`\n======== ${spec.id} ========`);
  console.log('goal:', spec.goal.split('\n')[0]);
  // Kick off in the renderer without holding CDP awaitPromise on start():
  // waitForSession + first-wave occupy the same JS thread, so a single
  // evaluate() around prepare/start used to time out while the mission
  // actually spawned (DEV 25/08).
  await evaluateOnce(
    `(() => {
      window.__e2eStart = { pending: true };
      setTimeout(() => {
        void (async () => {
          try {
            const review = await window.nexus.mission.prepare({
              objective: ${JSON.stringify(spec.goal)},
              title: ${JSON.stringify(spec.id)},
              contextPaths: [],
              roster: ${JSON.stringify(roster)},
              advanced: { lane: 'standard', freeAgentChoice: true },
            });
            const started = await window.nexus.mission.start({
              missionId: review.missionId,
              reviewSha256: review.reviewSha256,
            });
            window.__e2eStart = {
              missionId: review.missionId,
              state: started.state ?? started.status,
            };
          } catch (e) {
            window.__e2eStart = { error: String((e && e.message) || e) };
          }
        })();
      }, 0);
      return 'kicked';
    })()`,
    20_000,
  );
  // waitForSession runs on the renderer JS thread. CDP evaluate is
  // serialized against it — polling during first-wave times out and
  // queues behind the spawn. Let start finish, then read __e2eStart.
  await new Promise((r) => setTimeout(r, 90_000));
  let started = null;
  for (let i = 0; i < 30; i += 1) {
    try {
      started = await evaluateOnce(`window.__e2eStart`, 15_000);
      if (started && started.pending !== true) break;
    } catch (error) {
      console.log(`start-poll ${i}: ${error.message}`);
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  if (started?.error || !started?.missionId) {
    console.log('START_FAIL', started);
    results.push({ id: spec.id, pass: false, reason: started?.error || 'no id' });
    continue;
  }
  const missionId = started.missionId;
  const deadline = Date.now() + spec.deadlineMs;
  let last = null;
  let idleQueuedSince = null;
  let failReason = null;
  let maestroView = { text: '', state: null };
  while (Date.now() < deadline) {
    try {
      last = await snapshotOf(missionId);
      maestroView = (await maestroPtyOf(missionId)) || { text: '', state: null };
    } catch (error) {
      console.log(`snapshot timeout: ${error.message}`);
      await new Promise((r) => setTimeout(r, 8_000));
      continue;
    }
    const workers = (last.panes || []).filter((p) => p.role === 'worker');
    const extras = extraWorkersOf(workers);
    const shells = (last.panes || []).filter((p) => p.kind === 'shell');
    const foreign = (last.panes || []).filter(
      (p) => p.missionId && p.missionId !== missionId,
    );
    const workerHandoffs = (last.handoffs || []).filter(
      (h) => h.from && !NOT_WORKER_FROM.has(h.from),
    );
    const pasted = workerHandoffs.filter((h) => PASTED.has(h.deliveryState));
    const queued = workerHandoffs.filter((h) => h.deliveryState === 'queued');
    const maestro = (last.panes || []).find((p) => p.role === 'orchestrator');
    const maestroState = maestroView.state || maestro?.state || null;
    const maestroIdle = maestroState === 'idle';
    const maestroShowsAnswer = Boolean(
      spec.expectAnswer &&
        spec.expectAnswer.test(
          String(maestroView.text || '')
            .replace(/\d+m\s*\d+s/gi, '')
            .replace(/\b\d+s\b/gi, ''),
        ),
    );
    if (
      queued.length > 0 &&
      pasted.length === 0 &&
      !maestroShowsAnswer &&
      maestroIdle
    ) {
      if (idleQueuedSince == null) idleQueuedSince = Date.now();
    } else {
      idleQueuedSince = null;
    }
    console.log(
      `[${new Date().toISOString().slice(11, 19)}] ${spec.id} status=${last.status} ` +
        `panes=${last.panes.length} workers=${workers.length} extras=${extras.length} ` +
        `shells=${shells.length} queued=${queued.length} pasted=${pasted.length} ` +
        `maestro=${maestroState ?? 'none'} ptyAnswer=${maestroShowsAnswer ? 'yes' : 'no'}`,
    );
    if (shells.length > 0) {
      failReason = 'dead-shell-in-grid';
      break;
    }
    if (foreign.length > 0) {
      failReason = 'foreign-pane';
      break;
    }
    if (extras.length > 0 || workers.length > ROSTER_WORKER_NAMES.size) {
      failReason = 'extra-unnamed-worker';
      break;
    }
    if (String(last.description).includes(OPERATOR_MARK)) {
      failReason = 'auto-operator-approved';
      break;
    }
    if (
      spec.kind === 'ask' &&
      workers.length >= 2 &&
      (pasted.length > 0 || maestroShowsAnswer)
    ) {
      break;
    }
    if (
      spec.kind === 'work' &&
      queued.length === 0 &&
      (last.status === 'done' || pasted.length > 0)
    ) {
      break;
    }
    if (
      idleQueuedSince != null &&
      Date.now() - idleQueuedSince > 120_000
    ) {
      failReason = 'queued-stuck';
      break;
    }
    await new Promise((r) => setTimeout(r, 8_000));
  }
  last = last || (await snapshotOf(missionId));
  maestroView = maestroView.text
    ? maestroView
    : (await maestroPtyOf(missionId)) || { text: '', state: null };
  const workers = (last.panes || []).filter((p) => p.role === 'worker');
  const extras = extraWorkersOf(workers);
  const shells = (last.panes || []).filter((p) => p.kind === 'shell');
  const workerHandoffs = (last.handoffs || []).filter(
    (h) => h.from && h.from !== 'Coordenar e revisar',
  );
  const pasted = workerHandoffs.filter((h) => PASTED.has(h.deliveryState));
  const queued = workerHandoffs.filter((h) => h.deliveryState === 'queued');
  const maestro = (last.panes || []).find((p) => p.role === 'orchestrator');
  const maestroState = maestroView.state || maestro?.state || null;
  const maestroShowsAnswer = Boolean(
    spec.expectAnswer &&
      spec.expectAnswer.test(
        String(maestroView.text || '')
          .replace(/\d+m\s*\d+s/gi, '')
          .replace(/\b\d+s\b/gi, ''),
      ),
  );
  const operatorClosed = String(last.description).includes(OPERATOR_MARK);
  if (!failReason) {
    if (shells.length > 0) failReason = 'dead-shell-in-grid';
    else if (extras.length > 0 || workers.length > ROSTER_WORKER_NAMES.size) {
      failReason = 'extra-unnamed-worker';
    } else if (operatorClosed) failReason = 'auto-operator-approved';
    else if (spec.kind === 'ask' && workers.length < 2) failReason = 'too-few-workers';
    else if (
      spec.kind === 'ask' &&
      pasted.length === 0 &&
      !maestroShowsAnswer
    ) {
      failReason = 'no-handoff-paste-or-maestro-answer';
    } else if (
      queued.length > 0 &&
      pasted.length === 0 &&
      !maestroShowsAnswer &&
      (last.status === 'done' || maestroState === 'exited')
    ) {
      failReason = 'queued-after-pronto';
    } else if (
      spec.kind === 'work' &&
      last.status !== 'done' &&
      pasted.length === 0
    ) {
      failReason = 'work-not-delivered';
    } else if (
      spec.kind === 'work' &&
      last.status === 'done' &&
      queued.length > 0 &&
      pasted.length === 0
    ) {
      failReason = 'queued-after-pronto';
    }
  }
  const pass = !failReason;
  console.log('SNAP', JSON.stringify({
    status: last.status,
    maestro: {
      state: maestroState,
      adapterId: maestro?.adapterId ?? null,
      ptyAnswer: maestroShowsAnswer,
      ptyTail: String(maestroView.text || '').replace(/\s+/g, ' ').slice(-600),
    },
    workers: workers.map((w) => `${w.agentName}/${w.adapterId}/${w.kind}`),
    extras: extras.map((w) => `${w.agentName}/${w.adapterId}`),
    handoffs: last.handoffs,
    failReason,
  }, null, 2));
  const closed = await encerrar(missionId);
  console.log('ENCERRAR', closed);
  await new Promise((r) => setTimeout(r, 30_000));
  for (let i = 0; i < 12; i += 1) {
    try {
      await evaluateOnce('1', 10_000);
      break;
    } catch (error) {
      console.log(`cdp after encerrar ${i}: ${error.message}`);
      await new Promise((r) => setTimeout(r, 3_000));
    }
  }
  results.push({
    id: spec.id,
    missionId,
    pass,
    failReason,
    status: last.status,
    workers: workers.length,
    extras: extras.length,
    pasted: pasted.length,
    maestroShowsAnswer,
    operatorClosed,
  });
}

console.log('\n======== SUMMARY ========');
console.log(JSON.stringify(results, null, 2));
const allPass = results.length === selected.length && results.every((r) => r.pass);
console.log(allPass ? 'BATTERY=PASS' : 'BATTERY=FAIL');
ws.close();
process.exit(allPass ? 0 : 1);
