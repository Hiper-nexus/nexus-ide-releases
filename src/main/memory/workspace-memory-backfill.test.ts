import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { createScopedHandoffStore } from '../orch/handoff-store';
import { createScopedMissionStore } from '../orch/mission-store';
import { configureProjectDomainStoreRegistry, disposeProjectDomainStoreRegistry } from '../orch/project-domain-store-registry';
import { testProjectScope } from '../orch/__tests__/scope-fixture';
import { runPeriodicTask } from '../observability/periodic-task';
import { configureWorkspaceMemory, disposeWorkspaceMemoryStores, getWorkspaceMemoryStore } from './workspace-memory';
import { distillHandoffSummary } from '../jev/jev-memory-distill';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';
vi.mock('../license-access', async () => (await import('../__tests__/licensed-access')).licensedAccessMock);
vi.mock('../jev/jev-memory-distill', async (original) => ({ ...await original<typeof import('../jev/jev-memory-distill')>(), distillHandoffSummary: vi.fn() }));

let root: string;
let manager: ProjectRuntimeManager;
const scope = testProjectScope({ projectId: 'backfill-project' });
const distill = vi.mocked(distillHandoffSummary);
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-backfill-'));
  manager = new ProjectRuntimeManager({ baseDir: path.join(root, 'runtime'), appVersion: 'test' });
  configureWorkspaceMemory({ baseDir: path.join(root, 'memory') });
  getFeatureFlagRegistry().setOverride(FEATURE_FLAG_IDS.workspaceMemory, true);
  distill.mockReset().mockImplementation(async (_input, deps) => { deps?.onSkip?.('jev-skip'); return null; });
});
afterEach(async () => { await disposeProjectDomainStoreRegistry(); disposeWorkspaceMemoryStores(); manager.closeAll(); fs.rmSync(root, { recursive: true, force: true }); });

it('Main registry opens replay for historical handoffs without a new prompt or ACK', async () => {
  createScopedHandoffStore(manager, scope).submit({ status: 'success', summary: 'Historical live-domain replay knowledge.' });
  await Promise.resolve();
  expect(getWorkspaceMemoryStore(scope).stats().workspace.active).toBe(0);
  distill.mockReset().mockResolvedValue('Historical live-domain replay knowledge.');
  const registry = configureProjectDomainStoreRegistry(manager);
  registry.forScope(scope);
  await vi.waitFor(() => expect(getWorkspaceMemoryStore(scope).stats().workspace.active).toBe(1));
  expect(getWorkspaceMemoryStore(scope).recall({ query: 'Historical' })[0]?.content).toContain('unverified; Jev approved for retention');
});

it('bounded Main replay excludes undelivered mission handoffs, resumes after restart and does not duplicate', async () => {
  const handoffs = createScopedHandoffStore(manager, scope);
  createScopedMissionStore(manager, scope, { idFactory: () => 'backfill-mission' }).create({ title: 'Backfill' });
  for (let i = 0; i < 7; i++) handoffs.submit({ status: 'success', summary: `Historical valuable constraint number ${i}.` });
  handoffs.submit({ missionId: 'backfill-mission', status: 'success', summary: 'Unaccepted mission payload.' });
  handoffs.submit({ status: 'partial', summary: 'Incomplete report.' });
  await Promise.resolve();
  distill.mockReset().mockImplementation(async (input) => input.summary.slice(0, 400));
  const { backfillWorkspaceMemory } = await import('./workspace-memory-backfill');
  await runPeriodicTask('memory-maintenance:backfill-project', (ctx) => backfillWorkspaceMemory(scope, handoffs, ctx));
  expect(distill).toHaveBeenCalledTimes(4);
  expect(getWorkspaceMemoryStore(scope).stats().workspace.active).toBe(4);
  configureWorkspaceMemory({ baseDir: path.join(root, 'memory') });
  await runPeriodicTask('memory-maintenance:backfill-project', (ctx) => backfillWorkspaceMemory(scope, handoffs, ctx));
  expect(getWorkspaceMemoryStore(scope).stats().workspace.active).toBe(7);
  await runPeriodicTask('memory-maintenance:backfill-project', (ctx) => backfillWorkspaceMemory(scope, handoffs, ctx));
  expect(distill).toHaveBeenCalledTimes(7);
  expect(getWorkspaceMemoryStore(scope).recall({ query: 'Unaccepted Incomplete' })).toHaveLength(0);
  const other = testProjectScope({ projectId: 'foreign-backfill' });
  expect(getWorkspaceMemoryStore(other).stats().workspace.active).toBe(0);
  await expect(runPeriodicTask('memory-maintenance:foreign-backfill', (ctx) => backfillWorkspaceMemory(other, handoffs, ctx))).rejects.toThrow('scope');
});

it('unavailable Jev replay persists the candidate before advancing its cursor', async () => {
  const handoffs = createScopedHandoffStore(manager, scope);
  handoffs.submit({ status: 'success', summary: 'A durable constraint must survive unavailable distillation.' });
  await Promise.resolve();
  distill.mockImplementation(async (_input, deps) => { deps?.onSkip?.('no-route'); return null; });
  const { backfillWorkspaceMemory } = await import('./workspace-memory-backfill');
  await runPeriodicTask('memory-maintenance:backfill-project', (ctx) => backfillWorkspaceMemory(scope, handoffs, ctx));
  expect(getWorkspaceMemoryStore(scope).pendingRetentions()).toHaveLength(1);
  expect(getWorkspaceMemoryStore(scope).stats().workspace.active).toBe(0);
});

it('backfill does not redistill an accepted handoff already retained by the live production path', async () => {
  distill.mockResolvedValue('Live accepted knowledge is already durable.');
  const handoffs = createScopedHandoffStore(manager, scope);
  handoffs.submit({ status: 'success', summary: 'Live accepted knowledge is already durable.' });
  const store = getWorkspaceMemoryStore(scope);
  await vi.waitFor(() => expect(store.stats().workspace.active).toBe(1));
  distill.mockReset().mockResolvedValue('A differently phrased duplicate of the same handoff.');
  const { backfillWorkspaceMemory } = await import('./workspace-memory-backfill');
  await runPeriodicTask('memory-maintenance:backfill-project', (ctx) => backfillWorkspaceMemory(scope, handoffs, ctx));
  expect(distill).not.toHaveBeenCalled();
  expect(store.stats().workspace.active).toBe(1);
});
