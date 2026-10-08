/** @vitest-environment jsdom */
// Real license/admission/pool/restore/layout/boundary owners; fake only OS/IPC and terminal presentation.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CliPtyAdapter } from '../../shared/adapter-types';
import type { PaneModel } from '../../shared/types';
import type { BoundSpawnAuthority } from '../orch/spawn-authority';
import type { LicenseSeal } from '../license-account-state';
import { LICENSE_NOW, licenseFixture, publicKeyPem } from '../../test/license-fixture';

const bridge = vi.hoisted(() => ({ access: null as ReturnType<typeof import('../license-access').createLicenseAccess> | null }));
vi.mock('../license-access', async importOriginal => {
  const original = await importOriginal<typeof import('../license-access')>();
  return { ...original,
    requireAccess: (capability: 'use' | 'cloudSync') => bridge.access!.requireAccess(capability),
    maxAgents: () => bridge.access!.maxAgents(),
    onAccessChanged: (listener: (state: import('../../shared/billing-types').LicenseState) => void) => bridge.access!.onAccessChanged(listener),
  };
});
vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));
vi.mock('../path-resolver', () => ({
  resolveSpawnBinary: () => ({ binPath: '/mock/license-cli', effectivePath: '/mock', source: 'absolute' }),
  revalidateExecutable: () => true,
  realUserHome: () => '/mock/home',
  // F-992: o spawn lê a versão já sondada só para avisar; um binário que não é
  // CLI conhecida dá null no path-resolver real — mesmo valor aqui.
  cachedCliBinaryVersion: () => null,
}));
vi.mock('./persistent-session', () => ({
  planPersistentAgentSpawn: (spec: { file: string; args: string[] }) => ({ ...spec, mode: 'direct' }),
  getPersistentSessionBackend: () => ({ killSessionSync: vi.fn() }),
}));
vi.mock('../../renderer/terminal/terminal-host', () => ({
  holdSpawnUntilApproved: vi.fn(), releaseHeldSpawns: vi.fn(), discardPaneSpawnState: vi.fn(),
  markResumeOnSpawn: vi.fn(), unlockRetiredMissionPane: vi.fn(),
}));
vi.mock('../../renderer/components/settings/AccountSection', () => ({ AccountSection: () => <button className="settings-btn--primary">Minha conta</button> }));
vi.mock('../../renderer/components/UpdateModal', () => ({ UpdateNotifier: () => null }));

