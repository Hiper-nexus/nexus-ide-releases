/**
 * Five DEV missions, one at a time, Encerrar between runs.
 * Pré-requisito: NEXUS_REMOTE_DEBUG=9222 npm start
 */
import WebSocket from 'ws';

const PORT = process.env.NEXUS_CDP_PORT ?? '9222';
const PASTED = new Set(['submitted', 'acknowledged', 'consumed']);
const PREFERRED_CLIS = ['codex', 'claude', 'glm', 'grok', 'kimi'];
const OPERATOR_MARK = 'nexus:operator-approved';

const MISSIONS = [
  {
    id: 'ask-2x2',
    kind: 'ask',
    goal: 'How much is 2x2 and they have to answer you.',
    expectAnswer: /4/,
    deadlineMs: 240_000,
  },
  {
    id: 'ask-1plus1',
    kind: 'ask',
    goal: 'pergunte aos panes quanto é 1+1',
    expectAnswer: /2/,
    deadlineMs: 240_000,
  },
  {
    id: 'listed-two-files',
    kind: 'work',
    goal:
      '1. crie o arquivo e2e-battery/hello.txt contendo exatamente hello\n' +
      '2. crie o arquivo e2e-battery/world.txt contendo exatamente world',
    deadlineMs: 240_000,
  },
  {
    id: 'ui-landing',
    kind: 'work',
    goal: 'crie e2e-battery/landing.html com um h1 Hello E2E e um parágrafo curto',
    deadlineMs: 240_000,
  },
  {
    id: 'ask-3x3-en',
    kind: 'ask',
    goal: 'How much is 3x3 and they have to answer you.',
    expectAnswer: /9/,
    deadlineMs: 240_000,
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

const evaluate = async (expression, timeoutMs = 120_000) => {
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

const orchCli = present.includes('claude') ? 'claude' : present[0];
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

for (const spec of MISSIONS) {
  console.log(`\n======== ${spec.id} ========`);
  console.log('goal:', spec.goal.split('\n')[0]);
  const started = await evaluate(`(async () => {
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
      return { missionId: review.missionId, state: started.state ?? started.status };
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  })()`);
  if (started?.error || !started?.missionId) {
    console.log('START_FAIL', started);
    results.push({ id: spec.id, pass: false, reason: started?.error || 'no id' });
    continue;
  }
  const missionId = started.missionId;
  const deadline = Date.now() + spec.deadlineMs;
  let last = null;
  let queuedSince = null;
  let failReason = null;
  while (Date.now() < deadline) {
    last = await snapshotOf(missionId);
    const workers = (last.panes || []).filter((p) => p.role === 'worker');
    const shells = (last.panes || []).filter((p) => p.kind === 'shell');
    const foreign = (last.panes || []).filter(
      (p) => p.missionId && p.missionId !== missionId,
    );
    const workerHandoffs = (last.handoffs || []).filter(
      (h) => h.from && h.from !== 'Coordenar e revisar',
    );
    const pasted = workerHandoffs.filter((h) => PASTED.has(h.deliveryState));
    const queued = workerHandoffs.filter((h) => h.deliveryState === 'queued');
    const maestroText = (last.handoffs || [])
      .map((h) => h.summary)
      .join('\n');
    if (queued.length > 0 && queuedSince == null) queuedSince = Date.now();
    if (queued.length === 0) queuedSince = null;
    console.log(
      `[${new Date().toISOString().slice(11, 19)}] ${spec.id} status=${last.status} ` +
        `panes=${last.panes.length} workers=${workers.length} shells=${shells.length} ` +
        `queued=${queued.length} pasted=${pasted.length}`,
    );
    if (shells.length > 0) {
      failReason = 'dead-shell-in-grid';
      break;
    }
    if (foreign.length > 0) {
      failReason = 'foreign-pane';
      break;
    }
    if (String(last.description).includes(OPERATOR_MARK)) {
      failReason = 'auto-operator-approved';
      break;
    }
    const askOk =
      spec.kind !== 'ask' ||
      (workers.length >= 2 &&
        (pasted.length > 0 ||
          (spec.expectAnswer && spec.expectAnswer.test(maestroText))));
    const workOk = spec.kind !== 'work' || last.status === 'done' || pasted.length > 0;
    if (spec.kind === 'ask' && workers.length >= 2 && pasted.length > 0) break;
    if (spec.kind === 'ask' && workers.length >= 2 && spec.expectAnswer?.test(maestroText) && last.status === 'done')
      break;
    if (spec.kind === 'work' && last.status === 'done' && queued.length === 0) break;
    const maestro = (last.panes || []).find((p) => p.role === 'orchestrator');
    const maestroIdle =
      !maestro || maestro.state === 'idle' || maestro.state === 'exited';
    if (
      queuedSince != null &&
      Date.now() - queuedSince > 90_000 &&
      pasted.length === 0 &&
      maestroIdle
    ) {
      failReason = 'queued-stuck';
      break;
    }
    void askOk;
    void workOk;
    await new Promise((r) => setTimeout(r, 8_000));
  }
  last = last || (await snapshotOf(missionId));
  const workers = (last.panes || []).filter((p) => p.role === 'worker');
  const shells = (last.panes || []).filter((p) => p.kind === 'shell');
  const workerHandoffs = (last.handoffs || []).filter(
    (h) => h.from && h.from !== 'Coordenar e revisar',
  );
  const pasted = workerHandoffs.filter((h) => PASTED.has(h.deliveryState));
  const maestroText = (last.handoffs || []).map((h) => h.summary).join('\n');
  const operatorClosed = String(last.description).includes(OPERATOR_MARK);
  if (!failReason) {
    if (shells.length > 0) failReason = 'dead-shell-in-grid';
    else if (operatorClosed) failReason = 'auto-operator-approved';
    else if (spec.kind === 'ask' && workers.length < 2) failReason = 'too-few-workers';
    else if (
      spec.kind === 'ask' &&
      pasted.length === 0 &&
      !(spec.expectAnswer && spec.expectAnswer.test(maestroText)) &&
      !(spec.expectAnswer && spec.expectAnswer.test(
        workerHandoffs.map((h) => h.summary).join('\n'),
      ))
    ) {
      failReason = 'no-handoff-paste-or-maestro-answer';
    }
  }
  const pass = !failReason;
  console.log('SNAP', JSON.stringify({
    status: last.status,
    workers: workers.map((w) => `${w.agentName}/${w.adapterId}/${w.kind}`),
    handoffs: last.handoffs,
    failReason,
  }, null, 2));
  const closed = await encerrar(missionId);
  console.log('ENCERRAR', closed);
  await new Promise((r) => setTimeout(r, 4_000));
  results.push({
    id: spec.id,
    missionId,
    pass,
    failReason,
    status: last.status,
    workers: workers.length,
    pasted: pasted.length,
    operatorClosed,
  });
}

console.log('\n======== SUMMARY ========');
console.log(JSON.stringify(results, null, 2));
const allPass = results.length === MISSIONS.length && results.every((r) => r.pass);
console.log(allPass ? 'BATTERY=PASS' : 'BATTERY=FAIL');
ws.close();
process.exit(allPass ? 0 : 1);
