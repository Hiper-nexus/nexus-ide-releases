import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { OwnedAgentSessionInfo } from './pty/pty-manager';
import { mintToken, bindTokenToSession, resetGateForTests, releaseSessionByToken } from './orch/gate';
import type { AuditEntry } from './jarvis/audit-log';
const deps = vi.hoisted(() => ({ grant: 'denied', scope: { version: 1 as const, identitySource: 'manifest' as const, installationId: 'i', projectId: 'p', checkoutId: 'c', rootRealPath: '' },
  manager: null as object | null, visual: vi.fn(), screenshot: vi.fn(), conversation: vi.fn((): { key: 'session_id'; id: string } | null => null),
  agents: [] as OwnedAgentSessionInfo[], tap: null as null | ((id: string, text: string) => void),
  probe: vi.fn(async (): Promise<unknown[]> => []), tapRemoved: vi.fn(), terminate: vi.fn(async () => true),
  audit: [] as AuditEntry[], recovery: null as Record<string, unknown> | null }));
vi.mock('electron', () => ({ systemPreferences: { getMediaAccessStatus: () => deps.grant } }));
vi.mock('node:child_process', () => {
  const refused = () => { throw new Error('subprocess forbidden in private runtime unit fixture'); };
  return { spawn: refused, spawnSync: refused, execSync: refused, execFileSync: refused,
    execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: async () => ({ stdout: 'Claude unit fixture only', stderr: '' }) }) };
});
vi.mock('./persistence/renderer-workspace-scope', () => ({ requireLiveRendererWorkspaceScope: () => deps.scope, getRendererWorkspaceScope: () => deps.scope,
  onRendererWorkspaceScopeChange: () => () => undefined }));
vi.mock('./orch/project-domain-store-registry', () => ({ getProjectDomainStores: () => ({ missions: { get: () => ({ id: 'm', title: 'Runtime 11111111-1111-4111-8111-111111111111', intentContract: { lane: 'standard' } }) }, handoffs: { list: () => [] } }) }));
vi.mock('./orch/mission-engine-registry', () => ({ missionEngineForScope: () => ({ snapshot: async () => ({}) }) }));
vi.mock('./pty/pty-manager', () => ({ listAgentSessions: () => deps.agents.map(agent => ({ ...agent, scope: { ...agent.scope },
  ...(agent.coordinationScope ? { coordinationScope: { ...agent.coordinationScope } } : {}) })), probePaneFootprints: () => deps.probe(), orchTerminateSession: () => deps.terminate(),
  isSessionOwnedBy: () => false, getSessionCwd: () => null, tapSessionData: (tap: (id: string, text: string) => void) => { deps.tap = tap; return deps.tapRemoved; } }));