import { createLicenseAccess } from '../license-access';
import { licensedAgentCount } from '../license-enforcement';
import { setPtyHost, setWarmAgentSpawner, spawnAgentSession, getSessionState, orchTerminateSession, warmPool } from './pty-manager';
import { registerWarmAgentSpawner } from './warm-agent-spawner';
import { AccessBoundary } from '../../renderer/components/AccessBoundary';
import { useLayoutStore } from '../../renderer/state/layout-store';
import { useSessionStateStore } from '../../renderer/state/session-state-store';
import { buildGridTree } from '../../renderer/lib/split-tree';
import { gateRestoredAgents, resetRestoredAgentsGate } from '../../renderer/orch/restore-agents-gate';
import { holdSpawnUntilApproved, releaseHeldSpawns } from '../../renderer/terminal/terminal-host';
import { setActiveWorkspacePath } from '../../renderer/state/active-workspace';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let dir: string, now: number, root: Root | undefined, host: HTMLDivElement;
let children: string[], closed: Promise<unknown>[];
let accessDeps: Parameters<typeof createLicenseAccess>[0];
const req = { kind: 'cli-agent' as const, cols: 80, rows: 24 };
const adapter: CliPtyAdapter = {
  kind: 'cli-pty', id: 'license-cli', label: 'License CLI', version: '1', icon: 'terminal', bin: 'license-cli',
  detect: 'license-cli --version', install: { method: 'npm', command: 'license-cli' }, auth: { method: 'none' },
  spawn: { interactive: ['license-cli'], headless: ['license-cli'], ptyRequired: true, resumeArgs: [], extraArgs: [] },
  env: { static: {}, passthrough: [], ephemeralHome: false }, models: { flag: '--model', list: ['default'], default: 'default' },
  promptInjection: { method: 'arg', trailingNewline: true, bracketedPaste: false },
  stateParsing: { idle: { type: 'timeout', ms: 500 }, shellIntegration: false, exitCodes: {} },
  quirks: { altScreen: false, requiresNoAutoUpdate: false, mcpAutoload: false, nexusMcp: 'none' },
  control: { permission: { safe: [], yolo: [], modes: {}, default: '' } },
};
function authority(): BoundSpawnAuthority {
  return { source: 'direct-user', context: null, cwd: dir,
    scope: { version: 1, installationId: 'test', projectId: 'test', checkoutId: 'test', identitySource: 'provisional', rootRealPath: dir } };
}
function spawn(paneId?: string, bound: BoundSpawnAuthority = authority()) {
  const child = spawnAgentSession(null, { ...req, ...(paneId ? { paneId } : {}) }, adapter, {}, bound);
  children.push(child.sessionId);
  return child;
}
function present(pane: PaneModel, sessionId?: string) {
  useLayoutStore.setState({ root: buildGridTree([pane]), focusedPaneId: pane.id });
  useSessionStateStore.getState().setPaneState(pane.id, 'idle');
  function TerminalPresentation() {
    const panes = useLayoutStore(state => state.root);
    const stillPresent = panes.kind === 'leaf' && panes.pane.id === pane.id;
    return stillPresent ? <TerminalLifetime /> : null;
  }
  function TerminalLifetime() {
    useEffect(() => () => { if (sessionId) closed.push(orchTerminateSession(sessionId)); }, []);
    return <input aria-label="Terminal preservado" defaultValue="scrollback" />;
  }
  root = createRoot(host);
  return act(async () => root!.render(<AccessBoundary><TerminalPresentation /></AccessBoundary>));
}
beforeEach(() => {
  now = LICENSE_NOW;
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'license-lifecycle-')));
  let seal: LicenseSeal = { clockFloor: now, latestIat: 0, revokedAt: null, needsOnlineValidation: false };
  accessDeps = { licensePath: path.join(dir, 'license.json'), publicKeyPem: () => publicKeyPem,
    issuer: () => 'https://api.nexuside.app', accountId: () => 'account-a', now: () => now, monotonicNow: () => 0,
    readSeal: () => seal, writeSeal: (value: LicenseSeal) => { seal = value; return { ok: true }; } };
  bridge.access = createLicenseAccess(accessDeps);
  bridge.access.applyLicenseToken(licenseFixture({ access: 'pro' }));
  Object.defineProperty(window, 'nexus', { configurable: true, value: {
    billing: { get: async () => bridge.access!.getAccessState(), onChanged: (listener: () => void) => bridge.access!.onAccessChanged(listener) },
    settings: { orchGet: vi.fn(async () => ({ agentRestorePolicy: 'resume' })) },
    orch: { canRestoreMissionPane: vi.fn(async () => ({ ok: true, authorized: false })) },
  } });
  host = document.createElement('div'); document.body.append(host);
  children = []; closed = [];
  setActiveWorkspacePath(dir);
  setPtyHost({ spawn(_spec, handlers) {
    let exited = false;
    return { write: vi.fn(), resize: vi.fn(), kill: vi.fn(), terminate: vi.fn(async () => {
      if (!exited) { exited = true; handlers.onExit(0, 15); }
      return { ok: true, rootExited: true, descendantsExited: true };
    }) };
  } });
  warmPool.resetForTesting(); setWarmAgentSpawner(null);
});
afterEach(async () => {
  if (root) { await act(async () => root!.unmount()); root = undefined; }
  await Promise.all(closed);
  warmPool.resetForTesting(); setWarmAgentSpawner(null);
  for (const id of children) await orchTerminateSession(id);
  bridge.access!.clearAccess();
  resetRestoredAgentsGate(); setActiveWorkspacePath(null);
  host.remove(); fs.rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks(); vi.restoreAllMocks();
  expect(licensedAgentCount()).toBe(0);
});
it('expiry during a mission denies the next worker and fast-lane respawn while the live child survives', () => {
  const worker: BoundSpawnAuthority = { ...authority(), coordinationScope: { ...authority().scope, rootRealPath: path.dirname(dir) }, source: 'pending', context: { missionId: 'live-mission', role: 'worker', workerIncarnationId: 'worker-1', allowedTools: [], allowedSkills: null } };
  const live = spawn('live-worker', worker);
  now += 3600000;
  expect(bridge.access!.requireAccess('use')).toEqual({ ok: false, reason: 'license-expired' });
  for (const paneId of ['next-worker', 'fast-lane-respawn']) {
    expect(() => spawn(paneId, worker)).toThrow(/license_access_denied/);
  }
  expect(getSessionState(live.sessionId)).not.toBeNull();
  expect(licensedAgentCount()).toBe(1);
});
it('a restarted revoked license holds restore, blocks physical spawn and preserves retired panes under AccessBoundary', async () => {
  bridge.access!.applyLicenseToken(licenseFixture({ access: 'suspended' }));
  // Recreate the authority over the same persisted token and seal.
  bridge.access = createLicenseAccess(accessDeps);
  const retired: PaneModel = { id: 'retired', kind: 'cli-agent', title: 'Aposentado', adapterId: adapter.id, missionId: 'ended', role: 'worker', cwd: dir };
  await present(retired);
  const before = useLayoutStore.getState().root;
  await gateRestoredAgents([retired]);
  expect(holdSpawnUntilApproved).toHaveBeenCalledWith('retired');
  expect(releaseHeldSpawns).not.toHaveBeenCalled();
  expect(() => spawn('retired')).toThrow(/license_access_denied/);
  expect(host.querySelector('input')?.closest('[inert]')).not.toBeNull();
  expect(host.querySelector('[role="dialog"]')).not.toBeNull();
  expect(useLayoutStore.getState().root).toBe(before);
});
it('suspension keeps a presented child alive until the AccessBoundary close action releases its physical slot', async () => {
  const child = spawn('open-pane');
  await present({ id: 'open-pane', kind: 'cli-agent', title: 'Aberto', adapterId: adapter.id, cwd: dir }, child.sessionId);
  const terminal = host.querySelector('input');
  await act(async () => { bridge.access!.applyLicenseToken(licenseFixture({ access: 'suspended' })); });
  expect(host.querySelector('input')).toBe(terminal);
  expect(licensedAgentCount()).toBe(1);
  expect(getSessionState(child.sessionId)).not.toBeNull();
  const close = [...host.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === 'Fechar Aberto')!;
  await act(async () => { close.click(); });
  await Promise.all(closed);
  expect(getSessionState(child.sessionId)).toBeNull();
  expect(licensedAgentCount()).toBe(0);
});
it('the registered warm spawner reserves trial slots and blocking drains it without killing an adopted pane', async () => {
  bridge.access!.applyLicenseToken(licenseFixture({ access: 'trial', limits: { maxAgents: 2, cloudSync: false } }));
  registerWarmAgentSpawner({ resolveAdapter: () => adapter, resolveContext: () => ({ scope: authority().scope, cwd: dir }) });
  warmPool.setWarmPoolSize(1);
  vi.spyOn(warmPool, 'measureCpuHeadroom').mockReturnValue(1);
  expect(await warmPool.replenish(adapter.id)).toBe(true);
  expect(warmPool.getMetrics().readyCount).toBe(1);
  expect(licensedAgentCount()).toBe(1);
  const adopted = spawn();
  await Promise.resolve(); await Promise.resolve();
  expect(warmPool.getMetrics().readyCount).toBe(1);
  expect(licensedAgentCount()).toBe(2);
  expect(() => spawn('third-trial-child')).toThrow(/license_agent_limit/);
  bridge.access!.applyLicenseToken(licenseFixture({ access: 'suspended' }));
  expect(warmPool.getMetrics().readyCount).toBe(0);
  await vi.waitFor(() => expect(licensedAgentCount()).toBe(1));
  expect(getSessionState(adopted.sessionId)).not.toBeNull();
  expect(await warmPool.replenish(adapter.id)).toBe(false);
  expect(() => spawn()).toThrow(/license_access_denied/);
});
