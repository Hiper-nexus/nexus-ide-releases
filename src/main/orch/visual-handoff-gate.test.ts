import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { createScopedBrowserArtifactStore } from '../browser/browser-artifact-store';
import { testProjectScope } from './__tests__/scope-fixture';
import { checkVisualHandoff, recordVisualHandoffEvidence, visualTaskRequirement, visualTaskAtSpawn } from './visual-handoff-gate';

let dir: string;
let manager: ProjectRuntimeManager;
const scope = testProjectScope();
const context = () => ({ scope, executionScope: scope, sessionId: 'worker-session', missionId: 'mission',
  workerIncarnationId: 'incarnation', visualTask: { since: 1000, id: 'assignment-a' } });
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-handoff-'));
  manager = new ProjectRuntimeManager({ baseDir: dir, appVersion: 'test' });
  manager.open(scope).db.prepare("INSERT INTO missions (id,title,status,created_at,updated_at) VALUES ('mission','UI','running',1,1)").run();
});
afterEach(() => { manager.closeAll(); fs.rmSync(dir, { recursive: true, force: true }); });

it('derives a visual requirement from the assigned task, not from a completion claim', () => {
  expect(visualTaskRequirement('Crie a tela de login com layout responsivo.', 1000)).toEqual({ since: 1000, id: expect.any(String) });
  expect(visualTaskRequirement('Documente os endpoints da API de login.', 1000)).toBeUndefined();
  expect(visualTaskRequirement('Corrija o bug na paginação da API de estoque.', 1000)).toBeUndefined();
});
it.each(['Corrija o bug no layout responsivo da tela de login.', 'Corrija o botão que não funciona na interface do dashboard.'])
  ('requires a capture for a UI bug: %s', assignment => expect(visualTaskRequirement(assignment, 1000)).toEqual({ since: 1000, id: expect.any(String) }));
it('preserves an already classified nonvisual task instead of reclassifying appended instructions', () => {
  const initialPrompt = 'Crie a tela de login com layout responsivo.';
  expect(visualTaskAtSpawn({ role: 'worker', visualTask: undefined, initialPrompt })).toBeUndefined();
  expect(visualTaskAtSpawn({ role: 'worker', initialPrompt })).toEqual({ since: expect.any(Number), id: expect.any(String) });
  expect(visualTaskAtSpawn({ role: 'orchestrator', initialPrompt })).toBeUndefined();
});
it('a declared screenshot path or convincing summary cannot satisfy missing Main evidence', async () => {
  expect(await checkVisualHandoff(context(), { manager })).toMatchObject({ required: true, verified: false });
  expect(await checkVisualHandoff({ ...context(), visualTask: undefined }, { manager })).toEqual({ required: false, verified: true });
});
it('requires the exact worker generation, execution root, assignment time and current image bytes', async () => {
  const store = createScopedBrowserArtifactStore(manager, scope);
  const image = store.recordScreenshot({ paneId: 'browser-pane', missionId: 'mission', png: Buffer.from('fixture-png'),
    width: 1, height: 1, url: 'http://localhost:3000', title: 'UI', capturedAt: 1100 });
  expect(recordVisualHandoffEvidence(context(), image.id, manager)).toBe(true);
  expect(await checkVisualHandoff(context(), { manager })).toMatchObject({ verified: true, artifactId: image.id });
  expect(await checkVisualHandoff({ ...context(), workerIncarnationId: 'other' }, { manager })).toMatchObject({ verified: false });
  expect(await checkVisualHandoff({ ...context(), executionScope: { ...scope, rootRealPath: '/other' } }, { manager })).toMatchObject({ verified: false });
  expect(await checkVisualHandoff({ ...context(), visualTask: { since: 1200, id: 'assignment-b' } }, { manager })).toMatchObject({ verified: false });
  fs.writeFileSync(image.path, 'tampered');
  expect(await checkVisualHandoff(context(), { manager })).toMatchObject({ verified: false });
});

