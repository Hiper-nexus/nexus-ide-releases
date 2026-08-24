/**
 * DEV proof: pergunta ao time (2x2) abre o roster e o handoff cola no Maestro.
 *
 * Pré-requisito: `NEXUS_REMOTE_DEBUG=9222 npm start`
 * Não entra no app empacotado.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import WebSocket from 'ws';

const PORT = process.env.NEXUS_CDP_PORT ?? '9222';
const WORKSPACE =
  process.env.NEXUS_E2E_WORKSPACE ?? '/tmp/nexus-dev-handoff-2x2';
const GOAL =
  process.env.NEXUS_E2E_GOAL ??
  'How much is 2x2 and they have to answer you.';
const DEADLINE_MS = Number(process.env.NEXUS_E2E_DEADLINE_MS ?? 300_000);
const PREFERRED_CLIS = [
  'codex',
  'claude',
  'cursor',
  'glm',
  'grok',
  'kimi',
  'openclaude',
];

mkdirSync(WORKSPACE, { recursive: true });
if (spawnSync('git', ['-C', WORKSPACE, 'rev-parse', '--is-inside-work-tree']).status !== 0) {
  spawnSync('git', ['init'], { cwd: WORKSPACE, stdio: 'ignore' });
  writeFileSync(`${WORKSPACE}/README.md`, '# e2e handoff 2x2\n');
  spawnSync('git', ['add', 'README.md'], { cwd: WORKSPACE, stdio: 'ignore' });
  spawnSync(
    'git',
    ['-c', 'user.email=e2e@nexus', '-c', 'user.name=e2e', 'commit', '-m', 'init'],
    { cwd: WORKSPACE, stdio: 'ignore' },
  );
}

const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
const targets = await res.json();
const page = targets.find(
  (t) =>
    t.type === 'page' &&
    (t.url.includes('localhost') || t.url.includes('nexus-app')) &&
    !t.url.includes('pet.html'),
);
if (!page) {
  console.error('renderer não encontrado em', PORT, targets.map((t) => t.url));
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
    const timer = setTimeout(
      () => reject(new Error(`${method} timeout`)),
      timeoutMs,
    );
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

console.log('[1] routeIntent + auth');
const probe = await evaluate(`(async () => {
  const route = await window.nexus.mission.routeIntent(${JSON.stringify(GOAL)});
  const providers = await window.nexus.providers.list();
  const auth = await window.nexus.providers.authStatus();
  return {
    route,
    providers: (providers || []).map((p) => ({
      id: p.adapterId || p.id,
      enabled: p.enabled,
      hasKey: p.hasKey,
    })),
    auth,
  };
})()`);
console.log(JSON.stringify(probe, null, 2));
if (probe?.route != null) {
  console.error('FAIL: meta-de-pane virou rota direta', probe.route);
  ws.close();
  process.exit(1);
}

const present = [];
const authRows = Array.isArray(probe.auth)
  ? probe.auth
  : Array.isArray(probe.auth?.adapters)
    ? probe.auth.adapters
    : [];
const authById = new Map(
  authRows.map((row) => [row.adapterId || row.id, row]),
);
for (const id of PREFERRED_CLIS) {
  const row = authById.get(id);
  const provider = (probe.providers || []).find((p) => p.id === id);
  const ready =
    row?.state === 'ok' ||
    row?.status === 'ok' ||
    row?.readiness === 'present' ||
    row?.present === true ||
    row?.authenticated === true ||
    provider?.hasKey === true;
  if (ready) present.push(id);
}
if (present.length === 0) {
  const fallback = authRows
    .filter((row) => row.state === 'ok')
    .map((row) => row.adapterId || row.id)
    .filter(Boolean);
  present.push(...fallback);
}
console.log('[1] CLIs presentes:', present);
if (present.length === 0) {
  console.error('FAIL: nenhuma CLI autenticada no DEV');
  ws.close();
  process.exit(1);
}

const orchCli = present.includes('claude') ? 'claude' : present[0];
const workerClis = present.filter((id) => id !== orchCli);
const pickWorker = (index) =>
  workerClis[index % Math.max(workerClis.length, 1)] || orchCli;

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
  role('implementar-interface', 'Implementar interface', 'executor', pickWorker(0)),
  role('implementar-motor', 'Implementar motor', 'executor', pickWorker(1)),
  role('verificar-o-resultado', 'Verificar o resultado', 'reviewer', pickWorker(2)),
];
console.log('[2] roster', roster.map((a) => `${a.agentName}/${a.cli}`).join(', '));

console.log('[3] workspace atual + start');
const started = await evaluate(`(async () => {
  try {
    const ws = await window.nexus.workspace.get();
    if (!ws?.current?.path) {
      return { error: 'DEV sem workspace aberto — abra uma pasta no app' };
    }
    const review = await window.nexus.mission.prepare({
      objective: ${JSON.stringify(GOAL)},
      title: ${JSON.stringify(GOAL)},
      contextPaths: [],
      roster: ${JSON.stringify(roster)},
      advanced: { lane: 'standard', freeAgentChoice: true },
    });
    const started = await window.nexus.mission.start({
      missionId: review.missionId,
      reviewSha256: review.reviewSha256,
    });
    return {
      missionId: review.missionId,
      state: started.state ?? started.status ?? null,
    };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
})()`);
console.log('[3]', started);
if (started?.error || !started?.missionId) {
  ws.close();
  process.exit(1);
}

const missionId = started.missionId;
const PASTED = new Set(['submitted', 'acknowledged', 'consumed']);
const deadline = Date.now() + DEADLINE_MS;
let last = null;
let queuedSince = null;
let maxWorkers = 0;

while (Date.now() < deadline) {
  last = await evaluate(`(async () => {
    const orch = window.nexus.orch;
    const missions = await orch.listMissions();
    const mission = (missions || []).find((m) => m.id === ${JSON.stringify(missionId)}) || null;
    const panes = (await orch.listMissionPanes(${JSON.stringify(missionId)})) || [];
    const handoffs = (await orch.listHandoffs()) || [];
    const mine = handoffs.filter((h) => h.missionId === ${JSON.stringify(missionId)});
    return {
      status: mission?.status ?? null,
      intentState: mission?.intentState ?? null,
      panes: panes.map((p) => ({
        role: p.role,
        title: p.title,
        agentName: p.agentName,
        state: p.state,
        adapterId: p.adapterId,
        readOnly: p.readOnly === true,
      })),
      handoffs: mine.map((h) => ({
        from: h.fromAgent,
        role: h.fromRole,
        status: h.status,
        deliveryState: h.deliveryState,
        summary: String(h.summary || '').slice(0, 180),
      })),
    };
  })()`);
  const workers = (last.panes || []).filter((p) => p.role === 'worker');
  maxWorkers = Math.max(maxWorkers, workers.length);
  const states = (last.handoffs || []).map((h) => h.deliveryState);
  const pasted = (last.handoffs || []).filter((h) => PASTED.has(h.deliveryState));
  const queued = (last.handoffs || []).filter((h) => h.deliveryState === 'queued');
  if (queued.length > 0 && queuedSince == null) queuedSince = Date.now();
  if (queued.length === 0) queuedSince = null;
  console.log(
    `[${new Date().toISOString().slice(11, 19)}] status=${last.status} ` +
      `intent=${last.intentState} panes=${last.panes.length} ` +
      `workers=${workers.length} handoffs=${states.join(',') || 'none'} ` +
      `pasted=${pasted.length}`,
  );
  for (const pane of last.panes) {
    console.log(
      `  pane ${pane.role} ${pane.agentName || pane.title} ` +
        `${pane.adapterId || ''} ${pane.state || ''} ` +
        `${pane.readOnly ? 'ro' : ''}`,
    );
  }
  for (const h of last.handoffs) {
    console.log(`  handoff ${h.from} ${h.deliveryState} ${h.summary}`);
  }

  const workersOk = workers.length >= 2;
  const pasteOk = pasted.length > 0;
  if (workersOk && pasteOk) break;
  if (
    queuedSince != null &&
    Date.now() - queuedSince > 90_000 &&
    pasted.length === 0
  ) {
    console.error('FAIL: handoff queued >90s sem colar no Maestro');
    break;
  }
  await new Promise((r) => setTimeout(r, 8_000));
}

const workers = (last?.panes || []).filter((p) => p.role === 'worker');
const pasted = (last?.handoffs || []).filter((h) => PASTED.has(h.deliveryState));
const panePass = workers.length >= 2 || maxWorkers >= 2;
const handoffPass = pasted.length > 0;
console.log('\nFINAL', JSON.stringify(last, null, 2));
console.log(`PANE_PROOF=${panePass ? 'PASS' : 'FAIL'} workers=${workers.length} max=${maxWorkers}`);
console.log(`HANDOFF_PROOF=${handoffPass ? 'PASS' : 'FAIL'} pasted=${pasted.length}`);
ws.close();
process.exit(panePass && handoffPass ? 0 : 1);
