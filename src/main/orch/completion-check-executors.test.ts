import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ plan: vi.fn(), execute: vi.fn(), remove: vi.fn() }));
vi.mock('../runtime/process-sandbox', () => ({
  buildScopedExecPlan: state.plan, createScopedSandboxHome: () => ({ dir: '/runtime', tmp: '/runtime/tmp', home: '/runtime/home' }),
}));
vi.mock('./owned-check-exec', async importOriginal => ({ ...await importOriginal<typeof import('./owned-check-exec')>(), execOwnedCheck: state.execute }));
vi.mock('../util/remove-tree', () => ({ removeTreeSync: state.remove }));
import { createCompletionCheckExecutors, containerCheckArgs } from './completion-check-executors';
import { testProjectScope } from './__tests__/scope-fixture';

beforeEach(() => { vi.clearAllMocks(); state.plan.mockImplementation(input => ({ file: input.executable, args: input.args, cwd: input.cwd, env: input.env, detached: true })); state.execute.mockResolvedValue({ exitCode: 0, timedOut: false, aborted: false, stdout: '', stderr: '' }); });
it('maps Windows compiler/config/report arguments inside the two actual mounts', () => {
  expect(containerCheckArgs(['C:\\work tree\\node_modules\\typescript\\bin\\tsc', '--project', 'C:\\work tree\\tsconfig.json', '--outputFile=C:\\private runtime\\tmp\\report.json'], 'C:\\work tree', 'C:\\private runtime')).toEqual(['/workspace/node_modules/typescript/bin/tsc', '--project', '/workspace/tsconfig.json', '--outputFile=/nexus-runtime/tmp/report.json']);
  expect(() => containerCheckArgs(['C:\\other\\secret.js'], 'C:\\work tree', 'C:\\private runtime')).toThrow('fora dos mounts');
});
it('preserves relative runner flags and paths without command interpolation', () => {
  expect(containerCheckArgs(['run', 'src/a.test.ts', '--config=tests/config.ts'], 'C:\\repo', 'C:\\tmp')).toEqual(['run', 'src/a.test.ts', '--config=tests/config.ts']);
});
it('regression uses the coordination budget, execution sandbox and authority fence', async () => {
  const scope = testProjectScope(); const execution = { ...scope, checkoutId: 'tab', rootRealPath: '/tab' }; const assertCurrent = vi.fn();
  const ports = createCompletionCheckExecutors({ scope, executionScope: execution, missionId: 'mission', assertCurrent });
  await ports.regression(process.execPath, ['run'], { cwd: '/tab', scope: execution, sandboxDir: '/runtime', timeoutMs: 100, env: { PATH: '/bin' }, extraReadPaths: [] });
  expect(state.execute).toHaveBeenCalledWith(expect.objectContaining({ request: expect.objectContaining({ scope, missionId: 'mission', kind: 'tests' }) }));
  expect(state.plan).toHaveBeenCalledWith(expect.objectContaining({ rootRealPath: '/tab', sandboxDir: '/runtime', env: { PATH: '/bin' } }));
  state.execute.mock.calls[0][0].request.isCurrent(); expect(assertCurrent).toHaveBeenCalled();
});
it('missing owner/sandbox infrastructure returns explicit unavailability', async () => {
  state.plan.mockImplementation(() => { throw new Error('Windows OCI runtime not configured'); });
  const ports = createCompletionCheckExecutors({ scope: testProjectScope(), executionScope: testProjectScope(), missionId: 'mission', assertCurrent: () => {} });
  const result = await ports.regression(process.execPath, [], { cwd: '/workspace', scope: testProjectScope(), sandboxDir: '/runtime', timeoutMs: 100, env: {}, extraReadPaths: [] });
  expect(result).toMatchObject({ exitCode: null, stderr: expect.stringContaining('Windows OCI runtime not configured') }); expect(state.execute).not.toHaveBeenCalled();
});

it('strict compiler uses sanitized environment and exposes missing infrastructure honestly', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-check-'));
  try {
    fs.mkdirSync(path.join(root, 'node_modules/.bin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules/.bin/tsc'), '#!/bin/sh\n');
    fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ devDependencies: { typescript: '*' } }));
    vi.stubEnv('NEXUS_TEST_SECRET', 'must-not-reach-child');
    const scope = testProjectScope({ rootRealPath: root });
    const ports = createCompletionCheckExecutors({ scope, executionScope: scope, missionId: 'm', assertCurrent: () => {} });
    state.execute.mockResolvedValue({ exitCode: null, timedOut: false, aborted: false, stdout: '', stderr: 'command_supervisor_unavailable' });
    const result = await ports.typecheck(root);
    expect(result).toMatchObject({ status: 'unavailable', summary: expect.stringContaining('command_supervisor_unavailable') });
    expect(state.plan.mock.calls[0][0].env.NEXUS_TEST_SECRET).toBeUndefined();
    expect(state.execute.mock.calls[0][0].request.kind).toBe('typescript');
  } finally { fs.rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); }
});

it('cleanup filesystem errors after physical proof never reject the Main check', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-check-cleanup-'));
  try {
    fs.mkdirSync(path.join(root, 'node_modules/.bin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules/.bin/tsc'), '#!/bin/sh\n');
    fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}');
    const scope = testProjectScope({ rootRealPath: root });
    const physicalExit = Promise.resolve();
    state.execute.mockResolvedValue({ exitCode: 0, timedOut: false, aborted: false, stdout: '', stderr: '', physicalExit });
    state.remove.mockImplementation(() => { throw new Error('EPERM'); });
    const ports = createCompletionCheckExecutors({ scope, executionScope: scope, missionId: 'm', assertCurrent: () => {} });
    expect((await ports.typecheck(root)).status).toBe('passed');
    await physicalExit; await Promise.resolve(); expect(state.remove).toHaveBeenCalled();
  } finally { state.remove.mockReset(); fs.rmSync(root, { recursive: true, force: true }); }
});
