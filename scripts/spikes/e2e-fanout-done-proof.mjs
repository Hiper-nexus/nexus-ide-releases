/**
 * Live proof: team-read-only-fanout ("teste de panes") reaches terminal done.
 * Drives the running QA Electron over CDP. Not part of the shipped app.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

const PORT = process.env.NEXUS_CDP_PORT ?? '9333';
const GOAL = process.env.NEXUS_E2E_GOAL ?? 'teste de panes';
const DEADLINE_MS = Number(process.env.NEXUS_E2E_DEADLINE_MS ?? 540_000);
const WORKSPACE =
  process.env.NEXUS_E2E_WORKSPACE ??
  path.resolve('.');

mkdirSync(WORKSPACE, { recursive: true });

const SUCCESS_STATUS = new Set(['done', 'completed', 'success']);
const TERMINAL = new Set([
  ...SUCCESS_STATUS,
  'failed',
  'blocked',
  'blocked_user',
  'blocked_technical',
]);

const listTargets = async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return res.json();
};

const targets = await listTargets();
const page = targets.find(
  (t) => t.type === 'page' && !String(t.url || '').includes('pet.html'),
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

// Wait for preload bridge
for (let i = 0; i < 30; i++) {
  const ready = await evaluate(
    `Boolean(window.nexus && window.nexus.orch && window.nexus.workspace)`,
  );
  if (ready) break;
  if (i === 29) throw new Error('window.nexus bridge not ready');
  await new Promise((r) => setTimeout(r, 1000));
}

const started = await evaluate(
  `(async () => {
    const log = [];
    const smokeWs = ${JSON.stringify(WORKSPACE)};
    try {
      await window.nexus.workspace.open(smokeWs);
      log.push({ k: 'workspace.open', v: smokeWs });
    } catch (e) {
      log.push({ k: 'workspace.open.error', v: String(e && e.message || e) });
    }
    const wsState = await window.nexus.workspace.get();
    log.push({ k: 'workspace.current', v: wsState?.current?.path });

    const existing = await window.nexus.orch.listMissions();
    for (const m of existing) {
      try { await window.nexus.orch.closeMissionRuntime(m.id); } catch {}
      try {
        await window.nexus.orch.removeMission(m.id);
        log.push({ k: 'removed', v: m.id });
      } catch (e) {
        log.push({ k: 'remove.fail', v: { id: m.id, err: String(e && e.message || e) } });
      }
    }

    const orch = window.nexus.orch;
    const squads = await orch.listSquads();
    const squad =
      squads.find((s) => String(s.id || '').includes('agentic-runtime')) ||
      squads.find((s) => (s.agents || []).some((a) => a.category === 'orchestrator')) ||
      squads[0];
    if (!squad) return { error: 'no squad available', log };
    log.push({
      k: 'squad',
      v: {
        id: squad.id,
        name: squad.name,
        agents: (squad.agents || []).map((a) => ({
          name: a.name,
          cat: a.category,
          adapter: a.adapterId,
        })),
      },
    });

    const armed = await orch.armMission({
      title: ${JSON.stringify(GOAL)},
      squadId: squad.id,
    });
    const missionId = armed?.id || armed?.missionId || armed?.mission?.id;
    if (!missionId) return { error: 'armMission returned no id', armed, log };

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
    return { missionId, squadId: squad.id, log };
  })()`,
);

if (started?.error) {
  console.log(JSON.stringify({ phase: 'start', ...started }, null, 2));
  ws.close();
  process.exit(1);
}

const missionId = started.missionId;
console.log(`mission armed: ${missionId} (squad ${started.squadId})`);
console.log(`workspace: ${WORKSPACE}`);
console.log(JSON.stringify({ startLog: started.log }, null, 2));

const deadline = Date.now() + DEADLINE_MS;
let snapshot = null;
let lastLine = '';

while (Date.now() < deadline) {
  snapshot = await evaluate(
    `(async () => {
      const orch = window.nexus.orch;
      const missions = await orch.listMissions();
      const mission = missions.find((m) => m.id === ${JSON.stringify(missionId)});
      if (!mission) return { missing: true };
      const panes = await orch.listMissionPanes(mission.id);
      let handoffs = [];
      try {
        handoffs = (await orch.listHandoffs({ includeDelivered: true })) || [];
      } catch {
        try { handoffs = (await orch.listHandoffs()) || []; } catch {}
      }
      const mine = handoffs.filter((h) => h.missionId === mission.id);
      return {
        status: mission.status,
        intentState: mission.intentState,
        blockKind: mission.blockKind || mission.block?.kind || null,
        blockCause: mission.blockCause || mission.block?.cause || null,
        paneCount: panes.length,
        panes: panes.map((p) => ({
          id: p.id || p.paneId,
          role: p.role,
          title: p.title,
          adapterId: p.adapterId,
          agentName: p.agentName,
          status: p.status || p.runtimeStatus || p.semanticStatus,
        })),
        handoffs: mine.map((h) => ({
          id: h.id,
          from: h.fromAgent,
          to: h.toAgent,
          status: h.status,
          deliveryState: h.deliveryState,
          summary: String(h.summary || h.body || '').slice(0, 160),
        })),
      };
    })()`,
  );

  const states = (snapshot.handoffs ?? []).map((h) => h.deliveryState);
  const line =
    `[${new Date().toISOString().slice(11, 19)}] status=${snapshot.status} ` +
    `intent=${snapshot.intentState} panes=${snapshot.paneCount} ` +
    `handoffs=${states.join(',') || 'none'} ` +
    `block=${snapshot.blockKind || '-'}`;
  if (line !== lastLine) {
    console.log(line);
    lastLine = line;
  }

  if (TERMINAL.has(String(snapshot.status))) break;
  await new Promise((r) => setTimeout(r, 5_000));
}

console.log('\nFINAL:');
console.log(JSON.stringify(snapshot, null, 2));

const status = String(snapshot?.status || '');
const states = (snapshot?.handoffs ?? []).map((h) => h.deliveryState);
const allConsumed =
  states.length > 0 && states.every((s) => s === 'consumed');
const doneProved = SUCCESS_STATUS.has(status);
const failedFast = (snapshot?.handoffs ?? []).some(
  (h) =>
    String(h.from || '').includes('watchdog') ||
    String(h.status || '') === 'failed' ||
    /mcp-auth|handshake|not logged in/i.test(String(h.summary || '')),
);

console.log(`\nDONE_PROOF=${doneProved ? 'PASS' : 'FAIL'}`);
console.log(`HANDOFF_CONSUMED=${allConsumed ? 'PASS' : 'FAIL'}`);
console.log(`FAILFAST_SIGNAL=${failedFast ? 'YES' : 'NO'}`);
console.log(`STATUS=${status}`);
console.log(`PANES=${snapshot?.paneCount ?? 0}`);
console.log(`HANDOFFS=${states.length}`);

ws.close();
process.exit(doneProved ? 0 : 1);
