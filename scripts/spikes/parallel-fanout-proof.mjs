/**
 * parallel-fanout-proof.mjs — STAGED live proof-harness (do NOT run casually).
 *
 * WHAT IT PROVES
 * --------------
 * That a SINGLE Nexus mission whose feature decomposes into ~11 stories via the
 * GUIDED plan path actually fans those stories out into ~11 worker panes that
 * execute CONCURRENTLY as multi-writers with pairwise-DISJOINT file ownership.
 * It reads the REAL dispatch ledger (task_dispatch_queue in the mission's
 * runtime.sqlite3), never the UI, and asserts the real invariant. It goes RED
 * honestly at HEAD and turns green only when the fan-out is truly operational.
 *
 * >>> AT HEAD d676d69a, ASSERTION #3 (disjoint ownership) IS EXPECTED TO FAIL. <<<
 * That red IS the proof of the gap: no decomposer populates per-story
 * ownershipFiles, so every isolated writer inherits the whole baseOwnership
 * inventory (guided-mission-planner.ts:483-486 ownershipFiles=baseOwnership and
 * :687/:711 files=[...ownershipFiles]); mission-wave-pack.ts ships the disjoint
 * design + assertWavePackStoryFilesDisjoint but the planner never calls it, so
 * there is at most one isolated executor writer — no 11-way multi-writer wave.
 *
 * >>> SEPARATE INTEGRATION STEP — NOT a unit test. <<<
 * The P0-3 wiring landed as unit-verified seams (commits 007888ae seam A +
 * 17096105 seam B): the decomposer now emits disjoint per-story ownershipFiles
 * and the dispatch claim invokes assertConcurrentIsolatedWorktreeDisjoint.
 * Because those are MAIN-PROCESS changes compiled into the running binary, this
 * live harness only reflects them after the dev app is REBUILT + RESTARTED from
 * this worktree (NEXUS_REMOTE_DEBUG=… npm start). Running it against a stale
 * binary proves nothing. Pane-level acceptance was the seam A/B unit tests;
 * this staged live run of the full 11-worker fan-out is a follow-up.
 *
 * >>> P0-8 / P0-9 / P0-10 landed the SAME way (unit-verified seams; live run
 *     DEFERRED to final review). <<<
 * Assertions #6 and #7 were ADDED below and go RED against a stale binary
 * exactly like #3 — they turn green only after the dev app is REBUILT +
 * RESTARTED from this worktree. The UNIT logic is already proven green by
 * targeted vitest (do NOT rebuild/restart the app or run the 85-story live
 * harness now — that is the deferred final-review step):
 *   - P0-8 NL fan-out: guided-mission-planner-seal.test.ts
 *     (resolveGuidedSealTopology routes a decomposable NL goal to wave-pack;
 *     a destructive goal stays serial, VISIBLY via guided_fanout_serialized) +
 *     mission-wave-pack.test.ts (decomposeGuidedGoalIntoStories).
 *   - P0-9 drain-to-exhaustion: mission-wave-pack.test.ts (85 disjoint stories
 *     seal past the old 64 ceiling) + mission-scheduler.test.ts (decideSchedule
 *     drains 85 across >=11 refilling waves to `complete`).
 *   - P0-10 dead-dependent cascade: mission-scheduler.test.ts +
 *     mission-scheduler-runtime.test.ts.
 * The two NEW live assertions:
 *   #6 NL-GOAL FAN-OUT — the mission below is a plain NL guided goal (no Pack,
 *      no promoted plan, no orchestrationMode). At HEAD it collapsed to ONE
 *      whole-repo executor (topology `delivery`); with P0-8 it must fan out to
 *      N>1 concurrent disjoint story writers. Asserts peak simultaneous story
 *      writers >= 2 on the pure NL path.
 *   #7 DRAIN TO EXHAUSTION — every sealed wave-pack story writer reaches a
 *      terminal state at mission-terminal with NOTHING truncated (the sealed
 *      story count is not clamped to 64). Point NEXUS_FANOUT_GOAL at an 85-file
 *      goal + NEXUS_FANOUT_TARGET_STORIES=85 to exercise the real >64 drain;
 *      the default 11-file goal proves the invariant at a tractable width.
 *
 * ============================ HOW TO RUN (review phase) =====================
 * PREREQUISITES
 *   - This worktree's DEV app is running (NOT the packaged app). The dev app
 *     answers HTTP GET /json for CDP discovery; the packaged app does not.
 *   - Launch the dev app of THIS worktree with CDP + vault off, e.g.:
 *
 *       NEXUS_REMOTE_DEBUG=9333 NEXUS_DEV_NO_VAULT=1 npm start
 *
 *     NEXUS_REMOTE_DEBUG opens the CDP port (HTTP /json/list + per-target ws).
 *     NEXUS_DEV_NO_VAULT=1 avoids the locked-keychain main-thread freeze.
 *     The dev app writes its state under THIS worktree's .dev-user-data
 *     (its NEXUS_USER_DATA_DIR), NOT ~/Library — that is where the mission's
 *     runtime.sqlite3 lives and where this harness reads it.
 *   - macOS: this harness clicks native Electron approval SHEETS via osascript
 *     (System Events). Grant the controlling terminal Accessibility permission
 *     (System Settings → Privacy & Security → Accessibility) or the named-button
 *     clicks silently no-op and the mission may stall at an approval gate.
 *   - `sqlite3` CLI must be on PATH (macOS ships /usr/bin/sqlite3). This harness
 *     reads the DB via the CLI on purpose: it never loads better-sqlite3, so it
 *     is immune to the shared-node_modules Electron-vs-node ABI trap.
 *
 * INVOKE
 *       node scripts/spikes/parallel-fanout-proof.mjs
 *
 * ENV (all optional; defaults shown)
 *   NEXUS_CDP_PORT=9333            CDP port = the NEXUS_REMOTE_DEBUG value.
 *   NEXUS_CDP_USER_DATA=./.dev-user-data
 *                                  This worktree's dev userData dir. Its
 *                                  project-runtime/ tree is scanned to resolve
 *                                  the mission's runtime.sqlite3 at runtime.
 *                                  (Also used as a fallback CDP discovery source
 *                                  via <userData>/DevToolsActivePort.)
 *   NEXUS_FANOUT_WORKSPACE=<tmp>   Scratch workspace the mission operates on.
 *   NEXUS_FANOUT_GOAL=<built-in>   Feature goal engineered to decompose into
 *                                  ~11 independent stories with disjoint files.
 *   NEXUS_FANOUT_TARGET_STORIES=11 Ideal fan-out width (informational).
 *   NEXUS_FANOUT_MIN_CONCURRENT=2  Minimum simultaneous active rows to PASS #2.
 *   NEXUS_FANOUT_DEADLINE_MS=900000  Overall wall-clock budget.
 *   NEXUS_FANOUT_POLL_MS=1500      DB poll cadence (deterministic; no fixed
 *                                  sleeps gate the assertions).
 *   NEXUS_FANOUT_APPROVE=1         1 = run the osascript sheet-approver loop.
 *
 * EXIT CODE: 0 only if ALL SIX gating assertions (#1–#4, #6, #7) pass; #5 is
 * informational. Against a stale (pre-P0-8/3) binary it exits non-zero because
 * #3/#6 (disjoint multi-writer fan-out) and the drain premise of #7 fail.
 * Do NOT weaken the assertions to make it pass — the red is the deliverable.
 * ===========================================================================
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = process.env.NEXUS_CDP_PORT ?? '9333';
const USER_DATA = path.resolve(
  process.env.NEXUS_CDP_USER_DATA ?? '.dev-user-data',
);
const WORKSPACE = path.resolve(
  process.env.NEXUS_FANOUT_WORKSPACE ??
    path.join(os.tmpdir(), `nexus-fanout-proof-${process.pid}`),
);
const TARGET_STORIES = Number(process.env.NEXUS_FANOUT_TARGET_STORIES ?? 11);
const MIN_CONCURRENT = Number(process.env.NEXUS_FANOUT_MIN_CONCURRENT ?? 2);
const DEADLINE_MS = Number(process.env.NEXUS_FANOUT_DEADLINE_MS ?? 900_000);
const POLL_MS = Number(process.env.NEXUS_FANOUT_POLL_MS ?? 1_500);
const DO_APPROVE = (process.env.NEXUS_FANOUT_APPROVE ?? '1') !== '0';

// A feature large enough that a real decomposer MUST cut it into ~11 stories,
// each touching its own file. If the guided fan-out is operational, the eleven
// stories become eleven concurrent isolated writers with disjoint ownership.
const GOAL =
  process.env.NEXUS_FANOUT_GOAL ??
  [
    'Implemente uma biblioteca de 11 utilitários independentes, um por arquivo,',
    'sem dependências entre eles, cada um com seu próprio teste:',
    'src/util/slugify.ts, src/util/debounce.ts, src/util/clamp.ts,',
    'src/util/chunk.ts, src/util/retry.ts, src/util/uuid.ts,',
    'src/util/deepEqual.ts, src/util/formatBytes.ts, src/util/parseDuration.ts,',
    'src/util/hexToRgb.ts, src/util/titleCase.ts. Cada história é isolada e',
    'toca apenas o seu arquivo — nada é compartilhado entre elas.',
  ].join(' ');

// task_dispatch_queue.state groups (schema: orchestration migration 016).
const ACTIVE_STATES = new Set([
  'claimed',
  'routed',
  'spawning',
  'running',
  'handoff_ready',
  'merging',
]);
// Physically-executing writer states: a row here holds a live worker process
// against a mutation surface (the same set guarded by the active-session unique
// index). read_only advisors are excluded from the disjointness invariant.
const WRITER_EXECUTION_MODES = new Set(['isolated_worktree', 'same_checkout']);
const TERMINAL_MISSION = new Set([
  'done',
  'completed',
  'success',
  'failed',
  'blocked',
  'blocked_user',
  'blocked_technical',
]);

// ---------------------------------------------------------------------------
// House RAW-CDP recipe (copied verbatim from e2e-fanout-done-proof.mjs):
// HTTP /json discovery → WebSocket driving of the renderer page target.
// ---------------------------------------------------------------------------
const listTargets = async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return res.json();
};

const targets = await listTargets();
const page = targets.find(
  (t) => t.type === 'page' && !String(t.url || '').includes('pet.html'),
);
if (!page) throw new Error('no renderer page target (is the DEV app running?)');

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

// ---------------------------------------------------------------------------
// osascript approver: click named buttons on native Electron approval SHEETS.
// SecurityAgent accepts NAMED clicks (not keyboard). Best-effort + idempotent;
// keeps the mission progressing so assertion #4 can observe a terminal state.
// ---------------------------------------------------------------------------
const APPROVE_BUTTONS = [
  'Approve',
  'Aprovar',
  'Allow',
  'Permitir',
  'Continue',
  'Continuar',
  'Yes',
  'Sim',
  'OK',
];
const APP_NAMES = ['Nexus', 'NexusIDE', 'Nexus IDE', 'Electron'];

const clickApprovalSheets = () => {
  if (!DO_APPROVE) return;
  for (const app of APP_NAMES) {
    for (const button of APPROVE_BUTTONS) {
      const script = `tell application "System Events"
  if exists (process "${app}") then
    tell process "${app}"
      repeat with w in windows
        try
          if exists (sheet 1 of w) then
            if exists (button "${button}" of sheet 1 of w) then
              click button "${button}" of sheet 1 of w
            end if
          end if
        end try
        try
          if exists (button "${button}" of w) then
            click button "${button}" of w
          end if
        end try
      end repeat
    end tell
  end if
end tell`;
      try {
        execFileSync('osascript', ['-e', script], {
          stdio: 'ignore',
          timeout: 4_000,
        });
      } catch {
        // No such app / no sheet / no accessibility grant — ignore and move on.
      }
    }
  }
};

// ---------------------------------------------------------------------------
// runtime.sqlite3 resolution + read-only queries via the sqlite3 CLI.
// The CLI keeps us off better-sqlite3 (shared-node_modules ABI trap).
// ---------------------------------------------------------------------------
const sqliteJson = (dbPath, sql) => {
  // -readonly first (WAL-safe concurrent read); fall back to a plain SELECT
  // connection if the readonly open is refused for any environmental reason.
  for (const args of [
    ['-readonly', '-json', dbPath, sql],
    ['-json', dbPath, sql],
  ]) {
    try {
      const out = execFileSync('sqlite3', args, {
        encoding: 'utf8',
        timeout: 15_000,
        maxBuffer: 64 * 1024 * 1024,
      }).trim();
      return out.length === 0 ? [] : JSON.parse(out);
    } catch (e) {
      if (args[0] === '-json') throw e; // second attempt failed for real
    }
  }
  return [];
};

const dbHasMission = (dbPath, missionId) => {
  try {
    const rows = sqliteJson(
      dbPath,
      `SELECT id FROM missions WHERE id = '${missionId}' LIMIT 1;`,
    );
    return rows.length > 0;
  } catch {
    return false;
  }
};

// Walk <userData>/project-runtime/**/runtime.sqlite3 and pick the DB that owns
// this mission. The runtime DB is created lazily on first dispatch, so this is
// polled until it appears — never hardcoded to a stale path.
const findRuntimeDbForMission = (missionId) => {
  const base = path.join(USER_DATA, 'project-runtime');
  let found = null;
  const walk = (dir, depth) => {
    if (depth > 6 || found) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name === 'runtime.sqlite3' && dbHasMission(full, missionId))
        found = full;
    }
  };
  walk(base, 0);
  return found;
};

