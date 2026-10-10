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
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CliPtyAdapter } from '../../shared/adapter-types';
import type { ProjectExecutionScope } from '../../shared/types';
import type { HostControlMsg, HostEventMsg } from '../pty/pty-host-core';
import type { MissionReview } from '../../shared/mission-engine-contract';

const ENABLED = process.env.NEXUS_DIRECT_BOOTSTRAP_E2E === '1';
const CONTROLLED = process.env.NEXUS_DIRECT_BOOTSTRAP_CONTROLLED_CLI === '1';
if (ENABLED) process.argv.push('nexus-smoke-test');
const REPO = process.cwd();
const state = vi.hoisted(() => ({
  userData: '', appRoot: '', adapter: null as CliPtyAdapter | null,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
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
    ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => { state.handlers.set(channel, handler); }, handleOnce: noop, on: noop, once: noop, removeHandler: (channel: string) => state.handlers.delete(channel), removeListener: noop, removeAllListeners: noop },
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
  let releaseConsent: () => void = () => undefined;
  let scope: ProjectExecutionScope;
  let gateway: http.Server | null = null;
  let gatewayUrl = '';
  const nonce = randomUUID();
  const owner = { id: 1109, isDestroyed: () => false, isCrashed: () => false,
    mainFrame: {}, send: () => undefined, on: () => undefined, once: () => undefined, removeListener: () => undefined };
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
  const spawnOutcomes: Array<{ ok: boolean; error?: string; hasSession: boolean }> = [];
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();

  beforeAll(async () => {
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
    const { configurePtyProjectRuntimeManager } = await import('../pty/pty-ipc');
    const { configureRendererMissionAuthority, initOrchestration, closeOrchestration, registerOrchIpc } = await import('./orch-ipc');
    const { configureWorktreeRuntimeRegistry, disposeWorktreeRuntimeRegistry } = await import('../runtime/worktree-runtime-registry');
    const { configureContextWorkflowRegistry } = await import('../context/context-workflow-registry');
    const { configureMissionEventEmit } = await import('./mission-event-emit');
    const { disposeProjectDomainStoreRegistry } = await import('./project-domain-store-registry');
    const pty = await import('../pty/pty-manager');
    const manager = new ProjectRuntimeManager({ baseDir: path.join(state.userData, 'project-runtime'), appVersion: '0.0.0-direct-fixture' });
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
      if (req.url === '/hook/status' && req.headers['x-nexus-hook-event'] === 'user-submit' && (!chiefId || holdNextHook)) {
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
    await initOrchestration(); closeMain = closeOrchestration; registerOrchIpc();
  }, 120_000);

  afterAll(async () => {
    releaseHook(); lifetime.abort(); releaseConsent(); untapInput(); intercept?.mockRestore();
    const pty = await import('../pty/pty-manager');
    for (const session of pty.listAgentSessions()) {
      const exited = await pty.orchTerminateSession(session.sessionId, { origin: 'direct-native-fixture:teardown' });
      if (!exited) throw new Error('owned fixture physical exit unproven; private resources retained');
    }
    await closeMain(); await closeAnalysis(); await closeStores(); closeRuntime(); closeManager();
    if (host) { if (host.connected) host.disconnect(); await new Promise<void>(resolve => { if (host!.exitCode !== null) resolve(); else host!.once('exit', () => resolve()); }); }
    for (const socket of sockets) socket.destroy();
    if (gateway) await new Promise<void>(resolve => gateway!.close(() => resolve()));
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }, 120_000);

  it('queues a cold direct instead of certifying the unrelated native argv turn, then delivers the exact envelope once', async () => {
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

  it.runIf(CONTROLLED).each(['abort', 'authority', 'newer-session', 'newer-intent', 'operator-close', 'unknown-exit', 'proved-self-revocation', 'paste-abort'] as const)(
    'F-1116: actual Main/PTY resume keeps exact ownership under %s after fresh binding', async fault => {
    nativeHookHeld = false; chiefId = '';
    const { ORCH_CHANNELS } = await import('../../shared/orch-channels');
    const { getProjectDomainStores } = await import('./project-domain-store-registry');
    const { dispatchToolCall } = await import('./mcp-dispatch');
    const { buildDomainTools } = await import('./tools-domain');
    const { buildPaneTools } = await import('./tools-panes');
    const { getContextBySession, mintToken, bindTokenToSession, releaseSession } = await import('./gate');
    const { getAgentTurnStartSequence } = await import('./agent-status');
    const { provedKickoffBriefDelivery } = await import('./mission-kickoff-direct-queue');
    const { MISSION_RUNTIME_CLOSED_MARKER } = await import('../../shared/mission-recovery-policy');
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
    await until(() => getAgentTurnStartSequence(callerSessionId) > 0 && pty.getSessionState(callerSessionId) === 'idle', 'caller finished its authentic native turn');
    const caller = structuredClone(pty.getAgentSessionInfo(callerSessionId)!);
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
    const retirements: Array<{ origin?: string; proven: boolean }> = [];
    const boundSpec = structuredClone(stores.missionPanes.findByPaneId(fresh.paneId!)!);
    if (fault === 'unknown-exit') {
      const terminate = pty.orchTerminateSession;
      termination = vi.spyOn(pty, 'orchTerminateSession').mockImplementation((sessionId, options) =>
        sessionId === fresh.sessionId && options?.origin === 'fast-lane:owned-resume-failed'
          ? Promise.resolve(false) : terminate(sessionId, options));
    } else if (fault === 'paste-abort') {
      const terminate = pty.orchTerminateSession;
      termination = vi.spyOn(pty, 'orchTerminateSession').mockImplementation(async (sessionId, options) => {
        const proven = await terminate(sessionId, options);
        if (sessionId === fresh.sessionId) retirements.push({ origin: options?.origin, proven });
        return proven;
      });
    }
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
      if (fault === 'paste-abort') expect(retirements).toEqual([{ origin: 'fast-lane:owned-resume-failed', proven: true }]);
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
        expect(pty.getAgentSessionInfo(fresh.sessionId)).not.toBeNull();
        expect(stores.missions.get(review.missionId)).toEqual(changed);
        expect(stores.missionPanes.findByPaneId(fresh.paneId!)).toEqual(boundSpec);
      }
    } finally {termination?.mockRestore(); proofCheck?.mockRestore(); state.adapter!.spawn.initialPrompt = promptDelivery;}
    expect(pty.getAgentSessionInfo(callerSessionId)).toEqual(caller);
  }, 120_000);
});
