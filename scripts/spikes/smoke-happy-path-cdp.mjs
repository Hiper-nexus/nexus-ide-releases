// Smoke limpo via CDP: workspace scratch → arm → intent → approve → panes.
// Uso: SMOKE_WS=/tmp/foo node scripts/spikes/smoke-happy-path-cdp.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

const userData =
  process.env.NEXUS_CDP_USER_DATA ??
  path.resolve('.dev-user-data-qa');
const smokeWs =
  process.env.SMOKE_WS ??
  path.join('/tmp', `nexus-smoke-happy-${process.pid}`);
mkdirSync(smokeWs, { recursive: true });

const [port, wsPath] = readFileSync(
  path.join(userData, 'DevToolsActivePort'),
  'utf8',
)
  .trim()
  .split('\n');
const url = `ws://127.0.0.1:${port}${wsPath}`;

const ws = new WebSocket(url, { maxPayload: 256 * 1024 * 1024 });
let seq = 0;
const pending = new Map();
const send = (method, params = {}, sessionId, timeoutMs = 30_000) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    const t = setTimeout(
      () => reject(new Error(`timeout ${method}`)),
      timeoutMs,
    );
    pending.set(id, { resolve, reject, t });
    ws.send(
      JSON.stringify({
        id,
        method,
        params,
        ...(sessionId ? { sessionId } : {}),
      }),
    );
  });

ws.on('message', (raw) => {
  const msg = JSON.parse(String(raw));
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject, t } = pending.get(msg.id);
    clearTimeout(t);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  }
});

await new Promise((resolve, reject) => {
  ws.on('open', resolve);
  ws.on('error', reject);
  setTimeout(() => reject(new Error('open timeout')), 5000);
});

const { targetInfos } = await send('Target.getTargets');
const page = targetInfos.find(
  (t) => t.type === 'page' && !t.url.includes('pet.html'),
);
if (!page) throw new Error('no page target');
const { sessionId } = await send('Target.attachToTarget', {
  targetId: page.targetId,
  flatten: true,
});

const evalSource = `(async () => {
  const smokeWs = ${JSON.stringify(smokeWs)};
  const log = [];
  const step = (k, v) => log.push({ k, v });

  try {
    const opened = await window.nexus.workspace.open(smokeWs);
    step('workspace.open', opened ?? true);
  } catch (e) {
    step('workspace.open.error', String(e && e.message || e));
  }
  const wsState = await window.nexus.workspace.get();
  step('workspace.current', wsState?.current?.path);

  const existing = await window.nexus.orch.listMissions();
  for (const m of existing) {
    try { await window.nexus.orch.closeMissionRuntime(m.id); } catch {}
    try {
      await window.nexus.orch.removeMission(m.id);
      step('removed', m.id);
    } catch (e) {
      step('remove.fail', { id: m.id, err: String(e && e.message || e) });
    }
  }

  const squads = await window.nexus.orch.listSquads();
  const squad =
    squads.find((s) => String(s.id || '').includes('agentic-runtime')) ||
    squads.find((s) => (s.agents || []).some((a) => a.category === 'orchestrator')) ||
    squads[0];
  step('squad', {
    id: squad?.id,
    name: squad?.name,
    agents: (squad?.agents || []).map((a) => ({
      name: a.name,
      cat: a.category,
      adapter: a.adapterId,
    })),
  });
  if (!squad?.id) return { ok: false, reason: 'no_squad', log };

  const goal =
    'Crie o arquivo SMOKE_OK.txt na raiz do workspace contendo exatamente a linha nexus-smoke-ok e pare. Nao faca mais nada.';

  let armed;
  try {
    armed = await window.nexus.orch.armMission({
      title: 'smoke happy path',
      squadId: squad.id,
    });
    step('arm', armed);
  } catch (e) {
    step('arm.error', String(e && e.message || e));
    return { ok: false, log };
  }
  const missionId = armed?.id || armed?.missionId || armed?.mission?.id;
  if (!missionId) return { ok: false, reason: 'no_mission_id', log };

  try {
    const planned = await window.nexus.orch.submitMissionIntent({
      missionId,
      goal,
      source: 'typed',
      lane: 'ops',
      contextPolicy: 'none',
      acceptanceCriteria: [
        'Arquivo SMOKE_OK.txt existe com conteudo nexus-smoke-ok',
      ],
      planReviewSurface: 'product-wizard',
    });
    step('intent', {
      status: planned?.status,
      intentState: planned?.intentState,
    });
  } catch (e) {
    step('intent.error', String(e && e.message || e));
    return { ok: false, missionId, log };
  }

  try {
    const approved = await window.nexus.orch.approveMissionIntent({ missionId });
    step('approve', {
      status: approved?.status,
      intentState: approved?.intentState,
      orch: approved?.orchestratorSessionId,
    });
  } catch (e) {
    step('approve.error', String(e && e.message || e));
    return { ok: false, missionId, log };
  }

  const deadline = Date.now() + 90_000;
  let last = null;
  while (Date.now() < deadline) {
    const missions = await window.nexus.orch.listMissions();
    const m = missions.find((x) => x.id === missionId) || missions[0];
    const panes = m ? await window.nexus.orch.listMissionPanes(m.id) : [];
    const eventsWrap = m
      ? await window.nexus.orch.missionEventsRecent({
          missionId: m.id,
          limit: 50,
        })
      : null;
    const events = eventsWrap?.events || eventsWrap || [];
    const bad = events.filter(
      (e) =>
        e.payload?.reason ===
          'orchestrator_session_exited_before_first_dispatch' ||
        String(e.payload?.outputTail || '').includes('supervisor is missing'),
    );
    last = {
      status: m?.status,
      intentState: m?.intentState,
      orch: m?.orchestratorSessionId,
      paneCount: panes.length,
      panes: panes.map((p) => ({
        role: p.role,
        adapter: p.adapterId,
        title: p.title,
      })),
      badCount: bad.length,
      lastBad: bad.at(-1)?.payload?.outputTail?.slice?.(0, 180) || null,
      recent: events
        .slice(-10)
        .map((e) => e.type + (e.payload?.reason ? ':' + e.payload.reason : '')),
    };
    const hasWorker = panes.some((p) => p.role === 'worker');
    if (hasWorker && (m?.status === 'running' || m?.intentState === 'executing')) {
      break;
    }
    if (bad.length >= 2 && m?.status === 'blocked') break;
    await new Promise((r) => setTimeout(r, 3000));
  }

  return { ok: true, missionId, smokeWs, last, log };
})()`;

const evaluated = await send(
  'Runtime.evaluate',
  {
    expression: evalSource,
    returnByValue: true,
    awaitPromise: true,
  },
  sessionId,
  120_000,
);

const value = evaluated.result?.value ?? evaluated;
writeFileSync('/tmp/nexus-smoke-happy.json', JSON.stringify(value, null, 2));
console.log(JSON.stringify(value, null, 2).slice(0, 12000));
ws.close();
process.exit(value?.ok && value?.last?.badCount === 0 && value?.last?.paneCount > 0 ? 0 : 2);