vi.mock('./persistence/provider-session-store', () => ({ getProviderPaneSession: deps.conversation }));
vi.mock('./adapters/adapter-registry', () => ({ getAdapter: () => ({ kind: 'cli-pty' }), isAdapterInstalled: () => true, resolveAdapterBinary: () => process.env.RUNTIME_TEST_BINARY }));
vi.mock('./jarvis/audit-log', () => ({ readAuditLog: () => deps.audit }));
vi.mock('./memory/workspace-memory', () => ({ getWorkspaceMemoryStore: () => ({ recall: () => [] }) }));
vi.mock('./orch/visual-handoff-gate', () => ({ checkVisualHandoff: deps.visual }));
vi.mock('./browser/browser-artifact-store', () => ({ createScopedBrowserArtifactStore: () => ({ verifiedScreenshot: deps.screenshot }) }));
vi.mock('./orch/mission-event-emit', () => ({ getMissionEventRuntimeManager: () => deps.manager }));
import { proveRuntimeGates } from './runtime-gates';
import { RUNTIME_CHANNELS } from '../shared/runtime-gates';
import { prepareEphemeralHome } from './orch/hooks-gen';
import { startPreview, stopPreviewWithProof } from './orch/preview-server';
const roots: string[] = [];
const previews: Array<{ id: string; scope: OwnedAgentSessionInfo['scope'] }> = [];
const savedEnv = new Map<string, string | undefined>();
afterEach(async () => { resetGateForTests(); deps.agents = []; deps.tap = null; vi.unstubAllGlobals(); vi.unstubAllEnvs(); for (const [key, value] of savedEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } savedEnv.clear();
  for (const preview of previews.splice(0)) await stopPreviewWithProof(preview.id, preview.scope);
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture(options: { helloNonce?: string; helloPid?: number; homeMode?: number; startupRefused?: boolean } = {}) {
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR']) savedEnv.set(key, process.env[key]);
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-runtime-main-unit-'))); roots.push(root);
  await fs.mkdir(path.join(root, 'home'), { mode: 0o700 }); await fs.writeFile(path.join(root, 'unit-binary'), 'unit-only CLI bytes');
  if (options.homeMode !== undefined) await fs.chmod(path.join(root, 'home'), options.homeMode);
  const env = { NEXUS_PACKAGED_SMOKE: '1', NEXUS_SMOKE_RUNTIME_GATES: '1', NEXUS_USER_DATA_DIR: root, HOME: path.join(root, 'home'),
    NEXUS_SMOKE_RUNTIME_GATEWAY: 'http://127.0.0.1:45678', NEXUS_SMOKE_RUNTIME_GATEWAY_NONCE: '11111111-1111-4111-8111-111111111111', NEXUS_SMOKE_RUNTIME_PHASE: 'exercise', RUNTIME_TEST_BINARY: path.join(root, 'unit-binary') };
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.stubGlobal('fetch', async (url: string) => ({ ok: true, json: async () => url.endsWith('/runtime-recovery') ?
    { nonce: env.NEXUS_SMOKE_RUNTIME_GATEWAY_NONCE, pid: process.ppid, recovery: deps.recovery } :
    { nonce: options.helloNonce ?? env.NEXUS_SMOKE_RUNTIME_GATEWAY_NONCE, pid: options.helloPid ?? process.ppid } }));
  deps.scope.rootRealPath = path.join(root, 'workspace'); await fs.mkdir(deps.scope.rootRealPath);
  resetGateForTests(); deps.agents = []; deps.tap = null; deps.manager = null; deps.visual.mockReset(); deps.screenshot.mockReset(); deps.conversation.mockClear(); deps.probe.mockResolvedValue([]); deps.tapRemoved.mockClear();
  deps.audit = []; deps.recovery = null; deps.terminate.mockResolvedValue(true); deps.conversation.mockReturnValue(null);
  const url = 'nexus-app://bundle/index.html?nexusRuntimeGates=1', frame = { url }, session = { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() };
  const wc = Object.assign(new EventEmitter(), { mainFrame: frame, session, getURL: () => url, isDestroyed: () => false, getOSProcessId: () => 9999, send: vi.fn() });
  const win = Object.assign(new EventEmitter(), { webContents: wc }), handlers = new Map<string, (...args: any[]) => any>();
  const ipc = Object.assign(new EventEmitter(), { handle: (channel: string, fn: (...args: any[]) => any) => handlers.set(channel, fn), removeHandler: (channel: string) => handlers.delete(channel) });
  const controller = new AbortController(), physical = vi.fn();
  const flight = proveRuntimeGates(win as never, { ipc: ipc as never, userData: root, workspacePath: deps.scope.rootRealPath, appVersion: '0.76.192', smokeTest: true,
    packaged: true, signal: controller.signal, requestPhysicalShutdown: physical });
  const rejected = flight.catch(error => error);
  if (options.startupRefused) await rejected;
  else await vi.waitFor(() => expect(wc.send).toHaveBeenCalledWith(RUNTIME_CHANNELS.run, expect.any(Object)));
  const nonce = wc.send.mock.calls.find(c => c[0] === RUNTIME_CHANNELS.run)?.[1].nonce;
  return { root, frame, wc, ipc, controller, physical, flight, rejected, request: (event: object, raw: object) => handlers.get(RUNTIME_CHANNELS.request)!(event, { nonce, ...raw }), nonce };
}

async function consentProfile(f: Awaited<ReturnType<typeof fixture>>, token: string, overrides: Record<string, unknown> = {}) {
  const home = prepareEphemeralHome(token, {}, { adapterId: 'claude', userDataPath: f.root,
    coordinationScope: { ...deps.scope }, effectiveEnv: { ...process.env }, ...overrides });
  return JSON.parse(await fs.readFile(path.join(home.dir, '.claude.json'), 'utf8'));
}

it('F-1104: the activated owned fixture seeds normal key consent in each disposable leader/worker/recovery overlay', async () => {
  const f = await fixture();
  const nativePath = path.join(f.root, 'home', '.claude.json');
  const nativeBytes = JSON.stringify({ customApiKeyResponses: { approved: ['native-approved'], rejected: ['native-rejected'] } });
  await fs.writeFile(nativePath, nativeBytes);
  try {
    for (const token of ['owned-leader-one', 'owned-worker-one', 'owned-recovery-one']) {
      const profile = await consentProfile(f, token, { inheritNativeProfile: true });
      expect(profile.customApiKeyResponses).toEqual({ approved: ['11-8111-111111111111'], rejected: [] });
      expect(JSON.stringify(profile)).not.toContain('rt-11111111-1111-4111-8111-111111111111');
    }
    expect(await fs.readFile(nativePath, 'utf8')).toBe(nativeBytes);
  } finally { f.controller.abort(); await f.rejected; }
});

it.each(['foreign-key', 'same-tail-key', 'foreign-token', 'foreign-gateway', 'foreign-nonce', 'foreign-scope', 'foreign-profile', 'unsafe-profile', 'foreign-home', 'missing-spawn-env', 'replaced-frame'] as const)(
  'F-1104: active runtime never approves a %s overlay', async changed => {
    const f = await fixture();
    const effectiveEnv = { ...process.env };
    const overrides: Record<string, unknown> = { effectiveEnv };
    let restoreHome: (() => void) | undefined;
    try {
      if (changed === 'foreign-key') effectiveEnv.ANTHROPIC_API_KEY = 'sk-ant-api03-unrelated-fixture';
      if (changed === 'same-tail-key') effectiveEnv.ANTHROPIC_API_KEY = 'foreign-11111111-1111-4111-8111-111111111111';
      if (changed === 'foreign-token') effectiveEnv.ANTHROPIC_AUTH_TOKEN = 'sk-ant-api03-unrelated-fixture';
      if (changed === 'foreign-gateway') effectiveEnv.ANTHROPIC_BASE_URL = 'http://127.0.0.1:45679';
      if (changed === 'foreign-nonce') effectiveEnv.NEXUS_SMOKE_RUNTIME_GATEWAY_NONCE = '22222222-2222-4222-8222-222222222222';
      if (changed === 'foreign-scope') overrides.coordinationScope = { ...deps.scope, checkoutId: 'other' };
      if (changed === 'foreign-profile') overrides.userDataPath = path.join(f.root, 'other-profile');
      if (changed === 'unsafe-profile') await fs.chmod(path.join(f.root, 'home'), 0o755);
      if (changed === 'foreign-home') {
        const foreignHome = path.join(f.root, 'foreign-home'); await fs.mkdir(foreignHome, { mode: 0o700 });
        const spy = vi.spyOn(os, 'homedir').mockReturnValue(foreignHome); restoreHome = () => spy.mockRestore();
      }
      if (changed === 'missing-spawn-env') overrides.effectiveEnv = undefined;
      if (changed === 'replaced-frame') f.wc.mainFrame = { ...f.frame };
      expect((await consentProfile(f, 'foreign-home-one', overrides)).customApiKeyResponses).toBeUndefined();
    } finally { restoreHome?.(); f.controller.abort(); await f.rejected; }
  });

it('F-1104: env spoofing after runtime revocation cannot approve another bootstrap', async () => {
  const f = await fixture(); f.controller.abort();
  expect((await consentProfile(f, 'revoked-home-one')).customApiKeyResponses).toBeUndefined();
  await f.rejected;
  expect((await consentProfile(f, 'unarmed-home-one')).customApiKeyResponses).toBeUndefined();
});

it.each([{ helloNonce: '22222222-2222-4222-8222-222222222222' }, { helloPid: process.ppid + 1 }, { homeMode: 0o755 }])(
  'F-1104: refused private startup never arms consent (%j)', async refused => {
    const f = await fixture({ ...refused, startupRefused: true });
    expect(await f.rejected).toBeInstanceOf(Error);
    expect(f.wc.send).not.toHaveBeenCalled();
    expect((await consentProfile(f, 'refused-home-one')).customApiKeyResponses).toBeUndefined();
  });
it('rejects foreign frame/nonce and a missing OS grant without prompting or arming capture', async () => {
  const f = await fixture(); const event = { sender: f.wc, senderFrame: f.frame };
  try {
    await expect(f.request({ ...event, senderFrame: {} }, { operation: 'voice-arm' })).rejects.toThrow(/sender/);
    await expect(f.request(event, { operation: 'voice-arm', nonce: '22222222-2222-4222-8222-222222222222' })).rejects.toThrow(/refused/);
    await expect(f.request(event, { operation: 'voice-arm' })).rejects.toThrow(/external microphone permission blocker: denied/);
    expect(f.wc.session.setPermissionRequestHandler).not.toHaveBeenCalled();
  } finally { f.controller.abort(); await f.rejected; }
  expect(f.physical).toHaveBeenCalledOnce(); expect(deps.tapRemoved).toHaveBeenCalledOnce();
});
it('arms physical FAIL immediately during a pending Main observation, drains it and refuses its late result', async () => {
  const f = await fixture(); let release!: (v: unknown[]) => void;
  deps.probe.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const pending = f.request({ sender: f.wc, senderFrame: f.frame }, { operation: 'observe', missionId: 'm' });
  const rejected = pending.catch((e: Error) => e);
  await vi.waitFor(() => expect(deps.probe).toHaveBeenCalled()); f.controller.abort();
  expect(f.physical).toHaveBeenCalledOnce(); release([]);
  expect(await rejected).toBeInstanceOf(Error); expect(await f.rejected).toBeInstanceOf(Error);
  expect(deps.tapRemoved).toHaveBeenCalledOnce();
});

async function scopedAgent(f: Awaited<ReturnType<typeof fixture>>) {
  const executionRoot = path.join(f.root, 'mission-execution'); await fs.mkdir(executionRoot);
  const executionScope = { ...deps.scope, rootRealPath: executionRoot };
  const ctx = mintToken({ label: 'private runtime current leader', role: 'orchestrator', missionId: 'm', scope: { ...deps.scope },
    executionScope, readOnly: false, allowedTools: null, allowedSkills: null });
  bindTokenToSession(ctx.token, 'owned-session');
  const agent: OwnedAgentSessionInfo = { sessionId: 'owned-session', paneId: 'owned-pane', adapterId: 'claude',
    scope: executionScope, coordinationScope: { ...deps.scope }, cwd: executionRoot, source: 'pending',
    role: 'orchestrator', missionId: 'm', readOnly: false, allowedTools: null, allowedSkills: null };
  deps.agents = [agent]; deps.probe.mockResolvedValue([{ sessionId: 'owned-session', rootPid: 1234 }]);
  return { ctx, agent };
}
it('observes and looks up the exact current mission process using its coordination scope across an execution worktree', async () => {
  const f = await fixture(); await scopedAgent(f); const event = { sender: f.wc, senderFrame: f.frame };
  try {
    const observed = await f.request(event, { operation: 'observe', missionId: 'm' });
    expect(observed.agents).toEqual([expect.objectContaining({ sessionId: 'owned-session', role: 'orchestrator', pid: 1234 })]);
    await expect(f.request(event, { operation: 'session', sessionId: 'owned-session' })).resolves.toMatchObject({ sessionId: 'owned-session', pid: 1234 });
  } finally { f.controller.abort(); await f.rejected; }
});
it('records actual scoped output from the current execution worktree without treating coordination as its cwd', async () => {
  const f = await fixture(); await scopedAgent(f); const event = { sender: f.wc, senderFrame: f.frame };
  try {
    deps.tap!('owned-session', 'RT_RESUME_OK_11111111-1111-4111-8111-111111111111');
    expect((await f.request(event, { operation: 'observe', missionId: 'm' })).resumedOutput).toEqual(['owned-session']);
  } finally { f.controller.abort(); await f.rejected; }
});
it.each(['foreign-coordination', 'stale-execution', 'role-mismatch', 'mission-mismatch', 'session-mismatch', 'revoked'] as const)(
  'never observes/looks up/taps a %s binding even if its physical session still exists', async change => {
    const f = await fixture(); const { ctx, agent } = await scopedAgent(f); const event = { sender: f.wc, senderFrame: f.frame };
    try {
      if (change === 'foreign-coordination') agent.coordinationScope = { ...deps.scope, checkoutId: 'foreign' };
      if (change === 'stale-execution') ctx.executionScope = { ...agent.scope, rootRealPath: path.join(f.root, 'replacement') };
      if (change === 'role-mismatch') ctx.role = 'worker';
      if (change === 'mission-mismatch') ctx.missionId = 'other';
      if (change === 'session-mismatch') ctx.sessionId = 'replacement-session';
      if (change === 'revoked') releaseSessionByToken(ctx.token);
      deps.tap!('owned-session', 'RT_RESUME_OK_11111111-1111-4111-8111-111111111111');
      const observed = await f.request(event, { operation: 'observe', missionId: 'm' });
      expect(observed.agents).toEqual([]); expect(observed.resumedOutput).toEqual([]);
      await expect(f.request(event, { operation: 'session', sessionId: 'owned-session' })).rejects.toThrow('foreign runtime session');
    } finally { f.controller.abort(); await f.rejected; }
  });
it('a previously looked-up mission session does not bypass output authority after revocation', async () => {
  const f = await fixture(); const { ctx } = await scopedAgent(f); const event = { sender: f.wc, senderFrame: f.frame };
  try {
    await f.request(event, { operation: 'session', sessionId: 'owned-session' }); releaseSessionByToken(ctx.token);
    deps.tap!('owned-session', 'RT_RESUME_OK_11111111-1111-4111-8111-111111111111');
    expect((await f.request(event, { operation: 'observe', missionId: 'm' })).resumedOutput).toEqual([]);
  } finally { f.controller.abort(); await f.rejected; }
});
it('revocation during a physical PID lookup rejects the late result and cannot arm output', async () => {
  const f = await fixture(); const { ctx } = await scopedAgent(f); const event = { sender: f.wc, senderFrame: f.frame };
  let release!: (value: unknown[]) => void;
  deps.probe.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  try {
    const lookup = f.request(event, { operation: 'session', sessionId: 'owned-session' });
    const outcome = lookup.catch((error: Error) => error);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    releaseSessionByToken(ctx.token); release([{ sessionId: 'owned-session', rootPid: 1234 }]);
    expect(await outcome).toBeInstanceOf(Error);
    deps.tap!('owned-session', 'RT_RESUME_OK_11111111-1111-4111-8111-111111111111');
    expect((await f.request(event, { operation: 'observe', missionId: 'm' })).resumedOutput).toEqual([]);
  } finally { f.controller.abort(); await f.rejected; }
});

it('a deferred PID lookup accepts a fresh physical clone with the same full binding', async () => {
  const f = await fixture(); await scopedAgent(f); const event = { sender: f.wc, senderFrame: f.frame };
  let release!: (value: unknown[]) => void;
  deps.probe.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  try {
    const lookup = f.request(event, { operation: 'session', sessionId: 'owned-session' });
    const outcome = lookup.catch((error: Error) => error);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    deps.agents = deps.agents.map(agent => ({ ...agent, scope: { ...agent.scope } }));
    release([{ sessionId: 'owned-session', rootPid: 1234 }]);
    expect(await outcome).toMatchObject({ sessionId: 'owned-session', pid: 1234 });
  } finally { f.controller.abort(); await f.rejected; }
});

const visualArtifact = { id: 'artifact-one', missionId: 'm', url: 'http://127.0.0.1:45678/runtime-page',
  path: '/private/unit-artifact.png', sha256: 'a'.repeat(64) };
async function visualAgent(f: Awaited<ReturnType<typeof fixture>>) {
  const result = await scopedAgent(f);
  const dir = path.join(result.agent.scope.rootRealPath, 'runtime-visual-11111111-1111-4111-8111-111111111111');
  await fs.mkdir(dir); await fs.writeFile(path.join(dir, 'index.html'), 'RT_VISUAL_11111111-1111-4111-8111-111111111111');
  const preview = await startPreview(dir, result.agent.scope);
  previews.push({ id: preview.id, scope: result.agent.scope });
  visualArtifact.url = preview.url;
  result.ctx.visualTask = { id: 'assignment-one' } as NonNullable<typeof result.ctx.visualTask>;
  deps.manager = { open: () => ({ db: { prepare: () => ({ all: () => [] }) } }) };
  deps.visual.mockResolvedValue({ required: true, verified: true, artifactId: visualArtifact.id });
  deps.screenshot.mockResolvedValue(visualArtifact);
  return result;
}
it('F-1110: verifies the current execution registered preview URL rather than the inference gateway', async () => {
  const f = await fixture(); const { ctx, agent } = await visualAgent(f); const event = { sender: f.wc, senderFrame: f.frame };
  const dir = path.join(agent.scope.rootRealPath, 'runtime-visual-11111111-1111-4111-8111-111111111111');
  await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, 'index.html'), 'RT_VISUAL_11111111-1111-4111-8111-111111111111');
  const preview = await startPreview(dir, agent.scope);
  deps.screenshot.mockResolvedValue({ ...visualArtifact, url: preview.url });
  try {
    expect((await f.request(event, { operation: 'observe', missionId: 'm' })).agents[0].visual).toEqual({ assignmentId: ctx.visualTask!.id, artifactId: visualArtifact.id, sha256: visualArtifact.sha256 });
    deps.screenshot.mockResolvedValue({ ...visualArtifact, url: 'http://127.0.0.1:45678/runtime-page' });
    await expect(f.request(event, { operation: 'observe', missionId: 'm' })).rejects.toThrow('visual artifact provenance differs');
  } finally { await stopPreviewWithProof(preview.id, agent.scope); f.controller.abort(); await f.rejected; }
});
it.each(['wrong-mission', 'wrong-directory', 'wrong-root', 'wrong-checkout', 'wrong-assignment', 'stopped-preview'] as const)('F-1110: refuses a %s capture even with a valid native artifact', async variant => {
  const f = await fixture(); const { agent, ctx } = await visualAgent(f); const event = { sender: f.wc, senderFrame: f.frame };
  const root = variant === 'wrong-root' ? f.root : agent.scope.rootRealPath;
  const dir = path.join(root, variant === 'wrong-directory' ? 'foreign-visual' : 'runtime-visual-11111111-1111-4111-8111-111111111111');
  await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, 'index.html'), 'unit');
  const previewScope = variant === 'wrong-checkout' ? { ...agent.scope, checkoutId: 'foreign' } : agent.scope;
  const preview = await startPreview(dir, previewScope);
  deps.screenshot.mockResolvedValue({ ...visualArtifact, missionId: variant === 'wrong-mission' ? 'foreign' : 'm', url: preview.url });
  if (variant === 'wrong-assignment') deps.screenshot.mockImplementationOnce(async () => {
    ctx.visualTask = { id: 'substituted-assignment' } as NonNullable<typeof ctx.visualTask>;
    return { ...visualArtifact, url: preview.url };
  });
  if (variant === 'stopped-preview') await stopPreviewWithProof(preview.id, previewScope);
  try { await expect(f.request(event, { operation: 'observe', missionId: 'm' })).rejects.toThrow(variant === 'wrong-assignment' ? 'runtime agent binding changed' : 'visual artifact provenance differs'); }
  finally { if (variant !== 'stopped-preview') await stopPreviewWithProof(preview.id, previewScope); f.controller.abort(); await f.rejected; }
});
it.each(['verification', 'screenshot'] as const)('revocation during visual %s never returns stale agent/PID/conversation', async stage => {
  const f = await fixture(); const { ctx } = await visualAgent(f); const event = { sender: f.wc, senderFrame: f.frame };
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const port = stage === 'verification' ? deps.visual : deps.screenshot;
  port.mockImplementationOnce(async () => { await hold; return stage === 'verification' ?
    { required: true, verified: true, artifactId: visualArtifact.id } : visualArtifact; });
  try {
    const observation = f.request(event, { operation: 'observe', missionId: 'm' });
    const outcome = observation.catch((error: Error) => error);
    await vi.waitFor(() => expect(port).toHaveBeenCalled());
    releaseSessionByToken(ctx.token); release();
    expect(await outcome).toMatchObject({ message: 'runtime agent binding changed' });
    expect(deps.conversation).not.toHaveBeenCalled();
    if (stage === 'verification') expect(deps.screenshot).not.toHaveBeenCalled();
  } finally { f.controller.abort(); await f.rejected; }
});
it('unchanged current visual binding survives cloned metadata across deferred screenshot', async () => {
  const f = await fixture(); await visualAgent(f); const event = { sender: f.wc, senderFrame: f.frame };
  let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
  deps.screenshot.mockImplementationOnce(async () => { await hold; return visualArtifact; });
  try {
    const observation = f.request(event, { operation: 'observe', missionId: 'm' });
    await vi.waitFor(() => expect(deps.screenshot).toHaveBeenCalled());
    deps.agents = deps.agents.map(agent => ({ ...agent, scope: { ...agent.scope } })); release();
    expect((await observation).agents).toEqual([expect.objectContaining({ sessionId: 'owned-session', pid: 1234,
      visual: { assignmentId: 'assignment-one', artifactId: visualArtifact.id, sha256: visualArtifact.sha256 } })]);
  } finally { f.controller.abort(); await f.rejected; }
});

