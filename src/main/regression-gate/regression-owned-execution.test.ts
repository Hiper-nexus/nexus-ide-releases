import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock('../orch/owned-check-exec', async importOriginal => ({ ...await importOriginal<typeof import('../orch/owned-check-exec')>(), execOwnedCheck: state.exec }));
vi.mock('../runtime/process-sandbox', async importOriginal => ({ ...await importOriginal<typeof import('../runtime/process-sandbox')>(),
  buildScopedExecPlan: (input: { executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }) => ({ file: input.executable, args: input.args, cwd: input.cwd, env: input.env, detached: true }),
}));
import { ProcessGitRunner } from '../runtime/git-command';
import { runRegressionGate, __resetRegressionGateForTests } from './regression-gate';
import { testProjectScope } from '../orch/__tests__/scope-fixture';
const roots: string[] = [];
afterEach(() => { __resetRegressionGateForTests(); vi.clearAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function project() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'owned-regression-'))); roots.push(root);
  fs.mkdirSync(path.join(root, 'node_modules/.bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules/.bin/vitest'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ devDependencies: { vitest: '*' } }));
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules\n');
  fs.writeFileSync(path.join(root, 'app.ts'), 'export const app = 1;');
  fs.writeFileSync(path.join(root, 'app.test.ts'), "import { app } from './app';");
  const git = new ProcessGitRunner(); const run = (...args: string[]) => git.run(root, args);
  run('init', '-q'); run('config', 'user.name', 'Test'); run('config', 'user.email', 'test@example.invalid'); run('add', '.'); run('commit', '-qm', 'base');
  fs.writeFileSync(path.join(root, 'app.ts'), 'export const app = 2;');
  return testProjectScope({ rootRealPath: root });
}
it('default worker regression acquires owned execution and preserves HOME until physical cleanup proof', async () => {
  const scope = project(); let report = ''; let release!: () => void;
  const proof = new Promise<void>(resolve => { release = resolve; });
  state.exec.mockImplementation(async ({ plan }) => {
    report = plan.args.find((arg: string) => arg.startsWith('--outputFile=')).slice('--outputFile='.length);
    fs.writeFileSync(report, JSON.stringify({ testResults: [{ name: path.join(scope.rootRealPath, 'app.test.ts'), status: 'passed', assertionResults: [{ status: 'passed', fullName: 'ok' }] }] }));
    return { exitCode: 0, timedOut: false, aborted: false, stdout: '', stderr: '', physicalExit: proof };
  });
  const result = await runRegressionGate({ scope });
  expect(result.status).toBe('passed'); expect(state.exec).toHaveBeenCalledOnce();
  expect(state.exec.mock.calls[0][0].request).toMatchObject({ scope, kind: 'tests' });
  expect(fs.existsSync(report)).toBe(true); release(); await proof; await Promise.resolve(); expect(fs.existsSync(report)).toBe(false);
});
it('default regression reports admission timeout as retryable, not a test failure', async () => {
  const scope = project(); state.exec.mockResolvedValue({ exitCode: null, timedOut: true, retryable: true, stdout: '', stderr: 'Aguardando recursos' });
  expect(await runRegressionGate({ scope })).toMatchObject({ status: 'unavailable', retryable: true, failures: [] });
});

it('baseline comparison timeout preserves its worktree until its runner physically exits', async () => {
  const scope = project(); const git = new ProcessGitRunner();
  const baseSha = git.run(scope.rootRealPath, ['rev-parse', 'HEAD']).stdout.trim();
  let baseRoot = ''; let release!: () => void; const proof = new Promise<void>(resolve => { release = resolve; });
  state.exec.mockImplementation(async ({ plan }) => {
    if (plan.cwd !== scope.rootRealPath) {
      baseRoot = plan.cwd;
      return { exitCode: null, timedOut: true, retryable: true, stdout: '', stderr: 'timeout', physicalExit: proof };
    }
    const report = plan.args.find((arg: string) => arg.startsWith('--outputFile=')).slice('--outputFile='.length);
    fs.writeFileSync(report, JSON.stringify({ testResults: [{ name: path.join(scope.rootRealPath, 'app.test.ts'), status: 'failed', assertionResults: [{ status: 'failed', fullName: 'app', failureMessages: ['expected value'] }] }] }));
    return { exitCode: 1, timedOut: false, stdout: '', stderr: '' };
  });
  try {
    const result = await runRegressionGate({ scope, baseSha, trustedDependencyRoot: scope.rootRealPath });
    expect(result.status).toBe('failed'); expect(result.preexistingFailures).toEqual([]);
    expect(baseRoot).not.toBe(''); expect(fs.existsSync(baseRoot)).toBe(true);
    release(); await proof; await vi.waitFor(() => expect(fs.existsSync(baseRoot)).toBe(false));
  } finally { release(); }
});
