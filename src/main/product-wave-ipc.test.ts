import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { testProjectScope } from './orch/__tests__/scope-fixture';
import { bindResolvedRendererWorkspaceScope, clearRendererWorkspaceScope } from './persistence/renderer-workspace-scope';
import { PRODUCT_WAVE_CHANNELS } from '../shared/channels';

const fixture = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  ensure: vi.fn<() => Promise<void>>(),
  retain: vi.fn(() => ({ id: 'mem-fixture', scope: 'workspace', deduped: false, redacted: false })),
  list: vi.fn(() => [{ id: 'mem-fixture', title: 'Fixture memory' }]),
  search: vi.fn(() => []), backlinks: vi.fn(() => []), complete: vi.fn(() => []),
  stores: vi.fn(() => ({ missions: { get: () => ({ id: 'mission-fixture' }) } })),
  missionGate: null as Promise<void> | null,
  missionEntered: null as (() => void) | null,
}));
vi.mock('electron', () => ({ ipcMain: { handle: (key: string, callback: (...args: any[]) => any) => fixture.handlers.set(key, callback) },
  BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('./feature-flags/feature-flag-registry', () => ({ getFeatureFlagRegistry: () => ({ isEnabled: () => true }) }));
vi.mock('./memory/workspace-memory', () => ({ getWorkspaceMemoryStore: () => ({ ensureProjections: fixture.ensure,
  projectionRoot: '/fixture-projection', retain: fixture.retain, activeWorkspaceMetas: () => new Map() }) }));
vi.mock('./memory/trusted-memory', () => ({ retainTrustedMemory: fixture.retain }));
vi.mock('./memory/nexus-memory', () => ({ listMemoryNotes: fixture.list,
  searchMemory: fixture.search, backlinks: fixture.backlinks, wikilinkCompletions: fixture.complete }));
vi.mock('./orch/project-domain-store-registry', async () => {
  fixture.missionEntered?.(); await fixture.missionGate;
  return { getProjectDomainStores: fixture.stores };
});
import { registerProductWaveIpc } from './product-wave-ipc';

let root: string, a: string, b: string;
const sender = { id: 488001, isDestroyed: () => false, isCrashed: () => false } as Electron.WebContents;
const bindA = () => bindResolvedRendererWorkspaceScope(sender, testProjectScope({ projectId: 'fixture-a', rootRealPath: a }));
const bindB = () => bindResolvedRendererWorkspaceScope(sender, testProjectScope({ projectId: 'fixture-b', rootRealPath: b }));
const handler = (channel: string) => fixture.handlers.get(channel)!;
const note = { title: 'Fixture memory', body: 'Knowledge belongs to the initiating workspace.', kind: 'note' };

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-f888-')));
  a = path.join(root, 'a'); b = path.join(root, 'b'); fs.mkdirSync(a); fs.mkdirSync(b);
  fixture.ensure.mockReset().mockResolvedValue(undefined);
  for (const mock of [fixture.retain, fixture.list, fixture.search, fixture.backlinks, fixture.complete, fixture.stores]) mock.mockClear();
  bindA(); registerProductWaveIpc();
});
afterEach(() => { clearRendererWorkspaceScope(sender); fs.rmSync(root, { recursive: true, force: true }); });

it('F-888: a workspace switch during projection IO refuses old-scope memory mutation', async () => {
  let release!: () => void;
  fixture.ensure.mockReturnValueOnce(new Promise<void>(resolve => { release = resolve; }));
  const flight = handler(PRODUCT_WAVE_CHANNELS.memoryRemember)({ sender }, note);
  bindB(); release();
  await expect(flight).rejects.toThrow(/authority changed/i);
  expect(fixture.retain).not.toHaveBeenCalled();
});

it.each([
  [PRODUCT_WAVE_CHANNELS.memoryList, undefined, 'list'],
  [PRODUCT_WAVE_CHANNELS.memorySearch, { query: 'private-fixture' }, 'search'],
  [PRODUCT_WAVE_CHANNELS.memoryBacklinks, { title: 'Private fixture' }, 'backlinks'],
  [PRODUCT_WAVE_CHANNELS.memoryComplete, { prefix: 'Private' }, 'complete'],
] as const)('F-888: %s never returns data from the retired workspace', async (channel, input, reader) => {
  let release!: () => void;
  fixture.ensure.mockReturnValueOnce(new Promise<void>(resolve => { release = resolve; }));
  const flight = handler(channel)({ sender }, input);
  bindB(); release();
  await expect(flight).rejects.toThrow(/authority changed/i);
  expect(fixture[reader]).not.toHaveBeenCalled();
});

it('F-888: a switch after an authorized write rejects the stale projected return', async () => {
  let entered!: () => void, release!: () => void;
  const writing = new Promise<void>(resolve => { entered = resolve; });
  fixture.ensure.mockResolvedValueOnce(undefined).mockImplementationOnce(() => {
    entered(); return new Promise<void>(resolve => { release = resolve; });
  });
  const flight = handler(PRODUCT_WAVE_CHANNELS.memoryRemember)({ sender }, note);
  await writing; bindB(); release();
  await expect(flight).rejects.toThrow(/authority changed/i);
  expect(fixture.retain).toHaveBeenCalledOnce(); // Write was authorized in A.
  expect(fixture.list).not.toHaveBeenCalled();
});

it('F-888: current Main-bound scope continues to read and write normally', async () => {
  await expect(handler(PRODUCT_WAVE_CHANNELS.memoryRemember)({ sender }, note)).resolves.toMatchObject({ id: 'mem-fixture' });
  expect(fixture.retain).toHaveBeenCalledOnce();
  await expect(handler(PRODUCT_WAVE_CHANNELS.memoryList)({ sender })).resolves.toHaveLength(1);
});

it('F-888: mission lookup after its import wait never opens stores of the old scope', async () => {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  fixture.missionEntered = enter;
  fixture.missionGate = new Promise<void>(resolve => { release = resolve; });
  const flight = handler(PRODUCT_WAVE_CHANNELS.memoryRemember)({ sender }, { ...note, kind: 'mission', missionId: 'mission-fixture' });
  await entered; bindB(); release();
  await expect(flight).rejects.toThrow(/authority changed/i);
  expect(fixture.stores).not.toHaveBeenCalled();
  expect(fixture.retain).not.toHaveBeenCalled();
});

// Estes testes ficam por último de propósito: o lookup de missão é um import
// dinâmico preguiçoso (`missionLookup ??= import(...)`) cujo mock F-888 só
// sincroniza na primeira carga — um teste com missionId antes dele rouba a
// primeira carga e o F-888 trava no `await entered`.
it('memoryRemember kind decision retains a trusted operator-decision', async () => {
  await expect(handler(PRODUCT_WAVE_CHANNELS.memoryRemember)({ sender },
    { title: 'Fixture decision', body: 'Sempre validar o failover em campo.', kind: 'decision' },
  )).resolves.toMatchObject({ id: 'mem-fixture' });
  expect(fixture.retain).toHaveBeenCalledOnce();
  expect(fixture.retain).toHaveBeenCalledWith(
    expect.anything(),
    { type: 'operator-decision', title: 'Fixture decision', summary: 'Sempre validar o failover em campo.' },
  );
});

it('memoryRemember kind decision attributes the claimed mission', async () => {
  await expect(handler(PRODUCT_WAVE_CHANNELS.memoryRemember)({ sender },
    { title: 'Fixture decision', body: 'Vale para a missão.', kind: 'decision', missionId: 'mission-fixture' },
  )).resolves.toMatchObject({ id: 'mem-fixture' });
  expect(fixture.retain).toHaveBeenCalledWith(
    expect.anything(),
    { type: 'operator-decision', title: 'Fixture decision', summary: 'Vale para a missão.', missionId: 'mission-fixture' },
  );
});