it('final observation rechecks an already-collected agent while another visual read is pending', async () => {
  const f = await fixture(); const { ctx, agent } = await visualAgent(f); const event = { sender: f.wc, senderFrame: f.frame };
  const second = mintToken({ label: 'second private worker', role: 'worker', missionId: 'm', scope: { ...deps.scope },
    executionScope: { ...agent.scope }, readOnly: false, allowedTools: null, allowedSkills: null });
  bindTokenToSession(second.token, 'second-session'); second.visualTask = { id: 'assignment-two' } as NonNullable<typeof second.visualTask>;
  deps.agents.push({ ...agent, sessionId: 'second-session', paneId: 'second-pane', role: 'worker' });
  let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
  deps.screenshot.mockImplementationOnce(async () => visualArtifact).mockImplementationOnce(async () => { await hold; return { ...visualArtifact, id: 'artifact-two' }; });
  try {
    const outcome = f.request(event, { operation: 'observe', missionId: 'm' }).catch((error: Error) => error);
    await vi.waitFor(() => { expect(deps.screenshot).toHaveBeenCalledTimes(2); expect(deps.conversation).toHaveBeenCalledTimes(1); });
    releaseSessionByToken(ctx.token); release();
    expect(await outcome).toMatchObject({ message: 'runtime agent binding changed' });
  } finally { f.controller.abort(); await f.rejected; }
});

