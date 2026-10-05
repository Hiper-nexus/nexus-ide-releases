import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MEMORY_CHANNELS } from '../../shared/channels';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';
import { testProjectScope } from '../orch/__tests__/scope-fixture';
import { bindResolvedRendererWorkspaceScope, clearRendererWorkspaceScope } from '../persistence/renderer-workspace-scope';
import { configureWorkspaceMemory, disposeWorkspaceMemoryStores, getWorkspaceMemoryStore } from './workspace-memory';
import { registerMemoryIpc } from './memory-ipc';

const boundary = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(), dialog: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => boundary.handlers.set(name, fn) },
  BrowserWindow: { fromWebContents: () => null }, dialog: { showOpenDialog: boundary.dialog } }));
const sender = { id: 76543, isDestroyed: () => false, isCrashed: () => false };
let root: string;
let scope: ReturnType<typeof testProjectScope>;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-ipc-'));
  scope = testProjectScope({ projectId: 'ipc-attestation-project', rootRealPath: root });
  configureWorkspaceMemory({ baseDir: path.join(root, 'bank') });
  bindResolvedRendererWorkspaceScope(sender, scope);
  getFeatureFlagRegistry().setOverride(FEATURE_FLAG_IDS.workspaceMemory, true);
  boundary.handlers.clear(); boundary.dialog.mockReset(); registerMemoryIpc();
});
afterEach(() => { clearRendererWorkspaceScope(sender); disposeWorkspaceMemoryStores(); fs.rmSync(root, { recursive: true, force: true }); });

it('renderer attestation derives project authority from Main and rejects claimed scope/source fields', () => {
  const attest = boundary.handlers.get(MEMORY_CHANNELS.attest)!;
  const request = { type: 'architecture-rule', title: 'Atomic writes', summary: 'Writes are atomic.', scope: 'workspace' };
  expect(attest({ sender }, request)).toMatchObject({ enabled: true, scope: 'workspace' });
  expect(getWorkspaceMemoryStore(scope).recall({ query: 'atomic' })[0]?.source).toBe('trusted:architecture-rule');
  expect(() => attest({ sender }, { ...request, projectId: 'foreign', source: 'trusted:operator' })).toThrow();
  expect(() => attest({ sender: { id: 123 } }, request)).toThrow('authorized');
});

it('operator import opens native selection, writes only quarantined scoped notes and rejects changed workspace', async () => {
  const file = path.join(root, 'native.md'); fs.writeFileSync(file, 'Only selected native insight.');
  boundary.dialog.mockResolvedValue({ canceled: false, filePaths: [file] });
  const importer = boundary.handlers.get('memory:import-native');
  expect(importer).toBeTypeOf('function');
  expect(await importer!({ sender })).toMatchObject({ enabled: true, imported: 1, skipped: 0 });
  expect(getWorkspaceMemoryStore(scope).recall({ query: 'native' })[0]?.flags).toContain('quarantine');
  boundary.dialog.mockImplementation(async () => { clearRendererWorkspaceScope(sender); return { canceled: false, filePaths: [file] }; });
  await expect(importer!({ sender })).rejects.toThrow('authorized');
});

it('Mem12: stats exposes Main-owned deliveries since the latest memory, scoped to the sender', () => {
  const store = getWorkspaceMemoryStore(scope);
  const retained = store.retain({ content: 'Nota antiga do projeto.', kind: 'note', scope: 'workspace', source: 'operator:note' });
  const latest = store.activeWorkspaceMetas().get(retained.id)!.updatedAt;
  const counter = vi.fn((_scope: unknown, _since: number, _until: number) => 2);
  boundary.handlers.clear(); registerMemoryIpc({ countHandoffDeliveries: counter });
  const stats = boundary.handlers.get(MEMORY_CHANNELS.stats)!;
  expect(stats({ sender })).toMatchObject({
    enabled: true,
    activity: { latestMemoryAt: latest, deliveredHandoffsSinceLatestMemory: 2 },
  });
  expect(counter).toHaveBeenCalledOnce();
  const [countedScope, since, until] = counter.mock.calls[0]!;
  expect(countedScope).toMatchObject({ projectId: scope.projectId, rootRealPath: root });
  expect(since).toBe(latest);
  expect(until).toBeGreaterThanOrEqual(latest);
  // Sender sem escopo autorizado nunca chega à contagem.
  counter.mockClear();
  expect(() => stats({ sender: { id: 123 } })).toThrow('authorized');
  expect(counter).not.toHaveBeenCalled();
  // Contagem indisponível é desconhecida, nunca um zero inventado.
  counter.mockImplementationOnce(() => { throw new Error('runtime closed'); });
  expect(stats({ sender })).toMatchObject({ activity: { latestMemoryAt: latest, deliveredHandoffsSinceLatestMemory: null } });
});
