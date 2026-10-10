/**
 * F-1109: actual Main prepare/start/direct, scoped SQLite/current gates, real
 * PTY and an explicitly controlled physical CLI, with an optional installed
 * Claude mode. Provider conversation/inference is controlled. The first
 * authentic UserPromptSubmit request is held at HTTP ingress;
 * no status/acceptance/busy event is fabricated by this test.
 * Opt in explicitly; normal unit suites never launch a provider CLI.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, fork, type ChildProcess } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliPtyAdapter } from '../../shared/adapter-types';
import type { ProjectExecutionScope } from '../../shared/types';
import type { HostControlMsg, HostEventMsg } from '../pty/pty-host-core';
import type { Mission } from '../../shared/orch-types';
import type { MissionReview } from '../../shared/mission-engine-contract';

const ENABLED = process.env.NEXUS_DIRECT_BOOTSTRAP_E2E === '1';
const CONTROLLED = process.env.NEXUS_DIRECT_BOOTSTRAP_CONTROLLED_CLI === '1';
if (ENABLED) process.argv.push('nexus-smoke-test');
const REPO = process.cwd();
const state = vi.hoisted(() => ({
  userData: '', appRoot: '', adapter: null as CliPtyAdapter | null,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('../license-access', async () => (await import('../__tests__/licensed-access')).licensedAccessMock);
// The explicit controlled adapter proves its own synthetic auth. Warming
// unrelated installed CLIs would touch the operator's native credential stores.
vi.mock('./squad-runtime-inventory', async original => ({
  ...await original<typeof import('./squad-runtime-inventory')>(),
  warmSquadRuntimeSubscriptionAuth: async () => undefined,
}));
vi.mock('../adapters/adapter-registry', async original => {
  const actual = await original<typeof import('../adapters/adapter-registry')>();
  const all = () => state.adapter ? [state.adapter] : [];
  const find = (id: string) => all().find(adapter => adapter.id === id) ?? null;
  const info = (adapter: CliPtyAdapter) => {
    const capabilities = actual.adapterCapabilityMatrixForAdapter(adapter, 'builtin');
    return { id: adapter.id, kind: adapter.kind, label: adapter.label, icon: adapter.icon,
      models: { ...adapter.models, info: {} }, installed: true, resolvedBinPath: adapter.bin,
      installCommand: '', authMethod: adapter.auth.method, idleTimeoutMs: 800,
      taskHandoffCapable: actual.taskHandoffCapabilityForAdapter(adapter, 'builtin'),
      missionControlCapable: actual.missionControlCapabilityForAdapter(adapter, 'builtin'),
      orchestratorCapable: true, autonomousWorkspaceWriteCapable: capabilities.governedWriter,
      orchestrationEvidence: actual.orchestrationEvidenceForAdapter(adapter, 'builtin'), capabilities };
  };
  return { ...actual, initAdapterRegistry: () => undefined, closeAdapterRegistry: async () => undefined,
    rescanAdapterBinaries: async () => all().map(info), getAdapter: find, isBuiltinAdapter: (id: string) => id === 'claude',
    isAdapterInstalled: (id: string) => find(id) !== null, getAdapterResolvedBin: (id: string) => find(id)?.bin ?? null,
    resolveAdapterBinary: (id: string) => find(id)?.bin ?? null, listAdapters: all, listAdapterInfos: () => all().map(info) };
});

vi.mock('electron', () => {
  const noop = (): void => undefined;
  const emitter = { on: noop, once: noop, off: noop, removeListener: noop, removeAllListeners: noop, emit: () => false };
  const api = {
    app: {
      ...emitter,
      getPath: (name: string) => (name === 'home' ? os.homedir() : name === 'temp' ? os.tmpdir() : state.userData),
      getAppPath: () => state.appRoot,
      getVersion: () => '0.0.0-mission-e2e',
      getName: () => 'NexusIDE',
      getLocale: () => 'pt-BR',
      isPackaged: false,
      isReady: () => true,
      whenReady: () => Promise.resolve(),
      commandLine: { appendSwitch: noop, hasSwitch: () => false, getSwitchValue: () => '' },
      setAppUserModelId: noop,
      requestSingleInstanceLock: () => true,
      quit: noop,
      exit: noop,
    },
    ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => { state.handlers.set(channel, handler); }, handleOnce: noop,
      on: (channel: string, handler: (...args: unknown[]) => unknown) => { state.listeners.set(channel, handler); },
      once: noop, removeHandler: (channel: string) => state.handlers.delete(channel), removeListener: noop, removeAllListeners: noop },
    BrowserWindow: Object.assign(function BrowserWindow(): void { throw new Error('mission E2E: sem janela'); }, {
      getAllWindows: () => [], getFocusedWindow: () => null, fromWebContents: () => null, fromId: () => null,
    }),
    webContents: { getAllWebContents: () => [], fromId: () => null, getFocusedWebContents: () => null },
    dialog: { showMessageBox: async () => ({ response: 0, checkboxChecked: false }), showMessageBoxSync: () => 0, showErrorBox: noop, showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: { openExternal: async () => undefined, openPath: async () => '', showItemInFolder: noop },
    Notification: Object.assign(function Notification(): unknown { return { show: noop, on: noop, close: noop }; }, { isSupported: () => false }),
    nativeTheme: { shouldUseDarkColors: false, on: noop, themeSource: 'system' },
    powerSaveBlocker: { start: () => 0, stop: noop, isStarted: () => false },
    powerMonitor: { ...emitter, getSystemIdleTime: () => 0, getSystemIdleState: () => 'active' },
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1440, height: 900 }, scaleFactor: 2 }), getAllDisplays: () => [] },
    safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' },
    systemPreferences: { getMediaAccessStatus: () => 'denied', askForMediaAccess: async () => false, isTrustedAccessibilityClient: () => false },
    utilityProcess: { fork: () => { throw new Error('mission E2E: o host de PTY real roda num fork Node, não num utilityProcess'); } },
    clipboard: { readText: () => '', writeText: noop },
    session: { defaultSession: {} },
    protocol: { registerSchemesAsPrivileged: noop, handle: noop },
    Menu: { buildFromTemplate: () => ({ popup: noop }), setApplicationMenu: noop, getApplicationMenu: () => null },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }), createEmpty: () => ({ isEmpty: () => true }) },
  };
  return { ...api, default: api };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function until(check: () => boolean, label: string, bound = 30_000): Promise<void> {
  const deadline = Date.now() + bound;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`fixture precondition timed out: ${label}`);
    await new Promise<void>(resolve => setTimeout(resolve, 20));
  }
}

describe.runIf(ENABLED)('F-1109 — ordinary native CLI bootstrap/direct causal transport', () => {
  let root = '', repo = '', host: ChildProcess | null = null;
  let controlledDir = '';
  let closeMain: () => Promise<void> = async () => undefined;
  let closeStores: () => Promise<void> = async () => undefined;
  let closeManager: () => void = () => undefined;
  let closeRuntime: () => void = () => undefined;
  let closeAnalysis: () => Promise<void> = async () => undefined;
  let closeAgentHooks: () => Promise<void> = async () => undefined;
  let closeUsage: () => Promise<void> = async () => undefined;
  let profileManager: import('../runtime/project-runtime-manager').ProjectRuntimeManager | null = null;
  let releaseConsent: () => void = () => undefined;
  let scope: ProjectExecutionScope;
  let gateway: http.Server | null = null;
  let gatewayUrl = '';
  const nonce = randomUUID();
  const owner = { id: 1109, isDestroyed: () => false, isCrashed: () => false, getURL: () => 'nexus-app://bundle/index.html', getOSProcessId: () => process.pid,
    mainFrame: { url: 'nexus-app://bundle/index.html' }, send: (_channel: string, ..._args: unknown[]) => undefined, on: () => undefined, once: () => undefined, removeListener: () => undefined };
  let profileRuntimeId = '';
  let profileFlow = false;
  let profileOriginalAdapter: CliPtyAdapter | null = null;
  let priorMissionIds = new Set<string>();
  const nativeRequests: Array<{ userTexts: string[]; toolResults: unknown[] }> = [];
  const submitted = deferred<void>(), hookHeld = deferred<void>();
  let releaseHook: () => void = () => undefined;
  let holdNextHook: (() => void) | null = null;
  let intercept: ReturnType<typeof vi.spyOn> | null = null;
  const lifetime = new AbortController();
  const sockets = new Set<import('node:net').Socket>();
  const inputs: Array<{ sessionId: string; data: string }> = [];
  let untapInput: () => void = () => undefined;
  let chiefId = '', nativeHookHeld = false, hostDiagnostics = '';
  // Stable originals must never be captured from a timed-out preceding spy.
  let originalPeriodic: typeof import('../observability/periodic-task').runPeriodicTask;
  let originalIdle: typeof import('./pane-registry').waitForIdle;
  let originalEndKickoff: typeof import('./mission-kickoff-direct-queue').endKickoffBriefDelivery;
  const caseCleanups: Array<() => void | Promise<void>> = [];
  const casePostCleanups: Array<() => void | Promise<void>> = [];
  const spawnOutcomes: Array<{ ok: boolean; error?: string; hasSession: boolean }> = [];
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  const controlledStopReturned = (token: string, sequence: number): boolean => {
    const hash = createHash('sha256').update(token).digest('hex');
    try {
      return fs.readFileSync(path.join(controlledDir, 'hook.ndjson'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
        .some(row => row.gateSha256 === hash && row.event === 'stop' && row.turn === sequence && row.phase === 'returned' && row.status === 200);
    } catch { return false; }
  };


  beforeAll(async () => {
    originalPeriodic = (await import('../observability/periodic-task')).runPeriodicTask;
    originalIdle = (await import('./pane-registry')).waitForIdle;
    originalEndKickoff = (await import('./mission-kickoff-direct-queue')).endKickoffBriefDelivery;
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-direct-native-')));
    state.userData = path.join(root, 'user-data');
    const hostAppRoot = path.join(root, 'app');
    state.appRoot = REPO;
    repo = path.join(root, 'project');
    const home = path.join(state.userData, 'home');
    for (const directory of [state.userData, home, hostAppRoot, repo]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('NEXUS_HEAVY_') || key.startsWith('NEXUS_SHIM_') || key.startsWith('ANTHROPIC_') ||
          key.startsWith('CLAUDE_') || key === 'NEXUS_PANE_ID' || key === 'NEXUS_PANE_KEY' ||
          key === 'NEXUS_MCP_URL' || key === 'NEXUS_MCP_TOKEN' || key === 'NEXUS_GATE_TOKEN' || key === 'NEXUS_GATE_URL') delete process.env[key];
    }
    for (const key of ['NODE_OPTIONS', 'BASH_ENV', 'ZDOTDIR']) delete process.env[key];
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = path.join(home, '.config');
    process.env.XDG_CACHE_HOME = path.join(home, '.cache');
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Nexus Transport Fixture');
    git('config', 'user.email', 'transport@nexus.invalid');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'README.md'), '# controlled transport fixture\n');
    git('add', 'README.md'); git('commit', '-qm', 'fixture base');

    // The ordinary CLI receives the fixture's declared synthetic key and the
    // normal Main-owned consent scope, never an operator account or SDK stub.
    gateway = http.createServer((req, res) => {
      if (req.method !== 'POST' || !req.url?.startsWith('/v1/messages') ||
          req.headers['x-api-key'] !== `rt-${nonce}` && req.headers.authorization !== `Bearer rt-${nonce}`) {
        res.writeHead(401); res.end(); return;
      }
      let raw = '';
      req.on('data', (data: Buffer) => { raw += data.toString(); if (raw.length > 4 * 1024 * 1024) req.destroy(); });
      req.on('end', () => {
        const body = JSON.parse(raw) as { model: string; messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }>; tools?: Array<{ name: string }> };
        if (req.url?.includes('count_tokens')) { res.end(JSON.stringify({ input_tokens: 1 })); return; }
        const userTexts = body.messages.filter(message => message.role === 'user').flatMap(message =>
          typeof message.content === 'string' ? [message.content] : message.content.flatMap(block => typeof block.text === 'string' ? [block.text] : []));
        const blocks = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []);
        nativeRequests.push({ userTexts, toolResults: blocks.filter(block => block.type === 'tool_result') });
        const calls = blocks.filter(block => block.type === 'tool_use' && String(block.id).startsWith('toolu_direct_fixture_'));
        const directed = userTexts.some(text => text.includes(`RT_GATE SPAWN ${nonce}`));
        let content: { type: string; text?: string; id?: string; name?: string; input?: unknown } = { type: 'text', text: 'Controlled native kickoff consumed.' };
        if (directed && calls.length < 2) {
          const tools = (body.tools ?? []).filter(tool => tool.name === 'nexus_pane_spawn' || tool.name.endsWith('__nexus_pane_spawn'));
          if (tools.length !== 1) { res.writeHead(422); res.end(); return; }
          content = { type: 'tool_use', id: `toolu_direct_fixture_${calls.length}`, name: tools[0]!.name,
            input: { adapterId: 'claude', agentName: calls.length ? 'Runtime reviewer' : 'Runtime writer', role: 'worker',
              task: calls.length ? 'Review the controlled transport receipt' : 'Produce the controlled transport receipt',
              prompt: `RT_GATE IDLE ${nonce}. Wait for the private scoped follow-up.` } };
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const event = (name: string, value: unknown) => res.write(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`);
        event('message_start', { type: 'message_start', message: { id: `msg_fixture_${randomUUID()}`, type: 'message', role: 'assistant',
          model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });
        event('content_block_start', { type: 'content_block_start', index: 0, content_block: content.type === 'tool_use'
          ? { type: 'tool_use', id: content.id, name: content.name, input: {} } : { type: 'text', text: '' } });
        event('content_block_delta', { type: 'content_block_delta', index: 0, delta: content.type === 'tool_use'
          ? { type: 'input_json_delta', partial_json: JSON.stringify(content.input) } : { type: 'text_delta', text: content.text } });
        event('content_block_stop', { type: 'content_block_stop', index: 0 });
        event('message_delta', { type: 'message_delta', delta: { stop_reason: content.type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
        event('message_stop', { type: 'message_stop' }); res.end();
      });
    });
    gateway.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    await new Promise<void>(resolve => gateway!.listen(0, '127.0.0.1', resolve));
    gatewayUrl = `http://127.0.0.1:${(gateway.address() as import('node:net').AddressInfo).port}`;
    Object.assign(process.env, { NEXUS_PACKAGED_SMOKE: '1', NEXUS_USER_DATA_DIR: state.userData,
      NEXUS_SMOKE_RUNTIME_GATES: '1', NEXUS_SMOKE_RUNTIME_GATEWAY: gatewayUrl, NEXUS_SMOKE_RUNTIME_GATEWAY_NONCE: nonce,
      NEXUS_SMOKE_RUNTIME_PHASE: 'exercise', ANTHROPIC_API_KEY: `rt-${nonce}`, ANTHROPIC_AUTH_TOKEN: `rt-${nonce}`,
      ANTHROPIC_BASE_URL: gatewayUrl, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CLAUDE_SECURESTORAGE_CONFIG_DIR: path.join(home, '.claude-secure') });
    const { cliPtyAdapterSchema } = await import('../../shared/adapter-types');
    const actual = JSON.parse(fs.readFileSync(path.join(REPO, 'src/adapters/builtin/claude.json'), 'utf8')) as Record<string, unknown>;
    const selectedBinary = CONTROLLED ? path.join(REPO, 'scripts/mission-e2e/direct-bootstrap-agent') : process.env.NEXUS_DIRECT_FIXTURE_CLAUDE;
    if (!selectedBinary) throw new Error('installed CLI mode requires an explicit NEXUS_DIRECT_FIXTURE_CLAUDE path');
    const binary = fs.realpathSync(selectedBinary);
    controlledDir = path.join(root, 'controlled-cli'); fs.mkdirSync(controlledDir, { mode: 0o700 });
    state.adapter = cliPtyAdapterSchema.parse({ ...actual, bin: binary, ...(CONTROLLED ? {
      spawn: { ...(actual.spawn as object), initialPrompt: 'positional' },
      env: { ...(actual.env as object), static: { NEXUS_CONTROLLED_CLI_DIR: controlledDir } },
    } : {}) });
    if (process.platform === 'darwin') execFileSync(process.execPath, [path.join(REPO, 'scripts/build-darwin-pty-supervisor.mjs'), '--output',
      path.join(hostAppRoot, 'resources/native/darwin/nexus-pty-supervisor')], { stdio: 'ignore' });
    const { createPtyHostBridge } = await import('../pty/pty-host-core');
    host = fork(path.join(REPO, 'scripts/mission-e2e/pty-host-child.cjs'), [], {
      cwd: hostAppRoot, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, LANG: 'en_US.UTF-8', TMPDIR: os.tmpdir() },
      serialization: 'advanced', stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      execArgv: ['--import', pathToFileURL(path.join(REPO, 'node_modules/tsx/dist/loader.mjs')).href],
    });
    host.stderr?.on('data', (data: Buffer) => { hostDiagnostics = (hostDiagnostics + data.toString()).slice(-8192); });
    const bridge = createPtyHostBridge({ ensure: () => undefined, post: (message: HostControlMsg) => { host?.send(message); } });
    host.on('message', message => bridge.dispatchEvent(message as HostEventMsg)); host.on('exit', () => bridge.handleHostDown());
    const { ProjectRuntimeManager } = await import('../runtime/project-runtime-manager');
    const { configureAuditLogRuntime } = await import('../jarvis/audit-log');
    const { configurePtyProjectRuntimeManager, registerPtyIpc } = await import('../pty/pty-ipc');
    const { configureRendererMissionAuthority, initOrchestration, closeOrchestration, registerOrchIpc } = await import('./orch-ipc');
    const { configureWorktreeRuntimeRegistry, disposeWorktreeRuntimeRegistry } = await import('../runtime/worktree-runtime-registry');
    const { configureContextWorkflowRegistry } = await import('../context/context-workflow-registry');
    const { configureMissionEventEmit } = await import('./mission-event-emit');
    const { disposeProjectDomainStoreRegistry } = await import('./project-domain-store-registry');
    const pty = await import('../pty/pty-manager');
    const manager = new ProjectRuntimeManager({ baseDir: path.join(state.userData, 'project-runtime'), appVersion: '0.0.0-direct-fixture' });
    profileManager = manager;
    closeManager = () => manager.closeAll(); closeRuntime = disposeWorktreeRuntimeRegistry; closeStores = disposeProjectDomainStoreRegistry;
    configureAuditLogRuntime(manager); configurePtyProjectRuntimeManager(manager); configureRendererMissionAuthority(manager);
    const runtime = configureWorktreeRuntimeRegistry(manager);
    configureContextWorkflowRegistry(manager, { appVersion: '0.0.0-direct-fixture', resolveIntegratedMission: (ownedScope, missionId, baseSha) => runtime.resolveIntegratedMission(ownedScope, missionId, baseSha) });
    pty.setPtyHost(bridge.host); configureMissionEventEmit(manager);
    const { startPtyAnalysis, setPtyAnalysisWorkerFactoryForTests, shutdownPtyAnalysis } = await import('../pty/pty-analysis-runtime');
    const workerEntry = path.join(root, 'analysis-worker.cjs');
    // Same production analysis entry and manifests, loaded through tsx just
    // like the existing Node PTY-host bridge; no bundled app is claimed.
    fs.writeFileSync(workerEntry, `require(${JSON.stringify(path.join(REPO, 'node_modules/tsx/dist/cjs/index.cjs'))});\nrequire(${JSON.stringify(path.join(REPO, 'src/main/pty/pty-analysis-worker-entry.ts'))});\n`);
    setPtyAnalysisWorkerFactoryForTests(analysisProgress => new Worker(workerEntry, { workerData: {
      manifestDir: path.join(REPO, 'resources/agent-detection'), ghosttyWasmPath: path.join(REPO, 'resources/ghostty/ghostty-vt.wasm'), analysisProgress,
    }, execArgv: [] }));
    startPtyAnalysis(); closeAnalysis = shutdownPtyAnalysis;
    const { nativeHeavyJobEnvironment } = await import('./native-heavy-preload');
    await nativeHeavyJobEnvironment();
    const registry = await import('./pane-registry');
    const originalSpawn = registry.requestPaneSpawn;
    vi.spyOn(registry, 'requestPaneSpawn').mockImplementation(async options => {
      try {
        const result = await originalSpawn(options);
        spawnOutcomes.push({ ok: result.ok, error: result.error?.slice(0, 256), hasSession: Boolean(result.sessionId) });
        return result;
      } catch (error) {
        spawnOutcomes.push({ ok: false, error: error instanceof Error ? error.message.slice(0, 256) : 'non-error throw', hasSession: false });
        throw error;
      }
    });
    const stat = fs.statSync(repo);
    scope = { version: 1, installationId: 'direct-fixture-install', projectId: `project-${nonce}`, checkoutId: `checkout-${nonce}`,
      rootRealPath: repo, identitySource: 'manifest', workspaceRootDevice: String(stat.dev), workspaceRootInode: String(stat.ino) };
    const { bindResolvedRendererWorkspaceScope } = await import('../persistence/renderer-workspace-scope');
    bindResolvedRendererWorkspaceScope(owner, scope);
    const { runtimeGateConfiguration, armPrivateRuntimeClaudeConsent } = await import('../runtime-gate-mode');
    expect(runtimeGateConfiguration({ smokeTest: true, packaged: true, userData: state.userData, env: process.env })).not.toBeNull();
    releaseConsent = armPrivateRuntimeClaudeConsent({ userData: state.userData, gateway: gatewayUrl, gatewayNonce: nonce,
      scope, signal: lifetime.signal, isCurrent: () => !lifetime.signal.aborted });
    const originalCreate = http.createServer;
    intercept = vi.spyOn(http, 'createServer').mockImplementation(((handler: http.RequestListener) => originalCreate((req, res) => {
      if (!profileFlow && req.url === '/hook/status' && req.headers['x-nexus-hook-event'] === 'user-submit' && (!chiefId || holdNextHook)) {
        const held = holdNextHook; holdNextHook = null;
        req.pause();
        nativeHookHeld = true;
        let released = false;
        releaseHook = () => { if (released) return; released = true; handler(req, res); req.resume(); };
        hookHeld.resolve();
        held?.();
      } else handler(req, res);
    })) as typeof http.createServer);
    untapInput = pty.tapSessionInput((sessionId, data) => {
      inputs.push({ sessionId, data });
      if (data === '\r' && inputs.some(input => input.sessionId === sessionId && input.data.includes(`RT_GATE SPAWN ${nonce}`))) submitted.resolve();
    });
    await initOrchestration(); closeMain = closeOrchestration; registerOrchIpc(); registerPtyIpc(); pty.setPtyHost(bridge.host);
  }, 120_000);
  beforeEach(async () => {
    const { getProjectDomainStores } = await import('./project-domain-store-registry');
    priorMissionIds = new Set(getProjectDomainStores(scope).missions.list().map(mission => mission.id));
  });
  afterEach(async () => {
    for (const cleanup of caseCleanups.splice(0)) await cleanup();
    releaseHook(); holdNextHook = null;
    const { ORCH_CHANNELS } = await import('../../shared/orch-channels');
    const { getProjectDomainStores } = await import('./project-domain-store-registry');
    const pty = await import('../pty/pty-manager');
    const stores = getProjectDomainStores(scope);
    for (const missionId of stores.missions.list().map(mission => mission.id).filter(id => !priorMissionIds.has(id))) {
      const row = stores.missions.get(missionId);
      if (!row) continue;
      const closed = await state.handlers.get(ORCH_CHANNELS.missionCloseRuntime)!({ sender: owner, senderFrame: owner.mainFrame }, { missionId }) as { ok: boolean; error?: string };
      expect(closed, JSON.stringify(closed)).toMatchObject({ ok: true });
      expect(pty.listAgentSessions().filter(agent => agent.missionId === missionId)).toEqual([]);
      expect(stores.missions.get(missionId)?.status).not.toBe('running');
      console.info('Native fixture case closed with real scoped lifecycle and physical exit proof', { missionId });
    }
    for (const cleanup of casePostCleanups.splice(0)) await cleanup();
    if (profileFlow) {
      await closeUsage(); await closeAgentHooks(); closeUsage = async () => undefined; closeAgentHooks = async () => undefined;
      const pty = await import('../pty/pty-manager'); pty.configureAgentHookEndpointPath(null); await pty.stopSessionMortalityReconciler();
      state.adapter = profileOriginalAdapter; profileOriginalAdapter = null;
    }
    profileFlow = false;
  });

  afterAll(async () => {
    releaseHook(); lifetime.abort(); releaseConsent(); untapInput(); intercept?.mockRestore();
    const pty = await import('../pty/pty-manager');
    for (const session of pty.listAgentSessions()) {
      const exited = await pty.orchTerminateSession(session.sessionId, { origin: 'direct-native-fixture:teardown' });
      if (!exited) throw new Error('owned fixture physical exit unproven; private resources retained');
    }
    await pty.stopSessionMortalityReconciler();
    await closeMain(); await closeAnalysis(); await closeUsage(); await closeAgentHooks(); pty.configureAgentHookEndpointPath(null); await closeStores(); closeRuntime(); closeManager();
    if (host) { if (host.connected) host.disconnect(); await new Promise<void>(resolve => { if (host!.exitCode !== null) resolve(); else host!.once('exit', () => resolve()); }); }
    for (const socket of sockets) socket.destroy();
    if (gateway) await new Promise<void>(resolve => gateway!.close(() => resolve()));
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }, 120_000);

  it.runIf(CONTROLLED)('F-1118: normal catalog/runtime saves, USER creation, named grants and operator input work without a wizard kickoff receipt', async () => {
    profileFlow = true;
    const profileReceipts = path.join(root, 'profile-cli'); fs.mkdirSync(profileReceipts, { mode: 0o700 });
    profileOriginalAdapter = state.adapter;
    state.adapter = { ...state.adapter!, env: { ...state.adapter!.env, static: { ...state.adapter!.env?.static,
      NEXUS_CONTROLLED_CLI_DIR: profileReceipts, NEXUS_CONTROLLED_PROFILE_FIXTURE: '1' } } };
    const { initUsageTelemetry, shutdownUsageTelemetry } = await import('../usage/usage-service');
    await initUsageTelemetry(profileManager!); closeUsage = shutdownUsageTelemetry;
    const { startAgentHookHttpServer } = await import('../agent-hooks/hook-http-server');
    const hooks = await startAgentHookHttpServer({ userDataPath: state.userData }); closeAgentHooks = hooks.close;
    const { ORCH_CHANNELS } = await import('../../shared/orch-channels');
    const { PTY_CHANNELS } = await import('../../shared/channels');
    const { runtimeStandardProfile } = await import('../../shared/runtime-gates');
    const { snapshotSquadAuthority } = await import('./squad-authority-snapshot');
    const { getProjectDomainStores } = await import('./project-domain-store-registry');
    const { missionEngineForScope } = await import('./mission-engine-registry');
    const { projectMissionEngineSnapshotView } = await import('./mission-engine-production');
    const { getPaneRuntimeAuthorityBySession } = await import('./pane-registry');
    const { getContextBySession } = await import('./gate');
    const { getProviderPaneSession } = await import('../persistence/provider-session-store');
    const { readAuditLog } = await import('../jarvis/audit-log');
    const pty = await import('../pty/pty-manager');
    pty.configureAgentHookEndpointPath(hooks.endpointFilePath);
    const invoke = (channel: string, input: unknown) => state.handlers.get(channel)!({ sender: owner, senderFrame: owner.mainFrame }, input);
    const catalog = await invoke(ORCH_CHANNELS.squadSave, runtimeStandardProfile(nonce)) as import('../../shared/orch-types').SquadSaveResult;
    expect(catalog.ok).toBe(true);
    const saved = await invoke(ORCH_CHANNELS.squadSave, { squad: catalog.squad, purpose: 'mission-runtime', guided: false, sourceSquadId: catalog.squad!.id }) as import('../../shared/orch-types').SquadSaveResult;
    expect(saved.ok).toBe(true); expect(saved.squad!.runtimeSourceSquadRevisionHash).toBe(snapshotSquadAuthority(catalog.squad!).hash);
    expect(saved.squad!.agents).toEqual(catalog.squad!.agents); profileRuntimeId = saved.squad!.id;
    const creator = await invoke(PTY_CHANNELS.spawn, { kind: 'cli-agent', adapterId: 'claude', paneId: `profile-user-${nonce}`, cwd: repo,
      cols: 80, rows: 24, resume: false, resumeLatestOnly: false, restorePersistedAuthority: false }) as { ok: boolean; sessionId: string; error?: string };
    expect(creator.ok, creator.error).toBe(true); expect(getContextBySession(creator.sessionId)?.role).toBe('user');
    // Normal confirmed USER submission; later mission input uses the dedicated operator lane.
    const creatorGateHash = createHash('sha256').update(getContextBySession(creator.sessionId)!.token).digest('hex');
    await until(() => fs.existsSync(path.join(profileReceipts, 'mcp.ndjson')) && fs.readFileSync(path.join(profileReceipts, 'mcp.ndjson'), 'utf8').trim().split('\n')
      .map(line => JSON.parse(line) as { gateSha256: string; tool: string }).some(r => r.gateSha256 === creatorGateHash && r.tool === 'nexus_handoff_list'),
    'owned loose actual MCP readiness');
    // Match terminal-host's actual session assignment → onPaneSessionChange
    // → orch-bridge panesSync; this fixture has no mounted renderer/rAF bridge.
    expect(pty.getOwnedAgentSessionInfo(owner as never, creator.sessionId)).toMatchObject({
      paneId: `profile-user-${nonce}`, sessionId: creator.sessionId, role: 'user', scope,
    });
    state.listeners.get(ORCH_CHANNELS.panesSync)!({ sender: owner, senderFrame: owner.mainFrame }, {
      generationId: `profile-normal-${nonce}`, entries: [{ paneId: `profile-user-${nonce}`, sessionId: creator.sessionId,
        paneNumber: 1, title: 'Claude', kind: 'cli-agent', adapterId: 'claude', model: '', state: 'idle', tabKey: '__loose__' }],
    });
    // Exercise the actual sealed renderer request → PTY spawn → sync → ACK
    // transport. owner.send is otherwise a noop in this windowless fixture.
    const { buildPtySpawnRequest } = await import('../../renderer/terminal/spawn-request');
    const rendererEntries = new Map<string, import('../../shared/orch-types').PaneRegistryEntry>([[`profile-user-${nonce}`, {
      paneId: `profile-user-${nonce}`, sessionId: creator.sessionId, title: 'Claude', kind: 'cli-agent', adapterId: 'claude', model: '',
    }]]);
    const spawnFlights = new Map<string, Promise<void>>();
    const safeSpawnRefusal = (message?: string): string | undefined => {
      if (!message) return undefined;
      const codes = ['session_authority_revoked', 'resume_unavailable', 'resume_context_unavailable', 'native_heavy_channel_context_invalid',
        'native_deferred_spawn_context_changed', 'native_deferred_spawn_reservation_changed'];
      const known = ['renderer payload does not match main-sealed pending spawn request',
        'governed native confinement resume requires an exact main-owned provider session',
        'invalid spawn request', 'mission-bound worker requires a main-owned coordination scope'];
      return codes.find(code => message.includes(code)) ?? known.find(reason => message.startsWith(reason)) ?? 'unclassified_spawn_refusal';
    };
    const syncRenderer = () => state.listeners.get(ORCH_CHANNELS.panesSync)!({ sender: owner, senderFrame: owner.mainFrame }, {
      generationId: `profile-normal-${nonce}`, entries: [...rendererEntries.values()],
    });
    const acknowledge = (result: import('../../shared/orch-types').OrchPaneSpawnResult) =>
      state.listeners.get(ORCH_CHANNELS.paneSpawnResult)!({ sender: owner, senderFrame: owner.mainFrame }, result);
    const send = vi.spyOn(owner, 'send').mockImplementation((channel, ...payload) => {
      if (channel !== ORCH_CHANNELS.paneSpawnRequest) return;
      const request = payload[0] as import('../../shared/orch-types').OrchPaneSpawnRequest;
      if (spawnFlights.has(request.requestId)) return;
      const flight = (async () => {
        rendererEntries.set(request.paneId, { paneId: request.paneId, sessionId: null, title: request.title ?? request.adapterId,
          kind: 'cli-agent', adapterId: request.adapterId, model: request.model ?? '' });
        if (request.allowPending) {
          syncRenderer(); acknowledge({ requestId: request.requestId, paneId: request.paneId, sessionId: null, ok: true, pending: true });
        }
        const result = await invoke(PTY_CHANNELS.spawn, buildPtySpawnRequest({
          pane: { id: request.paneId, kind: 'cli-agent', adapterId: request.adapterId, model: request.model ?? '',
            accountId: request.accountId, effort: request.effort, cwd: request.cwd, orchRequestId: request.requestId },
          // Fresh renderer pane uses ordinary startSpawn defaults. Main restores
          // its sealed resume intent; the renderer is forbidden to author it.
          cols: 120, rows: 36, resume: false, resumeLatestOnly: false,
          restorePersistedAuthority: false, missionId: request.missionId,
        })) as { ok: boolean; sessionId?: string; error?: string };
        console.info('owned profile renderer spawn outcome', { requestId: request.requestId, paneId: request.paneId,
          sealedResume: request.resume, rendererResume: false, pendingAcknowledged: request.allowPending === true, ok: result.ok,
          sessionId: result.sessionId ?? null, errorCode: safeSpawnRefusal(result.error) });
        if (!result.ok || !result.sessionId) {
          rendererEntries.delete(request.paneId); syncRenderer();
          acknowledge({ requestId: request.requestId, paneId: request.paneId, ok: false, error: result.error }); return;
        }
        expect(pty.getOwnedAgentSessionInfo(owner as never, result.sessionId)).toMatchObject({
          paneId: request.paneId, role: request.role, missionId: request.missionId,
        });
        rendererEntries.set(request.paneId, { ...rendererEntries.get(request.paneId)!, sessionId: result.sessionId });
        syncRenderer();
        acknowledge({ requestId: request.requestId, paneId: request.paneId, sessionId: result.sessionId, ok: true });
        const published = getPaneRuntimeAuthorityBySession(result.sessionId);
        console.info('owned profile renderer final ACK', { requestId: request.requestId, paneId: request.paneId,
          sessionId: result.sessionId, publishedRole: published?.role ?? null,
          missionMatches: published?.missionId === request.missionId });
      })();
      spawnFlights.set(request.requestId, flight);
      void flight.catch(error => acknowledge({ requestId: request.requestId, paneId: request.paneId, ok: false,
        error: error instanceof Error ? error.message : 'fixture renderer transport failed' }));
    });
    caseCleanups.push(async () => { await Promise.allSettled(spawnFlights.values()); });
    casePostCleanups.push(async () => {
      send.mockRestore();
      const registry = await import('./pane-registry');
      registry.unregisterOrchRenderer(owner as never);
    });
    expect(await invoke(PTY_CHANNELS.writeConfirmed, { sessionId: creator.sessionId, data: `\x1b[200~RT_GATE PROFILE_CREATE ${nonce} ${profileRuntimeId}\x1b[201~` })).toBe(true);
    expect(await invoke(PTY_CHANNELS.writeConfirmed, { sessionId: creator.sessionId, data: '\r' })).toBe(true);
    const stores = getProjectDomainStores(scope);
    try { await until(() => stores.missions.list().some(m => m.squadId === profileRuntimeId), 'actual USER mission create result'); }
    catch (error) {
      const { readSessionOutput } = await import('./pane-registry');
      const { redactTerminalText } = await import('../../shared/secret-redaction');
      console.error('owned profile creator diagnostic', redactTerminalText(readSessionOutput(creator.sessionId, 60)).slice(-4096));
      throw error;
    }
    const mission = stores.missions.list().find(m => m.squadId === profileRuntimeId)!;
    expect(mission).toMatchObject({ status: 'running', intentState: 'dispatched', orchestratorSessionId: creator.sessionId });
    expect(stores.missions.hasCurrentKickoffAcceptance(mission.id)).toBe(false);
    expect(getContextBySession(creator.sessionId)).toMatchObject({ role: 'orchestrator', missionId: mission.id });
    expect(pty.getAgentSessionInfo(creator.sessionId)).toMatchObject({ role: 'orchestrator', missionId: mission.id, scope });
    expect(getPaneRuntimeAuthorityBySession(creator.sessionId)).toMatchObject({ paneId: `profile-user-${nonce}`,
      sessionId: creator.sessionId, missionId: mission.id, role: 'orchestrator', owner, scope, executionScope: scope });
    const leaderView = projectMissionEngineSnapshotView(scope, stores, mission.id);
    const leaderId = saved.squad!.agents.find(agent => agent.category === 'orchestrator')!.id;
    expect(leaderView.orchestratorLive).toBe(true);
    expect(leaderView.roster.filter(agent => agent.id === leaderId)).toHaveLength(1);
    expect(leaderView.panes.filter(pane => pane.agentId === leaderId)).toMatchObject([{ paneId: `profile-user-${nonce}`, terminalLive: true }]);
    await until(() => readAuditLog({ scope }, 1000).some(a => a.tool === 'nexus_mission_create' && a.result === 'ok' && a.session === creator.sessionId &&
      a.source === 'http-mcp' && a.args.squadId === profileRuntimeId && a.invocation_id), 'actual authenticated creation audit');
    await until(() => pty.listAgentSessions().filter(a => a.missionId === mission.id && a.role === 'worker').length === 2, 'actual named profile workers');
    const workers = pty.listAgentSessions().filter(a => a.missionId === mission.id && a.role === 'worker');
    const physicalWorkersObservedAt = Date.now();
    const { sameExactPaneScope } = await import('./pane-authz');
    const originalAuthorityFacts = (stage: string, worker: typeof workers[number]) => {
      const spec = stores.missionPanes.findByPaneId(worker.paneId!);
      const physical = pty.getAgentSessionInfo(worker.sessionId);
      const authority = getPaneRuntimeAuthorityBySession(worker.sessionId);
      console.info('owned profile original authority', { stage, paneId: worker.paneId, sessionId: worker.sessionId,
        compositionExists: Boolean(spec), compositionMissionMatches: spec?.missionId === mission.id,
        compositionScopeMatches: Boolean(spec?.scope && sameExactPaneScope(spec.scope, scope)), compositionRole: spec?.role ?? null,
        capabilityMatches: JSON.stringify(spec?.allowedTools) === JSON.stringify(worker.allowedTools),
        physicalPresent: Boolean(physical), physicalRole: physical?.role ?? null, physicalMissionMatches: physical?.missionId === mission.id,
        registryRole: authority?.role ?? null, registryMissionMatches: authority?.missionId === mission.id,
        nativeConversationPresent: Boolean(getProviderPaneSession(scope, worker.paneId!, worker.adapterId, worker.accountId)) });
    };
    for (const worker of workers) originalAuthorityFacts('physical-observed', worker);
    // A pending ACK proves a live pane, not that its asynchronous durable
    // composition/conversation has reached the resume boundary yet (F-793).
    await until(() => workers.every(worker => {
      const spec = stores.missionPanes.findByPaneId(worker.paneId!);
      return spec?.missionId === mission.id && spec.role === worker.role && Boolean(spec.scope && sameExactPaneScope(spec.scope, scope)) &&
        JSON.stringify(spec.allowedTools) === JSON.stringify(worker.allowedTools) && JSON.stringify(spec.allowedSkills) === JSON.stringify(worker.allowedSkills) &&
        Boolean(getProviderPaneSession(scope, worker.paneId!, worker.adapterId, worker.accountId));
    }), 'actual durable original composition and native conversation');
    console.info('owned profile durable readiness', { latencyAfterPhysicalMs: Date.now() - physicalWorkersObservedAt });
    for (const worker of workers) {
      expect(worker.allowedTools).toEqual(saved.squad!.agents.find(a => a.agentName === worker.agentName)!.allowedTools);
      expect(getContextBySession(worker.sessionId)?.scope).toEqual(scope);
      expect(getContextBySession(worker.sessionId)?.executionScope).toEqual(worker.scope);
    }
    const footprints = await pty.probePaneFootprints(); expect(footprints).not.toBeNull();
    expect(footprints!.filter(p => workers.some(w => w.sessionId === p.sessionId)).every(p => p.rootPid !== null && p.rootPid > 0)).toBe(true);
    const writer = workers.find(a => a.agentName === 'Runtime writer')!;
    expect(workers.find(a => a.agentName === 'Runtime reviewer')!.readOnly).toBe(true);
    await vi.waitFor(async () => {
      const snapshot = await missionEngineForScope(scope).snapshot(scope, mission.id);
      expect(snapshot.id).toBe(mission.id);
      for (const worker of workers) {
        const canonical = snapshot.agents.filter(a => a.paneId === worker.paneId);
        expect(canonical).toHaveLength(1);
        expect(canonical[0]).toMatchObject({ id: saved.squad!.agents.find(a => a.agentName === worker.agentName)!.id,
          agentName: worker.agentName, cli: worker.adapterId, terminalLive: true });
      }
    }, { timeout: 45000, interval: 20 });
    expect(await invoke(ORCH_CHANNELS.paneOperatorInput, { sessionId: writer.sessionId, data: `\x1b[200~RT_GATE PROFILE_WRITE ${nonce}\x1b[201~` })).toBe(true);
    expect(await invoke(ORCH_CHANNELS.paneOperatorInput, { sessionId: writer.sessionId, data: '\r' })).toBe(true);
    await until(() => fs.existsSync(path.join(writer.scope.rootRealPath, 'runtime-profile-proof.txt')), 'actual authorized worker file write');
    expect(fs.readFileSync(path.join(writer.scope.rootRealPath, 'runtime-profile-proof.txt'), 'utf8')).toBe(`RT_PROFILE_${nonce}`);
    const original = getProviderPaneSession(writer.scope, writer.paneId!, 'claude', writer.accountId);
    expect(original).not.toBeNull(); originalAuthorityFacts('before-intentional-exit', writer);
    expect(await pty.orchTerminateSession(writer.sessionId, { origin: 'profile-fixture:recovery' })).toBe(true);
    originalAuthorityFacts('after-intentional-exit-before-resume', writer);
    expect(await invoke(ORCH_CHANNELS.paneOperatorInput, { sessionId: creator.sessionId, data: `\x1b[200~RT_GATE PROFILE_RECOVER ${nonce} ${writer.paneId}\x1b[201~` })).toBe(true);
    expect(await invoke(ORCH_CHANNELS.paneOperatorInput, { sessionId: creator.sessionId, data: '\r' })).toBe(true);
    await until(() => pty.listAgentSessions().some(a => a.missionId === mission.id && a.agentName === 'Runtime writer' && a.sessionId !== writer.sessionId), 'actual normal chief worker resume');
    const next = pty.listAgentSessions().find(a => a.missionId === mission.id && a.agentName === 'Runtime writer' && a.sessionId !== writer.sessionId)!;
    expect(next.paneId).not.toBe(writer.paneId); expect(next.allowedTools).toEqual(writer.allowedTools);
    expect(getProviderPaneSession(next.scope, next.paneId!, 'claude', next.accountId)).toMatchObject({ key: original!.key, id: original!.id });
    await invoke(ORCH_CHANNELS.missionCommand, { kind: 'stop', missionId: mission.id });
    expect(pty.listAgentSessions().filter(a => a.missionId === mission.id)).toEqual([]);
  }, 120_000);

  it('queues a cold direct instead of certifying the unrelated native argv turn, then delivers the exact envelope once', async () => {
    let completedArgvSid = '';
    if (CONTROLLED) {
      const registry = await import('./pane-registry');
      const pty = await import('../pty/pty-manager');
      const gate = await import('./gate');
      const turns = await import('./agent-status');
      const causalIdle = vi.spyOn(registry, 'waitForIdle').mockImplementation(async (...args) => {
        const result = await originalIdle(...args);
        const agent = pty.getAgentSessionInfo(args[0]);
        if (agent?.role === 'worker' && agent.agentName === 'Runtime writer') {
          await until(() => {
            const ctx = gate.getContextBySession(args[0]);
            const sequence = turns.getAgentTurnStartSequence(args[0]);
            return sequence === 1 && turns.getAgentLastTurnEnd(args[0])?.sequence === sequence &&
              Boolean(ctx && controlledStopReturned(ctx.token, sequence));
          }, 'F-1139 true original idle continuation after matching native Stop HTTP200');
          completedArgvSid = args[0];
          expect(pty.getSessionState(args[0])).toBe('idle');
        }
        return result;
      });
      caseCleanups.push(() => causalIdle.mockRestore());
    }

    const { ORCH_CHANNELS } = await import('../../shared/orch-channels');
    const { getProjectDomainStores } = await import('./project-domain-store-registry');
    const { getMissionEventRuntimeManager } = await import('./mission-event-emit');
    const { MissionEventJournal } = await import('./mission-event-journal');
    const pty = await import('../pty/pty-manager');
    const invoke = (channel: string, input: unknown) => state.handlers.get(channel)!({ sender: owner, senderFrame: owner.mainFrame }, input);
    const tools = ['nexus_pane_spawn', 'nexus_handoff_submit', 'nexus_handoff_list', 'nexus_handoff_ack', 'nexus_clarify', 'nexus_mission_set_status', 'nexus_terminal_run', 'nexus_file_read', 'nexus_file_write', 'nexus_browser_open', 'nexus_browser_screenshot'];
    const review = await invoke(ORCH_CHANNELS.missionPrepare, { title: `Runtime standard ${nonce}`,
      objective: 'Write runtime-report.txt and review the private runtime UI and report using at most two workers.', contextPaths: [],
      roster: [
        { id: 'rt-standard-chief', agentName: 'Runtime chief', category: 'orchestrator', cli: 'claude', allowedTools: tools, allowedSkills: [] },
        { id: 'rt-standard-writer', agentName: 'Runtime writer', category: 'executor', cli: 'claude', allowedTools: tools, allowedSkills: [] },
        { id: 'rt-standard-reviewer', agentName: 'Runtime reviewer', category: 'reviewer', cli: 'claude', allowedTools: tools, allowedSkills: [] },
      ], advanced: { lane: 'standard' } }) as MissionReview;
    expect(review.roster.map(agent => agent.cli)).toEqual(['claude', 'claude', 'claude']);
    await invoke(ORCH_CHANNELS.missionStart, { missionId: review.missionId, reviewSha256: review.reviewSha256 });
    const stores = getProjectDomainStores(scope);
    try { await until(() => nativeHookHeld, 'actual native UserPromptSubmit ingress', 20_000); }
    catch (error) {
      const { maestroKickoffBlockReason } = await import('./maestro-boot-gate');
      const live = pty.listAgentSessions().find(session => session.missionId === review.missionId && session.role === 'orchestrator');
      const row = stores.missions.get(review.missionId);
      console.error('F1109 fixture native boundary', { missionStatus: row?.status, intentState: row?.intentState,
        hasPhysicalChief: Boolean(live), physicalState: live ? pty.getSessionState(live.sessionId) : null,
        bootBlock: live ? maestroKickoffBlockReason((await import('./pane-registry')).readSessionOutput(live.sessionId, 80)) : null,
        hostResponsibilityRefused: /responsibility|F-715/.test(hostDiagnostics), hostDiagnosticBytes: hostDiagnostics.length,
        inferenceRequests: nativeRequests.length, spawnOutcomes });
      throw error;
    }
    await hookHeld.promise;
    const chief = pty.listAgentSessions().find(session => session.missionId === review.missionId && session.role === 'orchestrator');
    expect(chief).toBeDefined(); chiefId = chief!.sessionId;
    await until(() => stores.missions.hasCurrentKickoffAcceptance(review.missionId) && pty.getSessionState(chiefId) === 'idle', 'cold native argv idle receipt');
    const journal = new MissionEventJournal(getMissionEventRuntimeManager()!, scope);
    const accepted = (): Array<{ kind: string; bytes: number; hasDirection?: boolean; envelope?: { kind: string; text: string; targetAgentId: null } }> => {
      if (!CONTROLLED) return [];
      try { return fs.readFileSync(path.join(controlledDir, 'accepted.ndjson'), 'utf8').trim().split('\n').map(line => JSON.parse(line)); }
      catch { return []; }
    };
    const direct = Promise.resolve(invoke(ORCH_CHANNELS.missionCommand, { kind: 'direct', missionId: review.missionId,
      targetAgentId: null, text: `RT_GATE SPAWN ${nonce}. Open the two named Claude seats through the normal MCP.` }));
    void direct.catch(() => undefined);
    // On the regression the direct has reached Enter; on the repair it has
    // returned promptly as queued. Both release the SAME actual native hook.
    await Promise.race([submitted.promise, direct]);
    const interleavedInputs = inputs.filter(input => input.sessionId === chiefId && input.data.includes(`RT_GATE SPAWN ${nonce}`));
    releaseHook(); await direct;
    const events = journal.replay({ missionId: review.missionId, afterSequence: 0, limit: 100 });
    const direction = events.filter(event => event.payload.kind === 'operator_direction');
    if (CONTROLLED) {
      const { getAgentTurnStartSequence } = await import('./agent-status');
      const footprints = await pty.probePaneFootprints();
      fs.writeFileSync(path.join(REPO, '.superpowers/sdd/release-076213-reviewed/F1109-controlled-current-facts.json'), JSON.stringify({
        sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim(),
        mode: 'controlled-native-cli-real-main-pty-authenticated-hooks', signedPackagedProof: false,
        compiledClis: review.roster.map(agent => agent.cli), lane: stores.missions.get(review.missionId)?.intentContract?.lane,
        scope: { ...scope }, chiefSession: chiefId, footprint: footprints?.find(footprint => footprint.sessionId === chiefId),
        nativeStartSequence: getAgentTurnStartSequence(chiefId), interleavedDirectionInputs: interleavedInputs.length,
        acceptedNative: accepted(), directionEvents: direction.map(event => ({ sequence: event.sequence, deliveryState: event.payload.deliveryState ?? 'immediate', directionId: event.payload.directionId ?? null })),
      }, null, 2), { mode: 0o600 });
    }
    expect(direction).toHaveLength(1);
    expect(direction[0]!.payload.deliveryState, 'kickoff-only UserPromptSubmit must not certify the cold direct').toBe('queued');
    expect(interleavedInputs, 'no direction bytes may enter the native bootstrap composer').toHaveLength(0);
    await until(() => CONTROLLED ? accepted().some(message => message.envelope?.text.includes(`RT_GATE SPAWN ${nonce}`))
      : nativeRequests.some(request => request.userTexts.some(text => text.includes(`RT_GATE SPAWN ${nonce}`))), 'exact direct native body');
    await until(() => journal.replay({ missionId: review.missionId, afterSequence: 0, limit: 100 }).some(event => event.payload.kind === 'operator_direction_delivery'), 'correlated direction receipt');
    const outcome = journal.replay({ missionId: review.missionId, afterSequence: 0, limit: 100 }).filter(event => event.payload.kind === 'operator_direction_delivery');
    expect(outcome).toHaveLength(1); expect(outcome[0]!.payload).toMatchObject({ directionId: direction[0]!.payload.directionId, deliveryState: 'delivered', reason: 'acceptance_proved' });
    await until(() => pty.listAgentSessions().filter(session => session.missionId === review.missionId && session.role === 'worker').length === 2, 'actual named worker spawn/admission', 60_000);
    expect(pty.listAgentSessions().filter(session => session.missionId === review.missionId && session.role === 'worker').map(session => session.agentName).sort()).toEqual(['Runtime reviewer', 'Runtime writer']);
    expect(inputs.filter(input => input.sessionId === chiefId && input.data.includes(`RT_GATE SPAWN ${nonce}`))).toHaveLength(1);
    if (CONTROLLED) {
      expect(accepted().filter(message => message.envelope?.text.includes(`RT_GATE SPAWN ${nonce}`))).toHaveLength(1);
      expect(accepted().filter(message => message.kind === 'argv').every(message => message.bytes > 500 && message.hasDirection === false)).toBe(true);
      await until(() => {
        try { return fs.readFileSync(path.join(controlledDir, 'mcp.ndjson'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(call => call.tool === 'nexus_pane_spawn').length === 2; }
        catch { return false; }
      }, 'two actual returned named spawn RPCs');
      const calls = fs.readFileSync(path.join(controlledDir, 'mcp.ndjson'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(calls.filter(call => call.tool === 'nexus_pane_spawn')).toHaveLength(2);
      expect(completedArgvSid, 'F-1139 actual worker first turn completed before original idle continuation').not.toBe('');
      expect(inputs.filter(input => input.sessionId === completedArgvSid && input.data.length > 0), 'exact argv acceptance requires no Enter or repaste').toHaveLength(0);
      expect(calls.some(call => call.tool === 'nexus_handoff_list')).toBe(true);
      expect(calls.every(call => call.status === 200 && call.body.result.isError !== true)).toBe(true);
      const spawned = calls.filter(call => call.tool === 'nexus_pane_spawn').map(call => JSON.parse(call.body.result.content[0].text));
      expect(spawned.every(result => typeof result.sessionId === 'string' && typeof result.paneId === 'string')).toBe(true);
      for (const result of spawned) expect(pty.getAgentSessionInfo(result.sessionId)).toMatchObject({
        sessionId: result.sessionId, paneId: result.paneId, adapterId: 'claude', role: 'worker', missionId: review.missionId,
      });
      expect(spawned.map(result => result.sessionId).sort()).toEqual(pty.listAgentSessions()
        .filter(session => session.missionId === review.missionId && session.role === 'worker').map(session => session.sessionId).sort());
      fs.writeFileSync(path.join(REPO, '.superpowers/sdd/release-076213-reviewed/F1109-controlled-positive-facts.json'), JSON.stringify({
        mode: 'controlled-native-cli-real-main-pty-authenticated-hooks', signedPackagedProof: false,
        acceptedNative: accepted(), outcomes: outcome.map(event => event.payload),
        actualReturnedCalls: calls.map(call => ({ tool: call.tool, status: call.status, isError: call.body.result.isError ?? false })),
        namedWorkers: pty.listAgentSessions().filter(session => session.missionId === review.missionId && session.role === 'worker').map(session => ({ sessionId: session.sessionId, name: session.agentName })),
      }, null, 2), { mode: 0o600 });
    }
  }, 120_000);

  it.runIf(CONTROLLED).each(['initial', 'resume', 'resume-abort', 'resume-unknown-exit'] as const)(
    'F-1134: real native %s setup commits after its own durable reviewer spend and runs its watcher', async mode => {
    nativeHookHeld = false; chiefId = '';
    console.info('F1134 fixture phase: begin', mode);
    const { ORCH_CHANNELS } = await import('../../shared/orch-channels');
    const { getProjectDomainStores } = await import('./project-domain-store-registry');
    const { dispatchToolCall } = await import('./mcp-dispatch');
    const { buildDomainTools } = await import('./tools-domain');
    const { buildPaneTools } = await import('./tools-panes');
    const { getContextBySession, mintToken, bindTokenToSession, releaseSession } = await import('./gate');
    const { getAgentTurnStartSequence, getAgentLastTurnEnd } = await import('./agent-status');
    const kickoff = await import('./mission-kickoff-direct-queue');
    const { provedKickoffBriefDelivery } = kickoff;
    const { fastLaneOrchestratorPaneSummary } = await import('./mission-fast-lane');
    const { missionIntentAuthoritySnapshot } = await import('../../shared/mission-intent');
    const registry = await import('./pane-registry');
    const periodic = await import('../observability/periodic-task');
    const pty = await import('../pty/pty-manager');
    const stores = getProjectDomainStores(scope);
    const invoke = (channel: string, input: unknown) => state.handlers.get(channel)!({ sender: owner, senderFrame: owner.mainFrame }, input);
    const reviewerName = mode === 'initial' ? 'Runtime reviewer' : 'Resume reviewer';
    const abort = new AbortController();
    let termination: ReturnType<typeof vi.spyOn> | undefined;
    let previousSpec: import('./mission-pane-store').ScopedMissionPaneSpec | undefined;
    const tools = ['nexus_pane_spawn', 'nexus_handoff_list', 'nexus_mission_request_resume'];
    const review = await invoke(ORCH_CHANNELS.missionPrepare, { title: `Runtime spend ${mode} ${nonce}`,
      objective: 'Review the private report while the native coordinator setup remains pending.', contextPaths: [],
      roster: [
        { id: 'rt-spend-chief', agentName: 'Runtime chief', category: 'orchestrator', cli: 'claude', allowedTools: tools, allowedSkills: [] },
        { id: 'rt-spend-caller', agentName: 'Resume caller', category: 'executor', cli: 'claude', allowedTools: tools, allowedSkills: [] },
        { id: 'rt-spend-reviewer', agentName: reviewerName, category: 'reviewer', cli: 'claude', allowedTools: tools, allowedSkills: [] },
      ], advanced: { lane: 'standard' } }) as MissionReview;
    console.info('F1134 fixture phase: prepared', mode);
    const idleResolved = deferred<void>(), idleRelease = deferred<void>(), reviewerHook = deferred<void>();
    let reviewerIdle = false, reviewerSid = '', turnHold = '';
    const proofSignals = new Map<string, ReturnType<typeof deferred<boolean>>>();
    const proofOf = (sid: string) => {
      let proof = proofSignals.get(sid);
      if (!proof) { proof = deferred<boolean>(); proofSignals.set(sid, proof); }
      return proof;
    };
    const endKickoff = originalEndKickoff;
    const proofSpy = vi.spyOn(kickoff, 'endKickoffBriefDelivery').mockImplementation((expected, accepted) => {
      const ended = endKickoff(expected, accepted);
      if (ended && expected.missionId === review.missionId) proofOf(expected.orchestratorSessionId).resolve(accepted === true);
      return ended;
    });
    let targetSid = '', heldIdle: string | undefined, holdIdle = mode === 'initial';
    const waitForIdle = originalIdle;
    const idleSpy = vi.spyOn(registry, 'waitForIdle').mockImplementation(async (...args) => {
      const result = await waitForIdle(...args);
      const physical = pty.getAgentSessionInfo(args[0]);
      if (physical?.missionId === review.missionId && physical.agentName === reviewerName) {
        reviewerIdle = result === 'idle'; reviewerSid = args[0];
      }
      if (holdIdle && pty.getAgentSessionInfo(args[0])?.missionId === review.missionId &&
          pty.getAgentSessionInfo(args[0])?.role === 'orchestrator') {
        holdIdle = false; targetSid = args[0]; heldIdle = result; idleResolved.resolve(); await idleRelease.promise;
      }
      return result;
    });
    const ticks: Array<{ id: string; at: number; cadence: number | undefined; ownerSid: string; signal: AbortSignal }> = [];
    const watcherOwners = new Map<AbortSignal, string>();
    const runPeriodic = originalPeriodic;
    const periodicSpy = vi.spyOn(periodic, 'runPeriodicTask').mockImplementation((id, run, options) => {
      const watched = id.startsWith('mission-fast-lane:') && id.endsWith(`:${review.missionId}`);
      const signal = options?.signal;
      if (watched && signal && !watcherOwners.has(signal)) {
        const ownerSid = stores.missions.get(review.missionId)?.orchestratorSessionId;
        if (!ownerSid) throw new Error('fixture watcher registration missing its durable owner');
        watcherOwners.set(signal, ownerSid);
      }
      const ownerSid = signal ? watcherOwners.get(signal) : undefined;
      return runPeriodic(id, async context => {
        if (watched && signal && ownerSid) ticks.push({ id, at: Date.now(), cadence: options?.cadenceMs, ownerSid, signal });
        await run(context);
      }, options);
    });
    caseCleanups.push(() => {
      idleRelease.resolve(); releaseHook(); holdNextHook = null; abort.abort();
      for (const proof of proofSignals.values()) proof.resolve(false);
      fs.rmSync(path.join(controlledDir, 'spawn-before-stop.json'), { force: true });
      if (turnHold) fs.rmSync(turnHold, { force: true });
      idleSpy.mockRestore(); proofSpy.mockRestore(); periodicSpy.mockRestore(); termination?.mockRestore();
    });
    let resumed: ReturnType<typeof dispatchToolCall> | undefined;
    try {
      await invoke(ORCH_CHANNELS.missionStart, { missionId: review.missionId, reviewSha256: review.reviewSha256 });
      console.info('F1134 fixture phase: started', mode);
      await until(() => nativeHookHeld, 'spend original native hook');
      console.info('F1134 fixture phase: native hook held', mode);
      const original = pty.listAgentSessions().find(a => a.missionId === review.missionId && a.role === 'orchestrator')!;
      expect(original).toBeDefined(); chiefId = original.sessionId;
      if (mode !== 'initial') {
        releaseHook();
        expect(await proofOf(original.sessionId).promise, 'original native briefing actually proved').toBe(true);
        await until(() => provedKickoffBriefDelivery(scope, review.missionId)?.orchestratorSessionId === original.sessionId &&
          fastLaneOrchestratorPaneSummary(scope, review.missionId)?.sessionId === original.sessionId &&
          getAgentTurnStartSequence(original.sessionId) > 0 && pty.getSessionState(original.sessionId) === 'idle',
          'original coordinator committed its setup and completed the actual native turn');
        // Seal the old watcher's real signal/SID before changing the leader.
        await until(() => ticks.some(tick => tick.ownerSid === original.sessionId), 'original real 15-second watcher generation registered');
        const caller = await dispatchToolCall('http-mcp', { serverName: 'spend-fixture-panes', serverVersion: '0', tools: buildPaneTools() },
          'nexus_pane_spawn', { adapterId: 'claude', operatorChoice: true, agentName: 'Resume caller', role: 'worker',
            task: 'Keep the native coordinator recovery caller', prompt: 'Wait for the private scoped follow-up.' }, getContextBySession(original.sessionId)!);
        expect(caller).toMatchObject({ ok: true, result: { sessionId: expect.any(String) } });
        const callerSid = (caller.result as { sessionId: string }).sessionId;
        await until(() => {
          const sequence = getAgentTurnStartSequence(callerSid), end = getAgentLastTurnEnd(callerSid);
          return sequence > 0 && end?.sequence === sequence && end.outcome === 'completed' &&
            controlledStopReturned(getContextBySession(callerSid)!.token, sequence) && pty.getSessionState(callerSid) === 'idle';
        }, 'physical recovery caller completed its actual Stop and HTTP response');
        // Reuse the existing F-1116 fixture's narrow recovery grant to the
        // same real caller. Production role/intent/physical checks stay live.
        const callerGrant = getContextBySession(callerSid)!;
        const recoveryGrant = mintToken({ label: 'controlled spend recovery caller', role: callerGrant.role,
          providerId: callerGrant.providerId, missionId: review.missionId, scope: callerGrant.scope,
          executionScope: callerGrant.executionScope, contextRevision: callerGrant.contextRevision,
          workerIncarnationId: callerGrant.workerIncarnationId, readOnly: callerGrant.readOnly,
          allowedTools: ['nexus_mission_request_resume'], allowedSkills: [] });
        releaseSession(callerSid); bindTokenToSession(recoveryGrant.token, callerSid);
        previousSpec = structuredClone(stores.missionPanes.list(review.missionId).find(pane => pane.role === 'orchestrator')!);
        expect(await pty.orchTerminateSession(original.sessionId, { origin: 'spend-fixture:old-coordinator-exit' })).toBe(true);
        const resumeHook = deferred<void>(); holdNextHook = () => resumeHook.resolve(); holdIdle = true;
        resumed = dispatchToolCall('http-mcp', { serverName: 'spend-fixture-domain', serverVersion: '0', tools: buildDomainTools() },
          'nexus_mission_request_resume', { missionId: review.missionId, note: 'Resume the private native spend fixture.' }, getContextBySession(callerSid)!, { callerSignal: abort.signal });
        let resumeOutcome: Awaited<typeof resumed> | undefined;
        void resumed.then(outcome => { resumeOutcome = outcome; });
        void resumed.catch(() => undefined);
        await Promise.race([resumeHook.promise, resumed]);
        expect(resumeOutcome, JSON.stringify(resumeOutcome)).toBeUndefined();
      }
      const chief = pty.listAgentSessions().find(a => a.missionId === review.missionId && a.role === 'orchestrator')!;
      targetSid = chief.sessionId;
      const bound = structuredClone(stores.missions.get(review.missionId)!);
      expect(bound.orchestratorSessionId).toBe(targetSid);
      const gateSha256 = createHash('sha256').update(getContextBySession(targetSid)!.token).digest('hex');
      fs.writeFileSync(path.join(controlledDir, 'spawn-before-stop.json'), JSON.stringify({ gateSha256, agentName: reviewerName }), { mode: 0o600 });
      await until(() => heldIdle !== undefined, 'original real idle resolution captured');
      await idleResolved.promise;
      expect(heldIdle, 'only the original real idle resolution is held').toBe('idle');
      const targetTicks = () => ticks.filter(tick => tick.ownerSid === targetSid);
      const beforeTicks = targetTicks().length;
      holdNextHook = () => reviewerHook.resolve();
      releaseHook();
      await reviewerHook.promise;
      await until(() => reviewerIdle, 'reviewer original real idle resolution before native submit');
      const reviewerGateHash = createHash('sha256').update(getContextBySession(reviewerSid)!.token).digest('hex');
      turnHold = path.join(controlledDir, `turn-hold.${reviewerGateHash}`); fs.writeFileSync(turnHold, '', { mode: 0o600 });
      releaseHook();
      const calls = (): Array<{ pid: number; gateSha256: string; tool: string; body: { result: { content: Array<{ text: string }>; isError?: boolean } }; status: number }> => {
        try { return fs.readFileSync(path.join(controlledDir, 'mcp.ndjson'), 'utf8').trim().split('\n').map(line => JSON.parse(line)); } catch { return []; }
      };
      await until(() => calls().some(call => call.gateSha256 === gateSha256 && call.tool === 'nexus_pane_spawn'), 'exact chief returned real spawn RPC');
      const rpc = calls().find(call => call.gateSha256 === gateSha256 && call.tool === 'nexus_pane_spawn')!;
      expect(rpc.status).toBe(200); expect(rpc.body.result.isError).not.toBe(true);
      fs.rmSync(turnHold, { force: true });
      const worker = JSON.parse(rpc.body.result.content[0]!.text) as { sessionId: string; paneId: string };
      expect(pty.getAgentSessionInfo(worker.sessionId)).toMatchObject({ missionId: review.missionId, agentName: reviewerName, readOnly: true });
      const footprints = await pty.probePaneFootprints();
      expect(footprints!.find(p => p.sessionId === worker.sessionId)?.rootPid).toBeGreaterThan(0);
      const spent = stores.missions.get(review.missionId)!;
      expect(spent.intentContract!.spentSteps).toBeGreaterThan(bound.intentContract!.spentSteps ?? 0);
      expect(spent.intentContract!.spentTokens).toBeGreaterThan(bound.intentContract!.spentTokens ?? 0);
      expect(spent.updatedAt).toBeGreaterThan(bound.updatedAt);
      expect(missionIntentAuthoritySnapshot(spent.intentContract!)).toEqual(missionIntentAuthoritySnapshot(bound.intentContract!));
      expect({ ...spent, updatedAt: bound.updatedAt, intentContract: missionIntentAuthoritySnapshot(spent.intentContract!) })
        .toEqual({ ...bound, intentContract: missionIntentAuthoritySnapshot(bound.intentContract!) });
      expect(spent.intentVersion).toBe(bound.intentVersion); expect(spent.orchestratorSessionId).toBe(targetSid);
      expect(targetTicks().length, 'new watcher cannot tick while its setup is held').toBe(beforeTicks);
      console.info('F1134 causal spend proved', { mode, sessionId: targetSid, updatedAtBefore: bound.updatedAt, updatedAtAfter: spent.updatedAt,
        spentSteps: spent.intentContract!.spentSteps, spentTokens: spent.intentContract!.spentTokens, physicalReviewer: worker.sessionId });
      const boundSpec = structuredClone(stores.missionPanes.findByPaneId(chief.paneId!)!);
      if (mode === 'resume-unknown-exit') {
        const terminate = pty.orchTerminateSession;
        termination = vi.spyOn(pty, 'orchTerminateSession').mockImplementation((sid, options) =>
          sid === targetSid && options?.origin === 'fast-lane:owned-resume-failed' ? Promise.resolve(false) : terminate(sid, options));
      }
      if (mode === 'resume-abort' || mode === 'resume-unknown-exit') abort.abort();
      idleRelease.resolve();
      if (mode === 'resume-abort' || mode === 'resume-unknown-exit') {
        expect(await resumed).toMatchObject({ ok: false });
        expect(stores.missions.get(review.missionId)).toMatchObject({ status: 'blocked', intentState: 'blocked_technical',
          intentContract: { spentSteps: spent.intentContract!.spentSteps, spentTokens: spent.intentContract!.spentTokens } });
        if (mode === 'resume-abort') {
          expect(pty.getAgentSessionInfo(targetSid)).toBeNull();
          expect(stores.missionPanes.list(review.missionId).find(pane => pane.id === previousSpec!.id)).toEqual(previousSpec);
        } else {
          expect(pty.getAgentSessionInfo(targetSid)).not.toBeNull();
          expect(stores.missionPanes.findByPaneId(chief.paneId!)).toEqual(boundSpec);
          expect(stores.missions.get(review.missionId)?.orchestratorSessionId).toBe(targetSid);
        }
        console.info('F1134 spent owned failure cleanup proved', { mode, physicalExitProven: mode === 'resume-abort' });
        return;
      }
      if (resumed) expect(await resumed).toMatchObject({ ok: true, result: { resumed: true, reason: 'mounted' } });
      expect(await proofOf(targetSid).promise, 'actual exact native kickoff delivery completed').toBe(true);
      expect(provedKickoffBriefDelivery(scope, review.missionId)?.orchestratorSessionId).toBe(targetSid);
      const argv = fs.readFileSync(path.join(controlledDir, 'accepted.ndjson'), 'utf8').trim().split('\n')
        .map(line => JSON.parse(line) as { pid: number; kind: string; sha256: string }).find(message => message.pid === rpc.pid && message.kind === 'argv')!;
      expect(argv).toBeDefined();
      expect(provedKickoffBriefDelivery(scope, review.missionId)).toMatchObject({ missionId: review.missionId, scope,
        orchestratorSessionId: targetSid, intentVersion: bound.intentVersion, promptHash: argv.sha256 });
      await until(() => targetTicks().length > beforeTicks, 'setup committed and actual new 15-second periodic watcher tick');
      const tick = targetTicks().at(-1)!;
      expect(tick.cadence).toBe(15_000);
      expect(watcherOwners.get(tick.signal)).toBe(targetSid);
      expect(stores.missions.get(review.missionId)).toMatchObject({ status: 'running', orchestratorSessionId: targetSid });
      console.info('F1134 setup and real watcher proved', { mode, sessionId: targetSid, cadence: tick.cadence, oldGenerationTicks: ticks.filter(value => value.ownerSid !== targetSid).length });
    } finally {
      fs.rmSync(path.join(controlledDir, 'spawn-before-stop.json'), { force: true });
      if (turnHold) fs.rmSync(turnHold, { force: true });
      idleRelease.resolve(); releaseHook(); holdNextHook = null;
      idleSpy.mockRestore(); proofSpy.mockRestore(); periodicSpy.mockRestore(); termination?.mockRestore();
      abort.abort();
      for (const session of pty.listAgentSessions().filter(a => a.missionId === review.missionId)) {
        expect(await pty.orchTerminateSession(session.sessionId, { origin: 'spend-fixture:teardown' })).toBe(true);
      }
      await resumed?.catch(() => undefined);
      console.info('F1134 fixture-owned teardown physically proved', { mode, missionId: review.missionId });
    }
  }, 120_000);

  it.runIf(CONTROLLED).each(['abort', 'authority', 'newer-session', 'newer-intent', 'operator-close', 'unknown-exit', 'proved-self-revocation', 'paste-abort'] as const)(
    'F-1116: actual Main/PTY resume keeps exact ownership under %s after fresh binding', async fault => {
    nativeHookHeld = false; chiefId = '';
    const { ORCH_CHANNELS } = await import('../../shared/orch-channels');
    const { getProjectDomainStores } = await import('./project-domain-store-registry');
    const { dispatchToolCall } = await import('./mcp-dispatch');
    const { buildDomainTools } = await import('./tools-domain');
    const { buildPaneTools } = await import('./tools-panes');
    const { getContextBySession, mintToken, bindTokenToSession, releaseSession } = await import('./gate');
    const { getAgentTurnStartSequence, getAgentLastTurnEnd } = await import('./agent-status');
    const { provedKickoffBriefDelivery } = await import('./mission-kickoff-direct-queue');
    const { MISSION_RUNTIME_CLOSED_MARKER } = await import('../../shared/mission-recovery-policy');
    const { hasCurrentDispatchAuthority } = await import('../../shared/mission-intent');
    const pty = await import('../pty/pty-manager');
    const invoke = (channel: string, input: unknown) => state.handlers.get(channel)!({ sender: owner, senderFrame: owner.mainFrame }, input);
    const tools = ['nexus_pane_spawn', 'nexus_handoff_submit', 'nexus_handoff_list', 'nexus_handoff_ack', 'nexus_mission_request_resume'];
    const review = await invoke(ORCH_CHANNELS.missionPrepare, { title: `Runtime resume ${fault} ${nonce}`,
      objective: 'Produce a private report after the coordinator has resumed, preserving the waiting participant.', contextPaths: [],
      roster: [
        { id: 'rt-resume-chief', agentName: 'Runtime chief', category: 'orchestrator', cli: 'claude', allowedTools: tools, allowedSkills: [] },
        { id: 'rt-resume-caller', agentName: 'Resume caller', category: 'executor', cli: 'claude', allowedTools: tools, allowedSkills: [] },
        { id: 'rt-resume-reviewer', agentName: 'Resume reviewer', category: 'reviewer', cli: 'claude', allowedTools: tools, allowedSkills: [] },
      ], advanced: { lane: 'standard' } }) as MissionReview;
    await invoke(ORCH_CHANNELS.missionStart, { missionId: review.missionId, reviewSha256: review.reviewSha256 });
    const stores = getProjectDomainStores(scope);
    await until(() => nativeHookHeld, 'original coordinator native hook');
    const original = pty.listAgentSessions().find(session => session.missionId === review.missionId && session.role === 'orchestrator')!;
    expect(original).toBeDefined(); chiefId = original.sessionId;
    releaseHook();
    await until(() => stores.missions.hasCurrentKickoffAcceptance(review.missionId) && pty.getSessionState(original.sessionId) === 'idle', 'original coordinator completed its native kickoff');
    const chiefContext = getContextBySession(original.sessionId)!;
    expect(chiefContext).not.toBeNull();
    const spawnedCaller = await dispatchToolCall('http-mcp', { serverName: 'resume-fixture-panes', serverVersion: '0', tools: buildPaneTools() },
      'nexus_pane_spawn', { adapterId: 'claude', operatorChoice: true, agentName: 'Resume caller', role: 'worker',
        task: 'Hold the scoped coordinator resume request', prompt: `RT_GATE IDLE ${nonce}. Preserve the waiting participant.` }, chiefContext);
    expect(spawnedCaller, JSON.stringify(spawnedCaller)).toMatchObject({ ok: true, result: { sessionId: expect.any(String) } });
    const callerSessionId = (spawnedCaller.result as { sessionId: string }).sessionId;
    await until(() => {
      const sequence = getAgentTurnStartSequence(callerSessionId), end = getAgentLastTurnEnd(callerSessionId);
      return sequence > 0 && end?.sequence === sequence && end.outcome === 'completed' &&
        controlledStopReturned(getContextBySession(callerSessionId)!.token, sequence) && pty.getSessionState(callerSessionId) === 'idle';
    }, 'caller completed its matching authentic Stop and returned HTTP response');
    const caller = structuredClone(pty.getAgentSessionInfo(callerSessionId)!);
    const callerExits: Array<import('../pty/pty-manager').SessionRootExit | null> = [];
    const untapCallerTermination = pty.tapSessionTermination((sid, _agent, rootExit) => {
      if (sid === callerSessionId) { callerExits.push(rootExit); console.info('F1116 logical caller termination tap', { fault, rootExit }); }
    });
    const originalCallerContext = getContextBySession(callerSessionId)!;
    // Main fixture grants one recovery tool to an existing physical caller;
    // production allowlist/role/intent and exact session checks stay real.
    const callerContext = mintToken({ label: 'controlled resume caller', role: originalCallerContext.role,
      providerId: originalCallerContext.providerId, missionId: review.missionId, scope: originalCallerContext.scope,
      executionScope: originalCallerContext.executionScope, contextRevision: originalCallerContext.contextRevision,
      workerIncarnationId: originalCallerContext.workerIncarnationId, readOnly: originalCallerContext.readOnly,
      allowedTools: ['nexus_mission_request_resume'], allowedSkills: [] });
    releaseSession(callerSessionId);
    bindTokenToSession(callerContext.token, callerSessionId);
    const previousSpec = structuredClone(stores.missionPanes.list(review.missionId).find(pane => pane.role === 'orchestrator')!);
    expect(await pty.orchTerminateSession(original.sessionId, { origin: 'resume-native-fixture:old-coordinator-exit' })).toBe(true);
    const resumeHook = deferred<void>();
    holdNextHook = () => resumeHook.resolve();
    const abort = new AbortController();
    const promptDelivery = state.adapter!.spawn.initialPrompt;
    if (fault === 'paste-abort') state.adapter!.spawn.initialPrompt = 'paste';
    const resumed = dispatchToolCall('http-mcp', { serverName: 'resume-fixture-domain', serverVersion: '0', tools: buildDomainTools() },
      'nexus_mission_request_resume', { missionId: review.missionId, note: 'Controlled native resume cancellation after binding.' }, callerContext,
      { callerSignal: abort.signal });
    let resumeOutcome: Awaited<typeof resumed> | undefined;
    void resumed.then(outcome => { resumeOutcome = outcome; });
    void resumed.catch(() => undefined);
    await until(() => resumeOutcome !== undefined || stores.missions.get(review.missionId)?.orchestratorSessionId !== original.sessionId &&
      Boolean(pty.listAgentSessions().find(session => session.missionId === review.missionId && session.role === 'orchestrator')), 'fresh coordinator physical binding');
    expect(resumeOutcome, JSON.stringify(resumeOutcome)).toBeUndefined();
    const fresh = pty.listAgentSessions().find(session => session.missionId === review.missionId && session.role === 'orchestrator')!;
    expect(fresh.sessionId).not.toBe(original.sessionId);
    expect(stores.missions.get(review.missionId)?.orchestratorSessionId).toBe(fresh.sessionId);
    expect(stores.missionPanes.list(review.missionId).find(pane => pane.role === 'orchestrator')?.paneId).toBe(fresh.paneId);
    await resumeHook.promise;
    let termination: ReturnType<typeof vi.spyOn> | undefined;
    let proofCheck: ReturnType<typeof vi.spyOn> | undefined;
    let abortAfterProof = false;
    const retirements: Array<{ sessionId: string; origin?: string; before: Mission | null; proven?: boolean }> = [];
    const boundSpec = structuredClone(stores.missionPanes.findByPaneId(fresh.paneId!)!);
    const terminate = pty.orchTerminateSession;
    termination = vi.spyOn(pty, 'orchTerminateSession').mockImplementation(async (sessionId, options) => {
      const before = stores.missions.get(review.missionId);
      const entry = { sessionId, origin: options?.origin, before: before ? structuredClone(before) : null, proven: undefined as boolean | undefined };
      retirements.push(entry);
      entry.proven = fault === 'unknown-exit' && sessionId === fresh.sessionId && options?.origin === 'fast-lane:owned-resume-failed'
        ? false : await terminate(sessionId, options);
      console.info('F1116 actual physical termination attribution', { fault, sessionId, origin: entry.origin,
        preStatus: entry.before?.status, preIntent: entry.before?.intentState, preLeader: entry.before?.orchestratorSessionId, proven: entry.proven });
      return entry.proven;
    });
    const transition = stores.missions.transitionLifecycle.bind(stores.missions);
    const transitions: Mission[] = [];
    const transitionSpy = vi.spyOn(stores.missions, 'transitionLifecycle').mockImplementation((...args) => {
      const updated = transition(...args);
      if (args[0] === review.missionId && updated) transitions.push(structuredClone(updated));
      return updated;
    });
    const compensate = stores.missionPanes.compensateOrchestratorSpawn.bind(stores.missionPanes);
    const compensations: string[] = [];
    const compensationSpy = vi.spyOn(stores.missionPanes, 'compensateOrchestratorSpawn').mockImplementation((...args) => {
      compensations.push(args[0].id); return compensate(...args);
    });
    if (fault === 'newer-session') stores.missions.setOrchestratorSession(review.missionId, callerSessionId);
    if (fault === 'newer-intent') {
      const row = stores.missions.get(review.missionId)!;
      stores.missions.update(review.missionId, { intentVersion: 2, intentContract: { ...row.intentContract!, intentVersion: 2 } });
    }
    if (fault === 'operator-close') stores.missions.update(review.missionId, {
      status: 'blocked', intentState: 'blocked_user', description: MISSION_RUNTIME_CLOSED_MARKER,
    });
    const changed = structuredClone(stores.missions.get(review.missionId)!);
    if (fault === 'proved-self-revocation') {
      const hasAcceptance = stores.missions.hasCurrentKickoffAcceptance.bind(stores.missions);
      proofCheck = vi.spyOn(stores.missions, 'hasCurrentKickoffAcceptance').mockImplementation(missionId => {
        const accepted = hasAcceptance(missionId);
        if (missionId === review.missionId && accepted &&
            provedKickoffBriefDelivery(scope, missionId)?.orchestratorSessionId === fresh.sessionId) {
          abortAfterProof = true; abort.abort();
        }
        return accepted;
      });
    } else if (fault === 'authority') releaseSession(callerSessionId);
    else abort.abort();
    releaseHook();
    try {
      expect(await resumed).toMatchObject({ ok: false });
      const ownRetirements = retirements.filter(entry => entry.origin === 'fast-lane:owned-resume-failed');
      expect(ownRetirements.every(entry => entry.sessionId === fresh.sessionId)).toBe(true);
      expect(ownRetirements.some(entry => entry.sessionId === callerSessionId)).toBe(false);
      if (fault === 'paste-abort') expect(ownRetirements).toMatchObject([{ sessionId: fresh.sessionId, proven: true }]);
      if (fault === 'abort' || fault === 'authority' || fault === 'paste-abort') {
        expect(pty.getAgentSessionInfo(fresh.sessionId), 'revoked unproved resume must not leave its new physical coordinator').toBeNull();
        expect(stores.missions.get(review.missionId)).toMatchObject({ status: 'blocked', intentState: 'blocked_technical' });
        expect(stores.missionPanes.list(review.missionId).find(pane => pane.id === previousSpec.id)).toEqual(previousSpec);
      } else if (fault === 'unknown-exit') {
        expect(pty.getAgentSessionInfo(fresh.sessionId)).not.toBeNull();
        expect(stores.missions.get(review.missionId)).toMatchObject({ status: 'blocked', intentState: 'blocked_technical', orchestratorSessionId: fresh.sessionId });
        expect(stores.missionPanes.findByPaneId(fresh.paneId!)).toEqual(boundSpec);
      } else {
        if (fault === 'proved-self-revocation') {
          expect(abortAfterProof).toBe(true);
          expect((await import('./mission-fast-lane')).fastLaneOrchestratorPaneSummary(scope, review.missionId)?.sessionId).toBe(fresh.sessionId);
        }
        expect(ownRetirements).toEqual([]); expect(transitions).toEqual([]); expect(compensations).toEqual([]);
        const policy = retirements.find(entry => entry.sessionId === fresh.sessionId && entry.origin === 'mission-termination' &&
          entry.proven === true && entry.before && !hasCurrentDispatchAuthority(entry.before));
        if (pty.getAgentSessionInfo(fresh.sessionId)) {
          expect(stores.missions.get(review.missionId)).toEqual(changed);
        } else {
          // Runtime-closed revokes this coordinator; only the real policy
          // terminator's exact pre-row and physical proof justify absence.
          expect(policy, 'fresh disappearance needs independently authorized physical teardown').toBeDefined();
          expect(policy!.before).toEqual(changed);
          const after = stores.missions.get(review.missionId)!;
          expect([changed.orchestratorSessionId, undefined]).toContain(after.orchestratorSessionId);
          expect(after.updatedAt).toBeGreaterThanOrEqual(changed.updatedAt);
          expect({ ...after, updatedAt: changed.updatedAt, orchestratorSessionId: changed.orchestratorSessionId }).toEqual(changed);
        }
        expect(stores.missionPanes.findByPaneId(fresh.paneId!)).toEqual(boundSpec);
      }
      const callerNow = pty.getAgentSessionInfo(callerSessionId);
      if (callerNow) expect(callerNow).toEqual(caller);
      else {
        const policy = retirements.find(entry => entry.sessionId === callerSessionId && entry.origin === 'mission-termination' &&
          entry.proven === true && entry.before && !hasCurrentDispatchAuthority(entry.before));
        expect(policy, 'caller disappearance needs independently authorized physical teardown').toBeDefined();
      }
    } finally {termination?.mockRestore(); proofCheck?.mockRestore(); transitionSpy.mockRestore(); compensationSpy.mockRestore();
      state.adapter!.spawn.initialPrompt = promptDelivery; untapCallerTermination();}
  }, 120_000);

  it.runIf(CONTROLLED)('F-1122: registered Main/real PTY proves the native turn after one swallowed Enter without repasting', async () => {
    profileFlow = true;
    const receipts = path.join(root, 'prompt-proof-cli'); fs.mkdirSync(receipts, { mode: 0o700 });
    profileOriginalAdapter = state.adapter;
    state.adapter = { ...state.adapter!, env: { ...state.adapter!.env, static: { ...state.adapter!.env?.static,
      NEXUS_CONTROLLED_CLI_DIR: receipts, NEXUS_CONTROLLED_PROFILE_FIXTURE: '1', NEXUS_CONTROLLED_SWALLOW_FIRST_ENTER: '1' } } };
    const { initUsageTelemetry, shutdownUsageTelemetry } = await import('../usage/usage-service');
    await initUsageTelemetry(profileManager!); closeUsage = shutdownUsageTelemetry;
    const { startAgentHookHttpServer } = await import('../agent-hooks/hook-http-server');
    const hooks = await startAgentHookHttpServer({ userDataPath: state.userData }); closeAgentHooks = hooks.close;
    const pty = await import('../pty/pty-manager'); pty.configureAgentHookEndpointPath(hooks.endpointFilePath);
    const { PTY_CHANNELS } = await import('../../shared/channels');
    const { getContextBySession } = await import('./gate');
    const { getProviderPaneSession } = await import('../persistence/provider-session-store');
    const { submitPromptToPaneConfirmed } = await import('../../renderer/terminal/pane-submit');
    const invoke = (channel: string, input: unknown) => state.handlers.get(channel)!({ sender: owner, senderFrame: owner.mainFrame }, input);
    const paneId = `prompt-proof-user-${nonce}`;
    const spawned = await invoke(PTY_CHANNELS.spawn, { kind: 'cli-agent', adapterId: 'claude', paneId, cwd: repo, cols: 80, rows: 24,
      resume: false, resumeLatestOnly: false, restorePersistedAuthority: false }) as { ok: boolean; sessionId: string; error?: string };
    expect(spawned.ok, spawned.error).toBe(true);
    const sessionId = spawned.sessionId;
    try {
      expect(getContextBySession(sessionId)).toMatchObject({ role: 'user', scope });
      const probe = (sid: string) => Promise.resolve(invoke(PTY_CHANNELS.promptState, { sessionId: sid })) as Promise<import('../../shared/types').PtyPromptState | null>;
      await vi.waitFor(async () => {
        expect(await probe(sessionId)).toMatchObject({ state: 'idle', awaitingInput: false, turnStartSequence: expect.any(Number) });
        expect((await probe(sessionId))!.turnStartSequence).toBeGreaterThan(0);
        expect(getProviderPaneSession(scope, paneId, 'claude')).not.toBeNull();
      }, { timeout: 45_000, interval: 20 });
      const baseline = (await probe(sessionId))!;
      const foreign = state.handlers.get(PTY_CHANNELS.promptState)!({ sender: { ...owner, id: owner.id + 1 }, senderFrame: owner.mainFrame }, { sessionId });
      expect(foreign).toBeNull(); expect(await probe('unknown-session')).toBeNull();
      expect(await invoke(PTY_CHANNELS.promptEnter, { sessionId, turnStartSequence: baseline.turnStartSequence + 1, retry: false })).toBe(false);
      const footprint = (await pty.probePaneFootprints())!.find(p => p.sessionId === sessionId)!;
      expect(footprint.rootPid).toBeGreaterThan(0);
      const inputStart = inputs.length;
      const text = `RT_GATE PROMPT_PROOF ${nonce}`;
      const payload = `\x1b[200~${text}\x1b[201~`;
      const enterRequests: Array<{ sessionId: string; sequence: number; retry: boolean; accepted: boolean }> = [];
      let result: boolean | undefined;
      const submitted = submitPromptToPaneConfirmed(paneId, text, sessionId, {
        getSessionId: () => pty.getAgentSessionInfo(sessionId)?.paneId === paneId ? sessionId : null,
        write: (sid, data) => { void invoke(PTY_CHANNELS.write, { sessionId: sid, data }); },
        writeConfirmed: async (sid, data) => await invoke(PTY_CHANNELS.writeConfirmed, { sessionId: sid, data }) as boolean,
        probePromptState: probe,
        submitPromptEnter: async (sid, sequence, retry) => {
          const accepted = await invoke(PTY_CHANNELS.promptEnter, { sessionId: sid, turnStartSequence: sequence, retry }) as boolean;
          enterRequests.push({ sessionId: sid, sequence, retry, accepted }); return accepted;
        },
        schedule: (callback, ms) => setTimeout(callback, ms),
      }).then(accepted => { result = accepted; return accepted; });
      const read = (name: string): Array<{ pid: number; kind: string; sha256: string }> => fs.existsSync(path.join(receipts, `${name}.ndjson`))
        ? fs.readFileSync(path.join(receipts, `${name}.ndjson`), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
      await until(() => read('prompt-enter').some(r => r.kind === 'swallowed'), 'owned physical CLI swallowed its first Enter');
      expect(result).toBeUndefined();
      expect((await probe(sessionId))!.turnStartSequence).toBe(baseline.turnStartSequence);
      expect(inputs.slice(inputStart).filter(i => i.sessionId === sessionId).map(i => i.data)).toEqual([payload, '\r']);
      expect(await submitted).toBe(true);
      expect(enterRequests).toEqual([
        { sessionId, sequence: baseline.turnStartSequence, retry: false, accepted: true },
        { sessionId, sequence: baseline.turnStartSequence, retry: true, accepted: true },
      ]);
      const accepted = read('accepted').filter(r => r.kind === 'composer');
      expect(accepted).toHaveLength(1); expect(accepted[0]!.sha256).toBe(createHash('sha256').update(payload).digest('hex'));
      expect(() => process.kill(accepted[0]!.pid, 0)).not.toThrow();
      const current = (await probe(sessionId))!;
      expect(current.turnStartSequence).toBe(baseline.turnStartSequence + 1);
      expect(inputs.slice(inputStart).filter(i => i.sessionId === sessionId).map(i => i.data)).toEqual([payload, '\r', '\r']);
      const proofDir = path.join(REPO, '.superpowers/sdd/release-076213-reviewed/f1122-source-proof');
      fs.mkdirSync(proofDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(proofDir, 'main-pty-native-facts.json'), JSON.stringify({
        mode: 'controlled-physical-cli-registered-main-pty-authenticated-native-hooks', signedPackagedProof: false,
        paneId, sessionId, rootPid: footprint.rootPid, nativePid: accepted[0]!.pid, baseline, current,
        enterRequests, payloadWrites: 1, composerAcceptances: accepted.length, nativeConversation: getProviderPaneSession(scope, paneId, 'claude')?.id,
      }, null, 2), { mode: 0o600 });
    } finally {
      expect(await pty.orchTerminateSession(sessionId, { origin: 'prompt-proof-fixture:teardown' })).toBe(true);
      expect(pty.getAgentSessionInfo(sessionId)).toBeNull();
    }
  }, 120_000);

  it.runIf(CONTROLLED)('F-1123: registered empty renderer model creates a durable mission through native MCP and createForPane', async () => {
    profileFlow = true;
    const receipts = path.join(root, 'empty-model-cli'); fs.mkdirSync(receipts, { mode: 0o700 });
    profileOriginalAdapter = state.adapter;
    state.adapter = { ...state.adapter!, env: { ...state.adapter!.env, static: { ...state.adapter!.env?.static,
      NEXUS_CONTROLLED_CLI_DIR: receipts, NEXUS_CONTROLLED_PROFILE_FIXTURE: '1' } } };
    const { initUsageTelemetry, shutdownUsageTelemetry } = await import('../usage/usage-service');
    await initUsageTelemetry(profileManager!); closeUsage = shutdownUsageTelemetry;
    const { startAgentHookHttpServer } = await import('../agent-hooks/hook-http-server');
    const hooks = await startAgentHookHttpServer({ userDataPath: state.userData }); closeAgentHooks = hooks.close;
    const pty = await import('../pty/pty-manager'); pty.configureAgentHookEndpointPath(hooks.endpointFilePath);
    const { ORCH_CHANNELS } = await import('../../shared/orch-channels');
    const { PTY_CHANNELS } = await import('../../shared/channels');
    const { getContextBySession } = await import('./gate');
    const { findPane, getPaneRuntimeAuthorityBySession } = await import('./pane-registry');
    const { missionEngineForScope } = await import('./mission-engine-registry');
    const { projectMissionEngineSnapshotView } = await import('./mission-engine-production');
    const { spawnMainOwnedMissionPaneAsync } = await import('./pane-registry');
    const { getProjectDomainStores } = await import('./project-domain-store-registry');
    const { readAuditLog } = await import('../jarvis/audit-log');
    const invoke = (channel: string, input: unknown) => state.handlers.get(channel)!({ sender: owner, senderFrame: owner.mainFrame }, input);
    const stores = getProjectDomainStores(scope);
    const owned: Array<{ paneId: string; sessionId: string; rootPid: number | null }> = [];
    try {
      for (const lane of ['native-mcp', 'renderer-create'] as const) {
        const paneId = `empty-model-${lane}-${nonce}`;
        const spawned = await invoke(PTY_CHANNELS.spawn, { kind: 'cli-agent', adapterId: 'claude', paneId, cwd: repo,
          cols: 80, rows: 24, resume: false, resumeLatestOnly: false, restorePersistedAuthority: false }) as { ok: boolean; sessionId: string; error?: string };
        expect(spawned.ok, spawned.error).toBe(true);
        const sessionId = spawned.sessionId;
        const ownedPane = { paneId, sessionId, rootPid: null as number | null }; owned.push(ownedPane);
        const gateHash = createHash('sha256').update(getContextBySession(sessionId)!.token).digest('hex');
        await until(() => fs.existsSync(path.join(receipts, 'mcp.ndjson')) && fs.readFileSync(path.join(receipts, 'mcp.ndjson'), 'utf8').split('\n').slice(0, -1)
          .map(line => JSON.parse(line) as { gateSha256: string; tool: string }).some(r => r.gateSha256 === gateHash && r.tool === 'nexus_handoff_list'),
        'owned empty-model native MCP readiness');
        const footprint = (await pty.probePaneFootprints())!.find(p => p.sessionId === sessionId)!;
        expect(footprint.rootPid).toBeGreaterThan(0);
        ownedPane.rootPid = footprint.rootPid!;
        const physical = pty.getAgentSessionInfo(sessionId)!;
        expect(physical).toMatchObject({ paneId, role: 'user', requestedModel: undefined, scope });
        // The registered IPC consumes the ordinary layout display default.
        state.listeners.get(ORCH_CHANNELS.panesSync)!({ sender: owner, senderFrame: owner.mainFrame }, { generationId: `empty-model-${lane}-${nonce}`, entries: [{
          paneId, sessionId, paneNumber: 1, title: 'Claude', kind: 'cli-agent', adapterId: 'claude', model: '', state: 'idle', tabKey: '__loose__',
        }] });
        expect(findPane(sessionId)).toMatchObject({ paneId, sessionId });
        if (lane === 'native-mcp') {
          expect(await invoke(PTY_CHANNELS.writeConfirmed, { sessionId, data: `\x1b[200~RT_GATE PROFILE_CREATE_ONLY ${nonce}\x1b[201~` })).toBe(true);
          expect(await invoke(PTY_CHANNELS.writeConfirmed, { sessionId, data: '\r' })).toBe(true);
          await until(() => readAuditLog({ scope }, 1000).some(a => a.tool === 'nexus_mission_create' && a.result === 'ok' &&
            a.session === sessionId && a.source === 'http-mcp' && a.invocation_id), 'actual authenticated empty-model mission creation');
        } else {
          const created = await invoke(ORCH_CHANNELS.missionCreateForPane, { paneId, title: 'Empty model renderer mission', tabKey: '__loose__' }) as { ok: boolean; error?: string };
          expect(created.ok, created.error).toBe(true);
        }
        const mission = stores.missions.list().find(m => m.orchestratorSessionId === sessionId)!;
        expect(mission).toMatchObject({ status: 'running', intentState: 'dispatched', orchestratorSessionId: sessionId });
        expect(stores.missionPanes.findByPaneId(paneId)).toMatchObject({ missionId: mission.id, role: 'orchestrator', adapterId: 'claude',
          model: lane === 'native-mcp' ? undefined : physical.model });
        expect(getContextBySession(sessionId)).toMatchObject({ role: 'orchestrator', missionId: mission.id, scope });
        expect(pty.getAgentSessionInfo(sessionId)).toMatchObject({ role: 'orchestrator', missionId: mission.id, scope });
        // F-1143: successful Gate/PTY/durable adoption must also publish the
        // creator to the physical registry and canonical engine consumers.
        for (const phase of ['adopted', 'later-layout-sync', 'worker-terminated'] as const) {
          if (phase === 'later-layout-sync') {
            state.listeners.get(ORCH_CHANNELS.panesSync)!({ sender: owner, senderFrame: owner.mainFrame }, { generationId: `empty-model-${lane}-${nonce}`, entries: [{
              paneId, sessionId, paneNumber: 1, title: 'Claude', kind: 'cli-agent', adapterId: 'claude', model: '', state: 'idle', tabKey: '__loose__',
            }] });
          }
          if (phase === 'worker-terminated' && lane === 'native-mcp') {
            // This exercises the existing Main-owned physical worker boundary.
            // MCP routing is covered by the fixture's unchanged named-seat cases;
            // its sole synthetic Claude adapter cannot satisfy diverse free routing.
            const spawnedWorker = await spawnMainOwnedMissionPaneAsync({ adapterId: 'claude', role: 'worker',
              missionId: mission.id, scope, allowedTools: [], allowedSkills: [],
              initialPrompt: `RT_GATE IDLE ${nonce}. Await the next instruction.` });
            expect(spawnedWorker, JSON.stringify(spawnedWorker)).toMatchObject({ ok: true, sessionId: expect.any(String) });
            const worker = spawnedWorker as { sessionId: string; paneId: string };
            owned.push({ ...worker, rootPid: null });
            expect(pty.getAgentSessionInfo(worker.sessionId)).toMatchObject({ role: 'worker', missionId: mission.id });
            expect(await pty.orchTerminateSession(worker.sessionId, { origin: 'leader-publication-fixture:intentional-writer-termination' })).toBe(true);
            expect(pty.getAgentSessionInfo(worker.sessionId)).toBeNull();
          }
          expect.soft(getPaneRuntimeAuthorityBySession(sessionId), phase).toMatchObject({
            paneId, sessionId, role: 'orchestrator', missionId: mission.id, scope, executionScope: scope, owner,
          });
          const view = projectMissionEngineSnapshotView(scope, stores, mission.id);
          expect(view.orchestratorLive, phase).toBe(true);
          expect.soft(view.roster.filter(agent => agent.id === 'orchestrator'), phase).toMatchObject([{ category: 'orchestrator' }]);
          expect.soft(view.panes.filter(pane => pane.agentId === 'orchestrator'), phase).toMatchObject([{ paneId, terminalLive: true }]);
          const snapshot = await missionEngineForScope(scope).snapshot(scope, mission.id);
          expect.soft(snapshot.agents.filter(agent => agent.paneId === paneId), phase).toMatchObject([{
            id: 'orchestrator', category: 'orchestrator', paneId, terminalLive: true,
          }]);
        }
        await invoke(ORCH_CHANNELS.missionCommand, { kind: 'stop', missionId: mission.id });
        expect(pty.getAgentSessionInfo(sessionId)).toBeNull();
      }
      const proofDir = path.join(REPO, '.superpowers/sdd/release-076213-reviewed/f1123-source-proof');
      fs.mkdirSync(proofDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(proofDir, 'main-pty-native-facts.json'), JSON.stringify({
        mode: 'controlled-physical-cli-registered-main-renderer-sync-authenticated-native-mcp-and-createForPane',
        signedPackagedProof: false, fixtureRoot: root, rendererModel: '', normalizedRendererModelOmitted: true, owned,
        nativePids: [...new Set(fs.readFileSync(path.join(receipts, 'accepted.ndjson'), 'utf8').trim().split('\n')
          .map(line => (JSON.parse(line) as { pid: number }).pid))],
      }, null, 2), { mode: 0o600 });
    } finally {
      for (const pane of owned) {
        if (pty.getAgentSessionInfo(pane.sessionId)) expect(await pty.orchTerminateSession(pane.sessionId, { origin: 'empty-model-fixture:teardown' })).toBe(true);
        expect(pty.getAgentSessionInfo(pane.sessionId)).toBeNull();
      }
    }
  }, 120_000);
});