// ---------------------------------------------------------------------------
// Dispatch-ledger reads (the source of truth for every assertion below).
// ---------------------------------------------------------------------------
const readDispatchRows = (dbPath, missionId) =>
  sqliteJson(
    dbPath,
    `SELECT task_id, state, execution_mode, ownership_json, worker_id,
            agent_ref, agent_category, session_id, pane_id, last_error,
            handoff_id
       FROM task_dispatch_queue
      WHERE mission_id = '${missionId}';`,
  );

const readMissionStatus = (dbPath, missionId) => {
  const rows = sqliteJson(
    dbPath,
    `SELECT status FROM missions WHERE id = '${missionId}' LIMIT 1;`,
  );
  return rows[0]?.status ?? null;
};

const readStuckMergeEntries = (dbPath) => {
  // merge_queue_state stores the queue as a JSON blob; a row still in
  // 'candidate-validating' at terminal time is the deadlock signature.
  const rows = sqliteJson(
    dbPath,
    `SELECT scope_key, state_json FROM merge_queue_state;`,
  );
  const stuck = [];
  for (const row of rows) {
    if (String(row.state_json || '').includes('candidate-validating')) {
      stuck.push(row.scope_key);
    }
  }
  return stuck;
};

const readHandoffs = (dbPath, missionId) =>
  sqliteJson(
    dbPath,
    `SELECT id, from_agent, status, delivered
       FROM handoffs WHERE mission_id = '${missionId}';`,
  );