async function recoveredWorkerFixture(priorAudit = false) {
  const f = await fixture(), { ctx, agent } = await scopedAgent(f), event = { sender: f.wc, senderFrame: f.frame };
  ctx.role = 'worker'; agent.role = 'worker'; agent.model = 'sealed-model'; agent.accountId = 'account-a'; agent.effort = 'high';
  ctx.visualTask = { id: 'original-assignment', since: 1 };
  deps.visual.mockResolvedValue({ required: true, verified: false, reason: 'unit native capture pending' });
  deps.conversation.mockReturnValue({ key: 'session_id', id: 'exact-native-conversation' });
  const chief = mintToken({ label: 'Runtime chief', role: 'orchestrator', missionId: 'm', scope: { ...deps.scope },
    executionScope: { ...agent.scope }, readOnly: false, allowedTools: null, allowedSkills: null });
  bindTokenToSession(chief.token, 'chief-session');
  const chiefAgent: OwnedAgentSessionInfo = { ...agent, sessionId: 'chief-session', paneId: 'chief-pane', role: 'orchestrator' };
  deps.agents.push(chiefAgent); deps.probe.mockResolvedValue([{ sessionId: agent.sessionId, rootPid: 1234 }, { sessionId: chief.sessionId, rootPid: 3333 }]);
  const audit = { timestamp: new Date().toISOString(), project_id: 'p', checkout_id: 'c', mission_id: 'm', duration_ms: 1, user_authorized: false,
    session: 'chief-session', source: 'http-mcp' as const, tool: 'nexus_pane_spawn', args: { resume: 'owned-pane' }, result: 'ok' as const, invocation_id: 'resume-invocation' };
  if (priorAudit) deps.audit.push(audit);
  await f.request(event, { operation: 'observe', missionId: 'm' });
  await f.request(event, { operation: 'terminate', sessionId: agent.sessionId });
  releaseSessionByToken(ctx.token);
  const next = mintToken({ label: 'Runtime writer', role: 'worker', missionId: 'm', scope: { ...deps.scope },
    executionScope: { ...agent.scope }, readOnly: false, allowedTools: null, allowedSkills: null });
  bindTokenToSession(next.token, 'new-session'); next.visualTask = ctx.visualTask;
  const worker: OwnedAgentSessionInfo = { ...agent, paneId: 'new-pane', sessionId: 'new-session' };
  deps.agents = [chiefAgent, worker]; deps.probe.mockResolvedValue([{ sessionId: 'new-session', rootPid: 2345 }, { sessionId: 'chief-session', rootPid: 3333 }]);
  if (!priorAudit) deps.audit.push(audit);
  deps.recovery = { fromPaneId: 'owned-pane', fromSessionId: 'owned-session', paneId: 'new-pane', sessionId: 'new-session', requestId: 'normal-spawn-result' };
  return { f, event, next, worker };
}
it('F-1111: accepts the actual new result identity only with the exact prior worker, native context and own fresh chief audit', async () => {
  const { f, event } = await recoveredWorkerFixture();
  try { expect((await f.request(event, { operation: 'observe', missionId: 'm' })).recovery).toEqual({
    fromPaneId: 'owned-pane', fromSessionId: 'owned-session', paneId: 'new-pane', sessionId: 'new-session', requestId: 'normal-spawn-result',
    chiefSessionId: 'chief-session', invocationId: 'resume-invocation' }); }
  finally { f.controller.abort(); await f.rejected; }
});
it.each(['foreign-result', 'no-audit', 'prior-audit', 'foreign-chief', 'foreign-resume', 'account', 'model', 'effort', 'assignment', 'full-root', 'ambiguous', 'native-context'] as const)(
  'F-1111: rejects %s recovery provenance', async variant => {
    const { f, event, next, worker } = await recoveredWorkerFixture(variant === 'prior-audit');
    try {
      if (variant === 'foreign-result') deps.recovery!.sessionId = 'unrelated-session';
      if (variant === 'no-audit') deps.audit = [];
      if (variant === 'foreign-chief') deps.audit[0] = { ...deps.audit[0], session: 'unrelated-chief' };
      if (variant === 'foreign-resume') deps.audit[0].args.resume = 'another-pane';
      if (variant === 'account') worker.accountId = 'account-b';
      if (variant === 'model') worker.model = 'another-model';
      if (variant === 'effort') worker.effort = 'low';
      if (variant === 'assignment') next.visualTask = { id: 'foreign-assignment', since: 1 };
      if (variant === 'full-root') { worker.scope = { ...worker.scope, rootRealPath: path.join(f.root, 'another-execution') }; next.executionScope = worker.scope; }
      if (variant === 'native-context') deps.conversation.mockReturnValue({ key: 'session_id', id: 'foreign-native-conversation' });
      if (variant === 'ambiguous') {
        const competing = mintToken({ label: 'competing writer', role: 'worker', missionId: 'm', scope: { ...deps.scope }, executionScope: { ...worker.scope },
          readOnly: false, allowedTools: null, allowedSkills: null });
        bindTokenToSession(competing.token, 'competing-session'); competing.visualTask = next.visualTask;
        deps.agents.push({ ...worker, paneId: 'competing-pane', sessionId: 'competing-session' });
        deps.probe.mockResolvedValue([{ sessionId: 'new-session', rootPid: 2345 }, { sessionId: 'competing-session', rootPid: 3456 }, { sessionId: 'chief-session', rootPid: 3333 }]);
      }
      await expect(f.request(event, { operation: 'observe', missionId: 'm' })).rejects.toThrow(/recovery/);
    } finally { f.controller.abort(); await f.rejected; }
  });
it.each(['nonce', 'parent-pid'] as const)('F-1111: rejects a recovery result from another %s', async changed => {
  const { f, event } = await recoveredWorkerFixture();
  vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ nonce: changed === 'nonce' ? '22222222-2222-4222-8222-222222222222' : '11111111-1111-4111-8111-111111111111',
    pid: changed === 'parent-pid' ? process.ppid + 1 : process.ppid, recovery: deps.recovery }) }));
  try { await expect(f.request(event, { operation: 'observe', missionId: 'm' })).rejects.toThrow('recovery gateway ownership differs'); }
  finally { f.controller.abort(); await f.rejected; }
});
