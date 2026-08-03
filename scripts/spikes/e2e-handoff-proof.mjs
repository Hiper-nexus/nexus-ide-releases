/**
 * Live end-to-end proof that a mission is born, executes and TERMINATES:
 * panes spawn, workers submit handoffs, and every handoff leaves `queued`
 * and reaches `consumed`.
 *
 * Drives the running dev app over CDP. Not part of the shipped app.
 */
import WebSocket from 'ws';

const PORT = process.env.NEXUS_CDP_PORT ?? '9333';
const GOAL = process.env.NEXUS_E2E_GOAL ?? 'teste de panes';
const DEADLINE_MS = Number(process.env.NEXUS_E2E_DEADLINE_MS ?? 420_000);

const listTargets = async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return res.json();
};

const targets = await listTargets();
const page = targets.find(
  (t) => t.type === 'page' && !t.url.includes('pet.html'),
);
if (!page) throw new Error('no renderer page target');

const ws = new WebSocket(page.webSocketDebuggerUrl, {
  maxPayload: 256 * 1024 * 1024,
});
let seq = 0;
const pending = new Map();

const send = (method, params = {}, timeoutMs = 60_000) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(
      () => reject(new Error(`${method} timed out`)),
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

const started = await evaluate(
  `(async () => {
    const orch = window.nexus.orch;
    const squads = await orch.listSquads();
    const squad =
      squads.find((s) => String(s.id || '').includes('agentic-runtime')) ||
      squads.find((s) => (s.agents || []).some((a) => a.category === 'orchestrator')) ||
      squads[0];
    if (!squad) return { error: 'no squad available' };
    const armed = await orch.armMission({
      title: ${JSON.stringify(GOAL)},
      squadId: squad.id,
    });
    const missionId = armed?.id || armed?.missionId || armed?.mission?.id;
    if (!missionId) return { error: 'armMission returned no id', armed };
    await orch.submitMissionIntent({
      missionId,
      goal: ${JSON.stringify(GOAL)},
      source: 'typed',
      lane: 'standard',
      contextPolicy: 'none',
      acceptanceCriteria: ['Panes nascem e respondem sem criar tasks de codigo'],
      planReviewSurface: 'product-wizard',
    });
    await orch.approveMissionIntent({ missionId });
    return { missionId, squadId: squad.id };
  })()`,
);

if (started?.error) {
  console.log(JSON.stringify({ phase: 'start', ...started }, null, 2));
  ws.close();
  process.exit(1);
}

const missionId = started.missionId;
console.log(`mission armed: ${missionId} (squad ${started.squadId})`);

const TERMINAL = new Set(['done', 'completed', 'success', 'failed', 'blocked']);
const deadline = Date.now() + DEADLINE_MS;
let snapshot = null;

while (Date.now() < deadline) {
  snapshot = await evaluate(
    `(async () => {
      const orch = window.nexus.orch;
      const missions = await orch.listMissions();
      const mission = missions.find((m) => m.id === ${JSON.stringify(missionId)});
      if (!mission) return { missing: true };
      const panes = await orch.listMissionPanes(mission.id);
      const handoffs = (await orch.listHandoffs({ includeDelivered: true })) || [];
      const mine = handoffs.filter((h) => h.missionId === mission.id);
      return {
        status: mission.status,
        intentState: mission.intentState,
        paneCount: panes.length,
        roles: panes.map((p) => p.role),
        handoffs: mine.map((h) => ({
          from: h.fromAgent,
          status: h.status,
          deliveryState: h.deliveryState,
        })),
      };
    })()`,
  );
  const states = (snapshot.handoffs ?? []).map((h) => h.deliveryState);
  console.log(
    `[${new Date().toISOString().slice(11, 19)}] status=${snapshot.status} ` +
      `intent=${snapshot.intentState} panes=${snapshot.paneCount} ` +
      `handoffs=${states.join(',') || 'none'}`,
  );
  const allConsumed =
    states.length > 0 && states.every((s) => s === 'consumed');
  if (allConsumed || TERMINAL.has(String(snapshot.status))) break;
  await new Promise((r) => setTimeout(r, 6_000));
}

console.log('\nFINAL:');
console.log(JSON.stringify(snapshot, null, 2));

const states = (snapshot?.handoffs ?? []).map((h) => h.deliveryState);
const proved = states.length > 0 && states.every((s) => s === 'consumed');
console.log(`\nHANDOFF_PROOF=${proved ? 'PASS' : 'FAIL'}`);
ws.close();
process.exit(proved ? 0 : 1);