const parseOwnershipFiles = (ownershipJson) => {
  try {
    const files = JSON.parse(ownershipJson || '{}')?.files;
    return Array.isArray(files) ? files.map((f) => String(f)) : [];
  } catch {
    return [];
  }
};

// ---------------------------------------------------------------------------
// 1) Create + kick off the GUIDED mission over CDP.
// ---------------------------------------------------------------------------
const started = await evaluate(
  `(async () => {
    const orch = window.nexus.orch;
    const log = [];
    try {
      await window.nexus.workspace.open(${JSON.stringify(WORKSPACE)});
      log.push({ k: 'workspace.open', v: ${JSON.stringify(WORKSPACE)} });
    } catch (e) {
      log.push({ k: 'workspace.open.error', v: String(e && e.message || e) });
    }

    const existing = await orch.listMissions();
    for (const m of existing) {
      try { await orch.closeMissionRuntime(m.id); } catch {}
      try { await orch.removeMission(m.id); } catch {}
    }

    const squads = await orch.listSquads();
    const squad =
      squads.find((s) => String(s.id || '').includes('agentic-runtime')) ||
      squads.find((s) => (s.agents || []).some((a) => a.category === 'orchestrator')) ||
      squads[0];
    if (!squad) return { error: 'no squad available', log };
    log.push({ k: 'squad', v: { id: squad.id, name: squad.name } });

    const armed = await orch.armMission({
      title: 'parallel fanout proof',
      squadId: squad.id,
    });
    const missionId = armed?.id || armed?.missionId || armed?.mission?.id;
    if (!missionId) return { error: 'armMission returned no id', armed, log };

    // GUIDED plan path: lane 'guided' + product-wizard review surface routes
    // through the guided-mission-planner decomposition under test.
    await orch.submitMissionIntent({
      missionId,
      goal: ${JSON.stringify(GOAL)},
      source: 'typed',
      lane: 'guided',
      contextPolicy: 'auto',
      acceptanceCriteria: [
        'Onze utilitários independentes, um por arquivo, cada um com teste',
      ],
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
console.log(`mission armed:  ${missionId} (squad ${started.squadId})`);
console.log(`workspace:      ${WORKSPACE}`);
console.log(`userData:       ${USER_DATA}`);
console.log(JSON.stringify({ startLog: started.log }, null, 2));

// ---------------------------------------------------------------------------
// 2) Poll the dispatch ledger; approve native sheets; track peak concurrency.
// ---------------------------------------------------------------------------
const cores = os.cpus().length; // mission-scheduler-production.ts:140
const coreBudget = Math.max(1, cores - 2); // mission-scheduler.ts:114

let dbPath = null;
let peak = { activeCount: 0, writers: [], rows: [] };
let lastStatus = null;
let terminalStatus = null;
let lastLine = '';

const deadline = Date.now() + DEADLINE_MS;
while (Date.now() < deadline) {
  clickApprovalSheets();

  if (!dbPath) dbPath = findRuntimeDbForMission(missionId);
  if (!dbPath) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    continue;
  }

  const rows = readDispatchRows(dbPath, missionId);
  const status = readMissionStatus(dbPath, missionId);
  lastStatus = status;

  const active = rows.filter((r) => ACTIVE_STATES.has(String(r.state)));
  // Writers whose disjointness the invariant is about: physically-active,
  // mutation-mode, with a non-empty declared file set.
  const writers = active
    .filter((r) => WRITER_EXECUTION_MODES.has(String(r.execution_mode)))
    .map((r) => ({
      taskId: r.task_id,
      state: r.state,
      agentRef: r.agent_ref,
      files: parseOwnershipFiles(r.ownership_json),
    }))
    .filter((w) => w.files.length > 0);

  // A single SELECT is one DB snapshot → active rows here are SIMULTANEOUS.
  if (active.length > peak.activeCount) {
    peak = { activeCount: active.length, writers, rows };
  } else if (active.length === peak.activeCount && writers.length > peak.writers.length) {
    peak = { activeCount: active.length, writers, rows };
  }

  const line =
    `[${new Date().toISOString().slice(11, 19)}] status=${status} ` +
    `active=${active.length} writers=${writers.length} ` +
    `peakActive=${peak.activeCount} peakWriters=${peak.writers.length}`;
  if (line !== lastLine) {
    console.log(line);
    lastLine = line;
  }

  if (status && TERMINAL_MISSION.has(String(status))) {
    terminalStatus = status;
    break;
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
}

// ---------------------------------------------------------------------------
// 3) Evaluate assertions against the peak-concurrency DB snapshot.
// ---------------------------------------------------------------------------
const results = {};

// #1 — mission created + reached dispatch (a runtime.sqlite3 with rows exists).
const anyDispatch = dbPath
  ? readDispatchRows(dbPath, missionId).length > 0
  : false;
results.assert1_missionDispatched = {
  pass: Boolean(dbPath) && anyDispatch,
  dbPath,
  evidence: 'SELECT count(*) FROM task_dispatch_queue WHERE mission_id = ?',
};

// #2 — >=MIN_CONCURRENT rows SIMULTANEOUSLY in an active state (target 11).
results.assert2_concurrentActive = {
  pass: peak.activeCount >= MIN_CONCURRENT,
  peakActive: peak.activeCount,
  min: MIN_CONCURRENT,
  target: TARGET_STORIES,
  evidence:
    "one snapshot of task_dispatch_queue.state IN (claimed,routed,spawning," +
    'running,handoff_ready,merging)',
};

// #3 — active isolated writers have pairwise-DISJOINT ownership file sets, AND
// there are >=2 such writers (a real multi-writer wave, not one executor).
// THIS IS THE HEAD GAP: every writer inherits the whole baseOwnership inventory.
const writers = peak.writers;
const overlaps = [];
for (let i = 0; i < writers.length; i++) {
  for (let j = i + 1; j < writers.length; j++) {
    const a = new Set(writers[i].files);
    const shared = writers[j].files.filter((f) => a.has(f));
    if (shared.length > 0) {
      overlaps.push({
        a: writers[i].taskId,
        b: writers[j].taskId,
        sharedCount: shared.length,
        sample: shared.slice(0, 3),
      });
    }
  }
}
results.assert3_disjointOwnership = {
  pass: writers.length >= 2 && overlaps.length === 0,
  writerCount: writers.length,
  overlaps,
  writerFileCounts: writers.map((w) => ({
    taskId: w.taskId,
    agentRef: w.agentRef,
    fileCount: w.files.length,
  })),
  evidence:
    'parse ownership_json.files per active isolated_worktree/same_checkout ' +
    'writer row; require >=2 writers and zero pairwise file overlap',
  note:
    'EXPECTED FAIL at HEAD d676d69a: guided-mission-planner emits a single ' +
    'executor writer with files=[...baseOwnership]; no per-story disjoint fanout.',
};

// #4 — handoffs land + merges drain: no candidate-validating stuck row, mission
// reaches a terminal state, and no dispatch row is stranded in 'merging'.
const stuckMerges = dbPath ? readStuckMergeEntries(dbPath) : ['<no-db>'];
const finalRows = dbPath ? readDispatchRows(dbPath, missionId) : [];
const strandedMerging = finalRows.filter((r) => String(r.state) === 'merging');
const handoffs = dbPath ? readHandoffs(dbPath, missionId) : [];
const undeliveredHandoffs = handoffs.filter((h) => Number(h.delivered) !== 1);
results.assert4_drainsNoDeadlock = {
  pass:
    Boolean(terminalStatus) &&
    stuckMerges.length === 0 &&
    strandedMerging.length === 0,
  terminalStatus,
  lastStatus,
  stuckMergeScopes: stuckMerges,
  strandedMergingTasks: strandedMerging.map((r) => r.task_id),
  handoffCount: handoffs.length,
  undeliveredHandoffs: undeliveredHandoffs.length,
  evidence:
    "merge_queue_state.state_json !~ 'candidate-validating'; missions.status " +
    'terminal; no task_dispatch_queue row stuck in merging',
};

// #5 — record host cores + effective cap so a <target width is EXPLAINED as
// host-core-capped vs logic-capped, never silently swallowed.
const widthExplanation =
  peak.activeCount >= TARGET_STORIES
    ? 'full fan-out reached'
    : peak.activeCount <= coreBudget
      ? `width ${peak.activeCount} <= coreBudget ${coreBudget}: HOST-CORE-CAPPED ` +
        '(add cores / raise cap to distinguish from a logic cap)'
      : `width ${peak.activeCount} < target ${TARGET_STORIES} but > coreBudget ` +
        `${coreBudget}: LOGIC-CAPPED (planner did not fan out ${TARGET_STORIES} stories)`;
results.assert5_capAccounting = {
  pass: true, // informational: never fails, always recorded
  hostLogicalCores: cores,
  coreBudget,
  peakActive: peak.activeCount,
  peakWriters: peak.writers.length,
  targetStories: TARGET_STORIES,
  widthExplanation,
  evidence:
    'os.cpus().length (mission-scheduler-production.ts:140); ' +
    'coreBudget=max(1,cores-2) (mission-scheduler.ts:114)',
};

// #6 — NL-GOAL FAN-OUT (P0-8): the mission above is a plain NL guided goal — no
// orchestrationMode, no wavePackStories, no promotedPlan. At HEAD it collapsed
// to ONE whole-repo executor (topology `delivery`). With P0-8 it must fan out to
// N>1 concurrent disjoint story writers via the wave-pack machinery. Reuses the
// peak-concurrency snapshot: >=2 simultaneous isolated writers on the pure NL
// path is the proof the collapse is gone.
results.assert6_nlGoalFanout = {
  pass: peak.writers.length >= 2,
  peakWriters: peak.writers.length,
  path: 'NL guided goal (no Pack, no promoted plan, no orchestrationMode)',
  evidence:
    'resolveGuidedSealTopology routes a decomposable NL goal to wave-pack ' +
    '(guided-mission-planner.ts); >=2 simultaneous isolated_worktree story ' +
    'writers observed in one task_dispatch_queue snapshot',
  note:
    'EXPECTED FAIL at a stale (pre-P0-8) binary: the NL goal seals one delivery ' +
    'executor, so peakWriters<2. Green only after rebuild+restart.',
};

// #7 — DRAIN TO EXHAUSTION (P0-9): every sealed wave-pack story writer reaches a
// terminal state at mission-terminal with NOTHING truncated. The old 64 seal
// ceiling would clamp a >64 decomposition; the drain must run to plan
// exhaustion (waves refill until done). Story writers are the rows carrying a
// `wave-pack-story:` ownership domain.
const parseOwnershipDomains = (ownershipJson) => {
  try {
    const domains = JSON.parse(ownershipJson || '{}')?.domains;
    return Array.isArray(domains) ? domains.map((d) => String(d)) : [];
  } catch {
    return [];
  }
};
const sealedStoryWriters = finalRows.filter((r) =>
  parseOwnershipDomains(r.ownership_json).some((d) =>
    d.startsWith('wave-pack-story:'),
  ),
);
const nonTerminalStoryWriters = sealedStoryWriters.filter((r) =>
  ACTIVE_STATES.has(String(r.state)),
);
const storyCountOk =
  TARGET_STORIES > 64
    ? sealedStoryWriters.length > 64 // >64 sealed → the 64 clamp is truly gone
    : sealedStoryWriters.length >= 2; // default width: real multi-story fan-out
results.assert7_drainToExhaustion = {
  pass:
    Boolean(terminalStatus) &&
    storyCountOk &&
    nonTerminalStoryWriters.length === 0,
  terminalStatus,
  sealedStoryWriters: sealedStoryWriters.length,
  nonTerminalStoryWriters: nonTerminalStoryWriters.map((r) => r.task_id),
  targetStories: TARGET_STORIES,
  evidence:
    'count of task_dispatch_queue rows whose ownership_json.domains include a ' +
    '`wave-pack-story:` entry; every one terminal (not IN active states) at a ' +
    'terminal mission status; sealed count not clamped to 64 (P0-9)',
  note:
    'Set NEXUS_FANOUT_GOAL to an 85-file goal + NEXUS_FANOUT_TARGET_STORIES=85 ' +
    'to exercise the real >64 drain. EXPECTED FAIL at a stale binary (no NL ' +
    'story writers sealed / >64 clamp still present).',
};

// ---------------------------------------------------------------------------
// Report + exit.
// ---------------------------------------------------------------------------
console.log('\n================ PARALLEL FAN-OUT PROOF ================');
console.log(JSON.stringify(results, null, 2));

const gating = [
  results.assert1_missionDispatched,
  results.assert2_concurrentActive,
  results.assert3_disjointOwnership,
  results.assert4_drainsNoDeadlock,
  results.assert6_nlGoalFanout,
  results.assert7_drainToExhaustion,
];
const allPass = gating.every((r) => r.pass);

console.log('\nSUMMARY');
console.log(`  #1 mission dispatched      : ${results.assert1_missionDispatched.pass ? 'PASS' : 'FAIL'}`);
console.log(`  #2 concurrent active (>=${MIN_CONCURRENT}) : ${results.assert2_concurrentActive.pass ? 'PASS' : 'FAIL'} (peak ${peak.activeCount})`);
console.log(`  #3 disjoint ownership      : ${results.assert3_disjointOwnership.pass ? 'PASS' : 'FAIL'}  <-- EXPECTED FAIL @ stale binary`);
console.log(`  #4 drains, no deadlock     : ${results.assert4_drainsNoDeadlock.pass ? 'PASS' : 'FAIL'}`);
console.log(`  #5 cap accounting          : ${results.assert5_capAccounting.widthExplanation}`);
console.log(`  #6 NL-goal fan-out (>=2)   : ${results.assert6_nlGoalFanout.pass ? 'PASS' : 'FAIL'} (peakWriters ${peak.writers.length})  <-- P0-8, EXPECTED FAIL @ stale binary`);
console.log(`  #7 drain to exhaustion     : ${results.assert7_drainToExhaustion.pass ? 'PASS' : 'FAIL'} (sealed story writers ${results.assert7_drainToExhaustion.sealedStoryWriters})  <-- P0-9`);
console.log(`\nFANOUT_PROOF=${allPass ? 'PASS' : 'FAIL'}`);

ws.close();
process.exit(allPass ? 0 : 1);
