import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
const deps = vi.hoisted(() => ({ grant: 'denied', scope: { installationId: 'i', projectId: 'p', checkoutId: 'c', rootRealPath: '' },
  probe: vi.fn(async (): Promise<unknown[]> => []), tapRemoved: vi.fn() }));
vi.mock('electron', () => ({ systemPreferences: { getMediaAccessStatus: () => deps.grant } }));
vi.mock('node:child_process', () => ({ execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: async () => ({ stdout: 'Claude unit fixture only', stderr: '' }) }) }));
vi.mock('./persistence/renderer-workspace-scope', () => ({ requireLiveRendererWorkspaceScope: () => deps.scope, getRendererWorkspaceScope: () => deps.scope }));
vi.mock('./orch/project-domain-store-registry', () => ({ getProjectDomainStores: () => ({ missions: { get: () => ({ id: 'm', title: 'Runtime 11111111-1111-4111-8111-111111111111' }) } }) }));
vi.mock('./orch/mission-engine-registry', () => ({ missionEngineForScope: () => ({ snapshot: async () => ({}) }) }));
vi.mock('./pty/pty-manager', () => ({ listAgentSessions: () => [], probePaneFootprints: () => deps.probe(), orchTerminateSession: vi.fn(),
  isSessionOwnedBy: () => false, getSessionCwd: () => null, tapSessionData: () => deps.tapRemoved }));
vi.mock('./persistence/provider-session-store', () => ({ getProviderPaneSession: () => null }));
vi.mock('./adapters/adapter-registry', () => ({ getAdapter: () => ({ kind: 'cli-pty' }), isAdapterInstalled: () => true, resolveAdapterBinary: () => process.env.RUNTIME_TEST_BINARY }));
vi.mock('./jarvis/audit-log', () => ({ readAuditLog: () => [] }));
vi.mock('./memory/workspace-memory', () => ({ getWorkspaceMemoryStore: () => ({ recall: () => [] }) }));
vi.mock('./orch/gate', () => ({ getContextBySession: () => null }));
vi.mock('./orch/visual-handoff-gate', () => ({ checkVisualHandoff: vi.fn() }));
vi.mock('./browser/browser-artifact-store', () => ({ createScopedBrowserArtifactStore: vi.fn() }));
vi.mock('./orch/mission-event-emit', () => ({ getMissionEventRuntimeManager: () => null }));
import { proveRuntimeGates } from './runtime-gates';
import { RUNTIME_CHANNELS } from '../shared/runtime-gates';
const roots: string[] = [];
const savedEnv = new Map<string, string | undefined>();
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); for (const [key, value] of savedEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } savedEnv.clear();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR']) savedEnv.set(key, process.env[key]);
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-runtime-main-unit-'))); roots.push(root);
  await fs.mkdir(path.join(root, 'home'), { mode: 0o700 }); await fs.writeFile(path.join(root, 'unit-binary'), 'unit-only CLI bytes');
  const env = { NEXUS_PACKAGED_SMOKE: '1', NEXUS_SMOKE_RUNTIME_GATES: '1', NEXUS_USER_DATA_DIR: root, HOME: path.join(root, 'home'),
    NEXUS_SMOKE_RUNTIME_GATEWAY: 'http://127.0.0.1:45678', NEXUS_SMOKE_RUNTIME_GATEWAY_NONCE: '11111111-1111-4111-8111-111111111111', NEXUS_SMOKE_RUNTIME_PHASE: 'exercise', RUNTIME_TEST_BINARY: path.join(root, 'unit-binary') };
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.stubGlobal('fetch', async () => ({ json: async () => ({ nonce: env.NEXUS_SMOKE_RUNTIME_GATEWAY_NONCE, pid: process.ppid }) }));
  deps.scope.rootRealPath = path.join(root, 'workspace'); deps.probe.mockResolvedValue([]); deps.tapRemoved.mockClear();
  const url = 'nexus-app://bundle/index.html?nexusRuntimeGates=1', frame = { url }, session = { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() };
  const wc = Object.assign(new EventEmitter(), { mainFrame: frame, session, getURL: () => url, isDestroyed: () => false, getOSProcessId: () => 9999, send: vi.fn() });
  const win = Object.assign(new EventEmitter(), { webContents: wc }), handlers = new Map<string, (...args: any[]) => any>();
  const ipc = Object.assign(new EventEmitter(), { handle: (channel: string, fn: (...args: any[]) => any) => handlers.set(channel, fn), removeHandler: (channel: string) => handlers.delete(channel) });
  const controller = new AbortController(), physical = vi.fn();
  const flight = proveRuntimeGates(win as never, { ipc: ipc as never, userData: root, workspacePath: deps.scope.rootRealPath, appVersion: '0.76.192', smokeTest: true,
    packaged: true, signal: controller.signal, requestPhysicalShutdown: physical });
  const rejected = flight.catch(error => error);
  await vi.waitFor(() => expect(wc.send).toHaveBeenCalledWith(RUNTIME_CHANNELS.run, expect.any(Object)));
  const nonce = wc.send.mock.calls.find(c => c[0] === RUNTIME_CHANNELS.run)![1].nonce;
  return { root, frame, wc, ipc, controller, physical, flight, rejected, request: (event: object, raw: object) => handlers.get(RUNTIME_CHANNELS.request)!(event, { nonce, ...raw }), nonce };
}
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