it('requires evidence from a sealed visual task even without a spawn hint', async () => {
  expect(await checkVisualHandoff({ ...context(), visualTask: undefined }, { manager,
    task: { plannedTitle: 'Corrija o bug da tela de login', plannedDetail: 'Layout responsivo com formulário.', task: { createdAt: 1000 } },
  })).toMatchObject({ required: true, verified: false });
});

it('does not let another worker or mission claim an existing capture', async () => {
  const store = createScopedBrowserArtifactStore(manager, scope);
  const image = store.recordScreenshot({ paneId: 'browser-pane', missionId: 'mission', png: Buffer.from('fixture'),
    width: 1, height: 1, url: 'http://localhost', title: 'UI', capturedAt: 1100 });
  expect(recordVisualHandoffEvidence(context(), image.id, manager)).toBe(true);
  expect(recordVisualHandoffEvidence({ ...context(), sessionId: 'other' }, image.id, manager)).toBe(false);
  expect(recordVisualHandoffEvidence({ ...context(), missionId: 'other' }, image.id, manager)).toBe(false);
  expect(await checkVisualHandoff({ ...context(), sessionId: 'other' }, { manager })).toMatchObject({ verified: false });
});

it.each([2000, 500])('refuses an earlier task capture after reassignment at clock %s', async since => {
  const ctx = { ...context(), visualTask: visualTaskRequirement('Crie a tela de login com layout responsivo.', 1000)! };
  const image = createScopedBrowserArtifactStore(manager, scope).recordScreenshot({ paneId: 'browser-pane',
    missionId: 'mission', png: Buffer.from('old assignment'), width: 1, height: 1, url: 'http://localhost', title: 'UI', capturedAt: 2000 });
  expect(recordVisualHandoffEvidence(ctx, image.id, manager)).toBe(true);
  ctx.visualTask = visualTaskRequirement('Crie a tela de login com layout responsivo.', since)!;
  expect(await checkVisualHandoff(ctx, { manager })).toMatchObject({ required: true, verified: false });
});

it('keeps same-assignment evidence valid if the wall clock moves backward during capture', async () => {
  const ctx = context();
  const image = createScopedBrowserArtifactStore(manager, scope).recordScreenshot({ paneId: 'browser-pane',
    missionId: 'mission', png: Buffer.from('same assignment'), width: 1, height: 1, url: 'http://localhost', title: 'UI', capturedAt: 500 });
  expect(recordVisualHandoffEvidence(ctx, image.id, manager)).toBe(true);
  expect(await checkVisualHandoff(ctx, { manager })).toMatchObject({ required: true, verified: true });
});

it('revokes an in-flight check if the assignment changes and propagates authority cancellation', async () => {
  const ctx = context();
  const image = createScopedBrowserArtifactStore(manager, scope).recordScreenshot({ paneId: 'browser-pane',
    missionId: 'mission', png: Buffer.from('fixture'), width: 1, height: 1, url: 'http://localhost', title: 'UI', capturedAt: 1100 });
  recordVisualHandoffEvidence(ctx, image.id, manager);
  const realOpen = fs.promises.open.bind(fs.promises);
  const open = vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
    ctx.visualTask = { since: 1200, id: 'assignment-b' };
    return realOpen(...args);
  });
  try { expect(await checkVisualHandoff(ctx, { manager })).toMatchObject({ verified: false }); }
  finally { open.mockRestore(); }
  await expect(checkVisualHandoff(context(), { manager, assertCurrent: () => { throw new Error('stale authority'); } }))
    .rejects.toThrow('stale authority');
});

it('selects bounded proof candidates through the worker index', () => {
  const plan = manager.open(scope).db.prepare(`EXPLAIN QUERY PLAN SELECT artifact_id FROM visual_handoff_evidence
    WHERE session_id = ? AND mission_id IS ? AND worker_incarnation_id IS ? AND execution_root = ? AND assignment_id = ?
    ORDER BY captured_at DESC LIMIT 4`).all('worker-session', 'mission', 'incarnation', scope.rootRealPath, 'assignment-a');
  expect(JSON.stringify(plan)).toContain('idx_visual_handoff_assignment');
  expect(JSON.stringify(plan)).not.toContain('TEMP B-TREE');
});
