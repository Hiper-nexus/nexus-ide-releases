import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { compileIntentContract } from '../../shared/mission-intent';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { configureWorktreeRuntimeRegistry, disposeWorktreeRuntimeRegistry } from '../runtime/worktree-runtime-registry';
import { createScopedMissionStore } from './mission-store';
import { testProjectScope } from './__tests__/scope-fixture';
import { adoptedMissionWorkspaceBinding, assertTabSupportsOperation, missionExecutionScope, newMissionWorkspaceBinding, prepareMissionExecutionScope } from './mission-execution-scope';

let directory: string;
let manager: ProjectRuntimeManager;
let scope: ReturnType<typeof testProjectScope>;
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
const contract = () => ({ ...compileIntentContract({ goal: 'Implementar a tarefa da aba', source: 'typed', intentVersion: 1 }), workspaceBinding: newMissionWorkspaceBinding() });

beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-mission-execution-')));
  const root = path.join(directory, 'repo'); fs.mkdirSync(root);
  git(root, 'init', '-q'); git(root, 'config', 'user.name', 'Nexus Fixture'); git(root, 'config', 'user.email', 'fixture@example.invalid');
  fs.writeFileSync(path.join(root, 'source.txt'), 'committed');
  git(root, 'add', 'source.txt'); git(root, 'commit', '-qm', 'baseline');
  scope = testProjectScope({ rootRealPath: root });
  manager = new ProjectRuntimeManager({ baseDir: path.join(directory, 'runtime'), appVersion: 'test' });
  configureWorktreeRuntimeRegistry(manager);
});
afterEach(() => {
  disposeWorktreeRuntimeRegistry(); manager.closeAll(); fs.rmSync(directory, { recursive: true, force: true });
});

it('leaves legacy missions/adoption alone and shares one durable root per new mission across restart', async () => {
  expect(missionExecutionScope(scope, {})).toBe(scope);
  expect(adoptedMissionWorkspaceBinding(scope, scope, 'legacy-pane')).toEqual({ version: 1, adoptedPaneId: 'legacy-pane' });
  fs.writeFileSync(path.join(scope.rootRealPath, 'source.txt'), 'main WIP');
  const a = { intentContract: contract() }; const b = { intentContract: contract() };
  const [first, repeat, second] = await Promise.all([prepareMissionExecutionScope(scope, a), prepareMissionExecutionScope(scope, a), prepareMissionExecutionScope(scope, b)]);
  expect(first.rootRealPath).toBe(repeat.rootRealPath);
  expect(first.rootRealPath).not.toBe(second.rootRealPath);
  expect(fs.readFileSync(path.join(first.rootRealPath, 'source.txt'), 'utf8')).toBe('committed');
  fs.writeFileSync(path.join(first.rootRealPath, 'source.txt'), 'tab WIP');
  a.intentContract.dispatchedAt = 100;
  disposeWorktreeRuntimeRegistry(); configureWorktreeRuntimeRegistry(manager);
  expect((await prepareMissionExecutionScope(scope, a)).rootRealPath).toBe(first.rootRealPath);
  expect(fs.readFileSync(path.join(first.rootRealPath, 'source.txt'), 'utf8')).toBe('tab WIP');
  expect(adoptedMissionWorkspaceBinding(scope, first, 'host-pane')).toMatchObject({ spaceId: a.intentContract.workspaceBinding.spaceId, adoptedPaneId: 'host-pane' });
  expect(() => assertTabSupportsOperation(scope, first, 'isolatedWriter')).toThrow('ainda não suporta');
  expect(() => assertTabSupportsOperation(scope, scope, 'isolatedWriter')).not.toThrow();
});

it('does not recreate a missing record on resume or accept another checkout Git admin directory', async () => {
  const mission = { intentContract: contract() };
  mission.intentContract.dispatchedAt = 100;
  await expect(prepareMissionExecutionScope(scope, mission)).rejects.toThrow('não está registrada');
  expect(() => assertTabSupportsOperation(scope, { ...scope, rootRealPath: path.join(directory, 'lost-tab') }, 'PREVC', true)).toThrow('ainda não suporta');
  delete mission.intentContract.dispatchedAt;
  const execution = await prepareMissionExecutionScope(scope, mission);
  mission.intentContract.dispatchedAt = 100;
  fs.writeFileSync(path.join(execution.rootRealPath, '.git'), `gitdir: ${path.join(scope.rootRealPath, '.git')}\n`);
  await expect(prepareMissionExecutionScope(scope, mission)).rejects.toThrow('mudou no disco');
});

it('keeps the workspace choice immutable through mission lifecycle edits', async () => {
  const store = createScopedMissionStore(manager, scope);
  const mission = store.create({ title: 'Aba', intentVersion: 1, intentContract: contract() });
  expect(() => store.update(mission.id, { intentContract: { ...mission.intentContract!, workspaceBinding: newMissionWorkspaceBinding() } })).toThrow('workspace binding is immutable');
  expect(() => store.update(mission.id, { intentContract: null })).toThrow('workspace binding is immutable');
  expect(store.update(mission.id, { title: 'Renomeada' })?.intentContract?.workspaceBinding).toEqual(mission.intentContract?.workspaceBinding);
});

it('explains the Git prerequisite without creating a commit or falling back', async () => {
  const empty = path.join(directory, 'empty'); fs.mkdirSync(empty); git(empty, 'init', '-q');
  const emptyScope = testProjectScope({ checkoutId: 'empty', rootRealPath: empty });
  await expect(prepareMissionExecutionScope(emptyScope, { intentContract: contract() })).rejects.toThrow('pelo menos um commit');
  expect(git(empty, 'status', '--porcelain')).toBe('');
});
