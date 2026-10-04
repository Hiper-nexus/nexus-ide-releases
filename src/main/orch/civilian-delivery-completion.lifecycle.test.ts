import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isReady: () => true },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null }, ipcMain: { handle: vi.fn(), on: vi.fn() } }));
vi.mock('../license-access', async () => (await import('../__tests__/licensed-access')).licensedAccessMock);
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { testProjectScope } from './__tests__/scope-fixture';
import { configureProjectDomainStoreRegistry, disposeProjectDomainStoreRegistry } from './project-domain-store-registry';
import { maybeCompleteFastLaneOnDelivery } from './civilian-delivery-completion';
import { initIdleDelivery, shutdownIdleDelivery } from './idle-delivery';

beforeEach(() => initIdleDelivery());
afterEach(async () => { await shutdownIdleDelivery(); });

it('delivery completion cannot write a task after idle stop and actual registry/store disposal', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-delivery-lifetime-review-')));
  const runtime = new ProjectRuntimeManager({ baseDir: path.join(root, 'runtime'), appVersion: 'delivery-review' });
  const scope = testProjectScope({ rootRealPath: root });
  const registry = configureProjectDomainStoreRegistry(runtime);
  const suite = registry.forScope(scope);
  const mission = suite.missions.create({ title: 'Lifecycle fixture', description: 'A fixture research task.', intentState: 'executing', intentVersion: 1 });
  suite.missions.setStatus(mission.id, 'running');
  const task = suite.tasks.create({ missionId: mission.id, title: 'Research fixture' });
  suite.handoffs.submit({ missionId: mission.id, fromAgent: 'Research fixture', status: 'success', summary: 'Research fixture has a complete durable report for review.' });
  let release!: () => void; const gate = new Promise<string[]>(resolve => { release = () => resolve([]); });
  let enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; });
  const flight = maybeCompleteFastLaneOnDelivery(scope, mission.id, {
    listPanes: () => [], listObserverPaneSessions: () => [], resolveMissionLeader: () => null,
    listProductFiles: () => { enter(); return gate; },
  });
  await entered;
  const stopping = shutdownIdleDelivery();
  await disposeProjectDomainStoreRegistry();
  expect(suite.tasks.list(mission.id).find(row => row.id === task.id)?.status).toBe('pending');
  runtime.closeAll();
  release();
  try {
    await flight;
    // Source facade remains; actual manager lazily reopens its private DB.
    expect(suite.tasks.list(mission.id).find(row => row.id === task.id)?.status).toBe('pending');
  } finally { release(); await flight.catch(() => undefined); await stopping; runtime.closeAll(); fs.rmSync(root, { recursive: true, force: true }); }
});

it('stop retains physical collection and restart preserves pending tasks and durable handoffs', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-f889-restart-')));
  const runtime = new ProjectRuntimeManager({ baseDir: path.join(root, 'runtime'), appVersion: 'delivery-review' });
  const scope = testProjectScope({ rootRealPath: root });
  const registry = configureProjectDomainStoreRegistry(runtime);
  const suite = registry.forScope(scope);
  const mission = suite.missions.create({ title: 'Restart fixture', description: 'A fixture research task.', intentState: 'executing', intentVersion: 1 });
  suite.missions.setStatus(mission.id, 'running');
  const task = suite.tasks.create({ missionId: mission.id, title: 'Research fixture' });
  const handoff = suite.handoffs.submit({ missionId: mission.id, fromAgent: 'Research fixture', status: 'success', summary: 'Research fixture has a complete durable report for review.' });
  let release!: () => void; const gate = new Promise<string[]>(resolve => { release = () => resolve([]); });
  let enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; });
  const observation = { listPanes: () => [], listObserverPaneSessions: () => [], resolveMissionLeader: () => null };
  const flight = maybeCompleteFastLaneOnDelivery(scope, mission.id, { ...observation, listProductFiles: () => { enter(); return gate; } });
  await entered;
  let stopped = false; const stop = shutdownIdleDelivery().then(() => { stopped = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  const stoppedEarly = stopped;
  const restartBeforeDrain = () => initIdleDelivery();
  try {
    expect(restartBeforeDrain).toThrow('still draining');
    expect((await maybeCompleteFastLaneOnDelivery(scope, mission.id, observation)).reason).toBe('completion-stopped');
    release(); await stop;
    expect(stoppedEarly).toBe(false);
    expect((await flight).completed).toBe(false);
    expect(suite.tasks.list(mission.id).find(row => row.id === task.id)?.status).toBe('pending');
    expect(suite.handoffs.list({ missionId: mission.id })).toHaveLength(1);
    initIdleDelivery(); initIdleDelivery();
    const retried = await maybeCompleteFastLaneOnDelivery(scope, mission.id, { ...observation, listProductFiles: () => [] });
    expect(retried.completed).toBe(false); // no product file/evidence means no false mission success
    expect(suite.missions.get(mission.id)?.status).toBe('running');
    expect(suite.tasks.list(mission.id).find(row => row.id === task.id)?.status).toBe('done');
    expect(suite.handoffs.list({ missionId: mission.id })[0]?.id).toBe(handoff.id);
  } finally { release(); await flight.catch(() => undefined); await stop; await shutdownIdleDelivery();
    await disposeProjectDomainStoreRegistry(); runtime.closeAll(); fs.rmSync(root, { recursive: true, force: true }); }
});
