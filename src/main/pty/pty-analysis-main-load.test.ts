import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import inspector from 'node:inspector';
import { compileIntentContract } from '../../shared/mission-intent';
import { resolveCurrentMissionSpawnAuthoritySeal } from '../orch/pane-registry';
import { applyScreenDetectionEvent, getAgentSemanticStatusBySession } from '../orch/agent-status';
import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { CliPtyAdapter } from '../../shared/adapter-types';
import type { HostControlMsg } from './pty-host-core';
import type { ProjectExecutionScope } from '../../shared/types';

vi.mock('../license-access', async () => (await import('../__tests__/licensed-access')).licensedAccessMock);
vi.mock('electron', async () => {
  const fs = await import('node:fs'); const path = await import('node:path'); const os = await import('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-f764-userdata-'));
  return { app: { getPath: () => root, getAppPath: () => process.cwd(), getVersion: () => 'finite-f764-fixture', isPackaged: false } };
});
vi.mock('../path-resolver', async (original) => ({
  ...(await original<typeof import('../path-resolver')>()),
  resolveSpawnBinary: () => ({ binPath: '/usr/bin/true', effectivePath: '/usr/bin:/bin', source: 'process-path' }),
  revalidateExecutable: () => true,
  cachedCliBinaryVersion: () => '0.160.0', probeCliBinaryVersion: async () => '0.160.0',
  realUserHome: () => path.join(os.tmpdir(), 'nexus-f764-no-native-profile'),
}));
vi.mock('./persistent-session', () => ({ planPersistentAgentSpawn: (input: { file: string; args: string[] }) => ({ mode: 'direct', file: input.file, args: input.args }) }));

vi.mock('../adapters/adapter-registry', async (original) => ({
  ...(await original<typeof import('../adapters/adapter-registry')>()),
  getAdapter: (id: string) => id === 'codex' ? adapter : null,
  isAdapterInstalled: () => true, isBuiltinAdapter: () => true,
  resolveAdapterBinary: () => ({ binPath: '/usr/bin/true', effectivePath: '/usr/bin:/bin', source: 'process-path' }),
}));
vi.mock('../persistence/provider-config-store', async (original) => ({
  ...(await original<typeof import('../persistence/provider-config-store')>()),
  prepareProviderSpawn: () => ({ ok: true, overrides: { binPath: '/usr/bin/true', keyEnv: {}, defaultModel: null, extraArgs: [], suppressEnv: [] } }),
  prepareProviderSpawnAuthoritative: async () => ({ ok: true, overrides: { binPath: '/usr/bin/true', keyEnv: {}, defaultModel: null, extraArgs: [], suppressEnv: [] } }),
}));
vi.mock('./pre-spawn-probe', async (original) => ({ ...(await original<typeof import('./pre-spawn-probe')>()), assertPreSpawnProbe: async () => {} }));

import { spawnMainOwnedAgentSession, setPtyHost, orchTerminateSession, publishSessionActivityState, getAgentSessionInfo, getSessionState } from './pty-manager';
import { createPtyHostBridge } from './pty-host-core';
import { PtyOutputCredits } from './pty-output-credits';
import { analysisClient, setPtyAnalysisWorkerFactoryForTests, startPtyAnalysis, shutdownPtyAnalysis, flushPtyAnalysis } from './pty-analysis-runtime';
import { startAgentScreenDetection } from '../detect/detector';
import { initPaneRegistry, listPaneSnapshots } from '../orch/pane-registry';
import { initFailover, shutdownFailover } from '../orch/failover';
import { initCostTracker } from '../orch/cost-tracker';
import { initTokenSpeedTracker } from '../orch/token-speed-tracker';
import { installLegacyParser } from '../orch/mcp-server';
import { PtyStreamMissionControl } from '../orch/pty-stream-mission-control';
import { cliPromptAutoResponder } from '../orch/cli-prompt-autoresponder';
import { missionMarkerObserver } from '../orch/mission-completion-marker';
import { watchPasteIngest, CODEX_PASTE_MARKER } from '../orch/paste-ingest';
import { initPanePipes } from '../orch/pane-pipe';
import { initDelegationSupervisor, reconcileDelegationSupervisor, shutdownDelegationSupervisor } from '../orch/delegation-supervisor';
import { configureProjectDomainStoreRegistry, getProjectDomainStores, disposeProjectDomainStoreRegistry } from '../orch/project-domain-store-registry';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { setMainOwnedPane, deleteMainOwnedPane } from '../orch/main-owned-pane-runtime';
import { configureWorktreeRuntimeRegistry, disposeWorktreeRuntimeRegistry } from '../runtime/worktree-runtime-registry';
import { spawnPaneAndMaybePrompt } from '../orch/tool-util';
import { CommandBlockTracker } from '../terminal/command-block-tracker';
import { allocateIsolatedWriterWorktree } from '../orch/isolated-writer-worktree';

const adapter = {
  kind: 'cli-pty', id: 'codex', label: 'finite fake-host Codex fixture', bin: 'true',
  install: { command: '', check: '--version' }, auth: { method: 'none' },
  spawn: { interactive: ['true'], headless: ['true'], ptyRequired: true, resumeArgs: [], extraArgs: [] },
  env: { static: {}, passthrough: [], ephemeralHome: false },
  models: { flag: '--model', list: ['gpt-6-sol'], default: 'gpt-6-sol' },
  promptInjection: { method: 'arg', trailingNewline: true, bracketedPaste: false },
  stateParsing: { idle: { type: 'timeout', ms: 500 }, shellIntegration: false, exitCodes: {} },
  quirks: { altScreen: false, requiresNoAutoUpdate: false, mcpAutoload: false, nexusMcp: 'none' },
  control: { permission: { safe: [], yolo: [], modes: {}, default: '' } },
} as unknown as CliPtyAdapter;

it('drives the real Main PTY bridge with 15 bounded sessions and production supervisor', async () => {
  const artifactDir = process.env.F764_ARTIFACT_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-f764-main-load-'));
  fs.mkdirSync(artifactDir, { recursive: true });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-f764-project-')));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.name', 'Finite Fixture'); git('config', 'user.email', 'fixture@example.test');
  fs.writeFileSync(path.join(root, 'fixture.txt'), 'base\n'); git('add', 'fixture.txt'); git('commit', '-qm', 'finite fixture');
  const scope: ProjectExecutionScope = { version: 1, installationId: 'finite-fixture', projectId: 'f764', checkoutId: 'main', rootRealPath: root, identitySource: 'manifest' };
  const manager = new ProjectRuntimeManager({ baseDir: fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-f764-runtime-')), appVersion: 'fixture' });
  configureProjectDomainStoreRegistry(manager); configureWorktreeRuntimeRegistry(manager);
  initDelegationSupervisor(); const suite = getProjectDomainStores(scope);
  const mission = suite.missions.create({ title: 'Finite F764 load', description: 'Finite fixture' });
  const intent = compileIntentContract({ goal: 'Finite F764 production-load fixture', intentVersion: 1, freeAgentChoice: true });
  suite.missions.update(mission.id, { status: 'running', intentState: 'dispatched', intentVersion: 1, intentContract: { ...intent, budgets: { planningTokens: 1200, executionTokens: 8000, maxWorkers: 20, maxSteps: 1000 }, intentVersion: 1, approvedAt: Date.now(), dispatchedAt: Date.now() } });
  const authoritySeal = resolveCurrentMissionSpawnAuthoritySeal(scope, mission.id);
  const ids: string[] = []; const paused = new Set<string>(); const credits = new Map<string, PtyOutputCredits>();
  let generatedBytes = 0; let receivedBytes = 0; let supervisorScans = 0;
  const generatedHashes = new Map<string, ReturnType<typeof createHash>>(); const receivedHashes = new Map<string, ReturnType<typeof createHash>>();
  const receivedChunks = new Map<string, number>();
  const bridge = createPtyHostBridge({ ensure: () => {}, post: (message: HostControlMsg) => {
    if (message.type === 'spawn') credits.set(message.sessionId, new PtyOutputCredits({
      send: (data) => { receivedBytes += Buffer.byteLength(data); receivedHashes.get(message.sessionId)?.update(data); receivedChunks.set(message.sessionId, (receivedChunks.get(message.sessionId) ?? 0) + 1); bridge.dispatchEvent({ type: 'data', sessionId: message.sessionId, data }); },
      pause: () => { paused.add(message.sessionId); }, resume: () => { paused.delete(message.sessionId); },
    }));
    else if (message.type === 'analysis-credit') credits.get(message.sessionId)?.grant(message.bytes);
    else if (message.type === 'output-flow') { if (message.paused) paused.add(message.sessionId); else paused.delete(message.sessionId); }
    else if (message.type === 'terminate') { bridge.dispatchEvent({ type: 'exit', sessionId: message.sessionId, exitCode: 0 }); bridge.dispatchEvent({ type: 'termination-result', sessionId: message.sessionId, requestId: message.requestId, proof: { ok: true, rootExited: true, descendantsExited: true } }); }
  } });
  setPtyHost(bridge.host);
  const workerEntry = process.env.F764_WORKER_ENTRY ?? '/tmp/nexus-f764-worker-build/pty-analysis-worker-entry.js';
  setPtyAnalysisWorkerFactoryForTests(() => new Worker(workerEntry, { workerData: { manifestDir: path.join(process.cwd(), 'resources/agent-detection') } }));
  startPtyAnalysis(); initPaneRegistry(); const stopScreen = startAgentScreenDetection(); initFailover(); initCostTracker(); initTokenSpeedTracker(); initPanePipes();
  const missionControl = new PtyStreamMissionControl({ isAuthorized: (id) => Boolean(getAgentSessionInfo(id)), isInjectableIdle: () => false, write: () => false, invoke: async () => ({ ok: false, tool: 'fixture', error: 'finite fixture does not issue tool actions' }) });
  installLegacyParser(missionControl);
  const finishedCommands: import('../../shared/command-block').CommandBlock[] = [];
  const commandTracker = new CommandBlockTracker({ isEnabled: () => true, onBlock: (block) => finishedCommands.push(block) }); commandTracker.start();
  const spawnTimes: number[] = [];
  const spawn = (index: number) => {
    const paneId = `finite-${index}`; const before = performance.now();
    const result = spawnMainOwnedAgentSession({ kind: 'cli-agent', adapterId: 'codex', paneId, cols: 120, rows: 40 }, adapter, {}, {
      source: 'pending', scope, coordinationScope: scope, cwd: root, context: { scope, authoritySeal, missionId: mission.id, role: index === 0 ? 'orchestrator' : 'worker', agentName: paneId, readOnly: false, workerIncarnationId: `inc-${index}`, allowedTools: null, allowedSkills: null },
    });
    spawnTimes.push(performance.now() - before); ids.push(result.sessionId);
    generatedHashes.set(result.sessionId, createHash('sha256')); receivedHashes.set(result.sessionId, createHash('sha256'));
    commandTracker.bindSession(result.sessionId, { paneId, workspaceId: 'f764-fixture', cwd: root, shell: 'finite-fake-cli' });
    cliPromptAutoResponder.bind(result.sessionId, 'codex');
    missionMarkerObserver.registerPrompt(result.sessionId, 'Faça a prova e escreva PRONTO: resumo');
    setMainOwnedPane(paneId, { entry: { paneId, sessionId: result.sessionId, title: paneId, kind: 'cli-agent', adapterId: 'codex' }, meta: { scope, missionId: mission.id, role: index === 0 ? 'orchestrator' : 'worker', agentName: paneId, authoritySeal, ...(index > 0 ? { workerIncarnationId: `inc-${index}` } : {}), allowedTools: null, allowedSkills: null, readOnly: false } });
    suite.missionPanes.record({ missionId: mission.id, adapterId: 'codex', title: paneId, paneId, role: index === 0 ? 'orchestrator' : 'worker', agentName: paneId, cwd: root, ...(index > 0 ? { workerIncarnationId: `inc-${index}` } : {}), authoritySeal });
    return result.sessionId;
  };
  for (let index = 0; index < 15; index++) spawn(index);
  await Promise.all(ids.map((id) => flushPtyAnalysis(id)));
  const pasteWatch = watchPasteIngest(ids[0], { marker: CODEX_PASTE_MARKER, capMs: 5_000 });
  let pasteOutcome: string | null = null; void pasteWatch.done.then((outcome) => { pasteOutcome = outcome; });
  const lag = monitorEventLoopDelay({ resolution: 5 }); lag.enable();
  let maxBlock = 0; let heartbeatAt = performance.now();
  const heartbeat = setInterval(() => { const now = performance.now(); maxBlock = Math.max(maxBlock, now - heartbeatAt - 5); heartbeatAt = now; }, 5);
  const profile = new inspector.Session(); profile.connect();
  const post = (method: string) => new Promise<Record<string, unknown>>((resolve, reject) => profile.post(method as 'Profiler.enable', (error: Error | null, value: object) => error ? reject(error) : resolve(value as Record<string, unknown> ?? {})));
  await post('Profiler.enable'); await post('Profiler.start');
  const duration = Number(process.env.F764_LOAD_MS ?? 1_000); const start = performance.now(); const flood = 'é'.repeat(16_384); const frame = '\x1b[2K\rWorking…\n';
  const allocations: Promise<unknown>[] = []; let allocationError: unknown = null; let routedSpawnWallMs = 0;
  let pastedMarkerSent = false; let finalSession: string | null = null;
  let lastSideFrame = -Infinity; let lastSupervisor = start; let allocationStarted = false;
  try {
    while (performance.now() - start < duration) {
      const elapsed = performance.now() - start;
      // Admit only when the actual host credit transport permits more data.
      const sideFrameDue = performance.now() - lastSideFrame >= 25;
      for (let index = 0; index < ids.length; index++) if (!paused.has(ids[index]) && (index === 0 || sideFrameDue)) {
        let data = index === 0 ? flood : frame;
        if (index === 0 && !pastedMarkerSent && elapsed > 50) { data = 'é'.repeat(8_000) + '[Pasted Content 1234 chars]' + 'é'.repeat(8_000); pastedMarkerSent = true; }
        generatedBytes += Buffer.byteLength(data); generatedHashes.get(ids[index])!.update(data); credits.get(ids[index])!.push(data);
      }
      if (sideFrameDue && Math.floor(elapsed / 500) % 2 === 1) for (const id of ids.slice(1, 15)) publishSessionActivityState(id, 'idle');
      if (sideFrameDue) lastSideFrame = performance.now();
      if (elapsed > 150 && !allocationStarted) {
        allocationStarted = true;
        allocations.push(allocateIsolatedWriterWorktree(scope, mission.id).then(async (allocation) => {
          const before = performance.now();
          const result = await spawnPaneAndMaybePrompt({ adapterId: 'codex', scope, executionScope: { ...scope, rootRealPath: allocation.worktreePath }, cwd: allocation.worktreePath, missionId: mission.id,
            role: 'worker', agentName: 'Finite allocated worker', workerIncarnationId: 'inc-allocated', isolatedWriter: true, executionMode: 'isolated_worktree', freeAgentChoice: true, allowedTools: null, allowedSkills: null });
          routedSpawnWallMs = performance.now() - before; ids.push(result.sessionId);
          generatedHashes.set(result.sessionId, createHash('sha256')); receivedHashes.set(result.sessionId, createHash('sha256'));
          allocation.link(result.paneId, result.sessionId); return allocation;
        }).catch((error) => { allocationError = error; return null; }));
      }
      if (performance.now() - lastSupervisor >= 100) { reconcileDelegationSupervisor(); supervisorScans++; lastSupervisor = performance.now(); }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await Promise.all(allocations); if (allocationError) throw allocationError;
    await Promise.all(ids.map((id) => flushPtyAnalysis(id)));
    finalSession = ids[14];
    const final = '\x1b]133;E;echo finite-final\x07\x1b]133;B\x07\x1b]133;D;0\x07\n### NEXUS_HANDOFF v1\n{"status":"success","summary":"Finite fixture handoff after complete byte transport","artifacts":[]}\nPRONTO: finite final completion';
    generatedBytes += Buffer.byteLength(final); generatedHashes.get(finalSession)!.update(final); credits.get(finalSession)!.push(final);
    credits.get(finalSession)!.seal(() => bridge.dispatchEvent({ type: 'exit', sessionId: finalSession!, exitCode: 0 }));
    await flushPtyAnalysis(finalSession);
    const finalMarker = missionMarkerObserver.markerOf(finalSession);
    const finalHandoffs = analysisClient.evidence(finalSession, 'handoff');
    const elapsedMs = performance.now() - start;
    const idleWorker = ids[1];
    applyScreenDetectionEvent({ sessionId: idleWorker, state: 'working', visibleIdle: false, visibleBlocker: false, visibleWorking: true, now: Date.now() });
    publishSessionActivityState(idleWorker, 'idle');
    reconcileDelegationSupervisor(Date.now() + 25 * 60_000); supervisorScans++;
    const supervisorHandoffs = suite.handoffs.list({ missionId: mission.id, includeDelivered: true }).filter((h) => h.status === 'stalled');
    maxBlock = Math.max(maxBlock, performance.now() - heartbeatAt - 5);
    const cpu = await post('Profiler.stop'); fs.writeFileSync(path.join(artifactDir, 'main.cpuprofile'), JSON.stringify(cpu.profile));
    const checksums = ids.map((id) => ({ sessionId: id, generated: generatedHashes.get(id)!.digest('hex'), received: receivedHashes.get(id)!.digest('hex'), chunks: receivedChunks.get(id) ?? 0 }));
    const metrics = { pasteOutcome, finalCompletion: finalMarker?.kind, finalHandoffs: finalHandoffs.length, finalCommands: finishedCommands.length, missionStatus: suite.missions.get(mission.id)?.status, workerState: getSessionState(idleWorker), supervisorPaneStates: listPaneSnapshots().filter((p) => p.missionId === mission.id).map((p) => ({ paneId: p.paneId, role: p.role, state: p.state })), supervisorStallHandoffs: supervisorHandoffs.length, semanticWorkerStatus: getAgentSemanticStatusBySession(idleWorker)?.status, routedSpawnWallMs, checksums, label: 'production Main + fake credit host', head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), fixtureBase: git('rev-parse', 'HEAD').trim(), runtime: process.version, sessions: ids.length, generatedBytes, receivedBytes, elapsedMs,
      receivedBytesPerSec: receivedBytes * 1000 / elapsedMs, p99LagMs: lag.percentile(99) / 1e6, maxBlockingMs: maxBlock, maxSpawnBlockingMs: Math.max(...spawnTimes), supervisorScans,
      analysis: analysisClient.metrics(), liveAgentBindings: ids.filter((id) => getAgentSessionInfo(id)).length,
      limitations: ['Signed native host and hard-watchdog fault run still pending; do not treat this partial harness as C.1/C.2 acceptance'] };
    fs.writeFileSync(path.join(artifactDir, 'metrics.json'), JSON.stringify(metrics, null, 2)); console.log(`F764 artifacts: ${artifactDir}`);
    expect(pasteOutcome).toBe('marker'); expect(finalMarker?.kind).toBe('done'); expect(finalHandoffs).toHaveLength(1); expect(finishedCommands.some((block) => block.command === 'echo finite-final' && block.status === 'success')).toBe(true);
    expect(supervisorHandoffs.some((h) => h.summary.includes('[travado]'))).toBe(true);
    expect(checksums.every((entry) => entry.generated === entry.received)).toBe(true); expect(supervisorScans).toBeGreaterThan(0); expect(metrics.liveAgentBindings).toBe(15);
    expect(metrics.analysis.degraded).toBe(false); expect(metrics.analysis.highwaterBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(metrics.p99LagMs).toBeLessThan(100); expect(metrics.maxBlockingMs).toBeLessThan(1_000); expect(metrics.maxSpawnBlockingMs).toBeLessThan(100);
  } finally {
    pasteWatch.cancel(); clearInterval(heartbeat); lag.disable(); profile.disconnect(); stopScreen(); commandTracker.stop(); shutdownFailover(); shutdownDelegationSupervisor();
    for (const id of ids) await orchTerminateSession(id);
    ids.forEach((_, index) => deleteMainOwnedPane(`finite-${index}`));
    await shutdownPtyAnalysis(); disposeWorktreeRuntimeRegistry(); disposeProjectDomainStoreRegistry(); manager.closeAll();
  }
}, 120_000);
