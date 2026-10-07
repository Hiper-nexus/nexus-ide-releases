import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('./native-regression-command', () => ({ prepareNativeRegressionCommand: async (kind: string, _cwd: string, _sandbox: string, env: NodeJS.ProcessEnv) => ({ file: kind, env, extraReadPaths: [] }) }));
import { ProcessGitRunner } from '../runtime/git-command';
import { testProjectScope } from '../orch/__tests__/scope-fixture';
import { runRegressionGate, __resetRegressionGateForTests, type RegressionExec } from './regression-gate';
const roots: string[] = [];
afterEach(() => { __resetRegressionGateForTests(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function project(kind: 'go' | 'cargo') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-regression-'))); roots.push(root);
  const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); };
  if (kind === 'go') { write('go.mod', 'module example/app\n\ngo 1.22\n'); write('app.go', 'package app\nfunc App() int { return 1 }\n'); write('app_test.go', 'package app\n'); }
  else { write('Cargo.toml', '[package]\nname="app"\nversion="0.1.0"\nedition="2021"\n'); write('src/lib.rs', '#[test]\nfn works() {}\n'); }
  const git = new ProcessGitRunner(); const run = (...args: string[]) => git.run(root, args).stdout.trim();
  run('init', '-q'); run('config', 'user.name', 'Test'); run('config', 'user.email', 'test@example.invalid'); run('add', '.'); run('commit', '-qm', 'base');
  const baseSha = run('rev-parse', 'HEAD'); write(kind === 'go' ? 'app.go' : 'src/lib.rs', kind === 'go' ? 'package app\nfunc App() int { return 2 }\n' : '#[test]\nfn works() { assert!(true) }\n');
  return { scope: testProjectScope({ rootRealPath: root }), baseSha, root, write };
}
const goOutput = (status = 'pass', name = 'TestApp') => [
  { Action: 'run', Package: 'example/app', Test: name }, { Action: status, Package: 'example/app', Test: name }, { Action: status, Package: 'example/app' },
].map(event => JSON.stringify(event)).join('\n');
const rustOutput = (fail = false) => `running 1 test\ntest works ... ${fail ? 'FAILED' : 'ok'}\n\ntest result: ${fail ? 'FAILED' : 'ok'}. ${fail ? 0 : 1} passed; ${fail ? 1 : 0} failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n`;
const result = (stdout: string, exitCode = 0) => ({ stdout, stderr: '', exitCode, timedOut: false });
const noRisk = async () => null;
it.each(['go', 'cargo'] as const)('runs the full %s suite through the existing gate and returns real case IDs', async kind => {
  const p = project(kind); const exec = vi.fn<RegressionExec>(async () => result(kind === 'go' ? goOutput() : rustOutput()));
  const checked = await runRegressionGate({ scope: p.scope, baseSha: p.baseSha }, { exec, businessRisk: noRisk });
  expect(checked.status).toBe('passed'); expect(checked.runner).toBe(kind);
  expect(checked.testsRun).toContain(kind === 'go' ? 'go:example/app/TestApp' : 'rust:works');
  expect(exec).toHaveBeenCalledOnce(); expect(exec.mock.calls[0][1]).toContain(kind === 'go' ? './...' : '--workspace');
});
it('zero native tests and Cargo compilation alone remain unavailable', async () => {
  for (const kind of ['go', 'cargo'] as const) {
    const p = project(kind); const stdout = kind === 'go' ? JSON.stringify({ Action: 'pass', Package: 'example/app' }) : '{"reason":"build-finished","success":true}';
    const checked = await runRegressionGate({ scope: p.scope }, { exec: async () => result(stdout), businessRisk: noRisk });
    expect(checked.status).toBe('unavailable'); expect(checked.testsRun).toEqual([]);
  }
});
it('native timeout stays retryable without manufacturing failures', async () => {
  const p = project('go'); const checked = await runRegressionGate({ scope: p.scope }, { businessRisk: noRisk,
    exec: async () => ({ ...result(''), exitCode: null, timedOut: true, retryable: true }),
  });
  expect(checked).toMatchObject({ status: 'unavailable', retryable: true, failures: [] });
});
it.each(['go', 'cargo'] as const)('F246 uses proven Go package identity and never waives unbound %s target names', async kind => {
  const p = project(kind); const exec = vi.fn<RegressionExec>(async () => result(kind === 'go' ? goOutput('fail') : rustOutput(true), kind === 'go' ? 1 : 101));
  const checked = await runRegressionGate({ scope: p.scope, baseSha: p.baseSha }, { exec, businessRisk: noRisk });
  if (kind === 'cargo') {
    expect(exec).toHaveBeenCalledOnce(); expect(checked.status).toBe('failed'); expect(checked.preexistingFailures).toEqual([]);
    expect(checked.warnings.join(' ')).toContain('identidade inequívoca de crate/alvo');
  } else {
    expect(exec).toHaveBeenCalledTimes(2); expect(checked.status).toBe('passed'); expect(checked.failures).toEqual([]);
    expect(checked.preexistingFailures.map(f => f.file)).toEqual(['go:example/app/TestApp']);
    expect(exec.mock.calls[1][2].cwd).not.toBe(p.root); expect(fs.existsSync(exec.mock.calls[1][2].cwd)).toBe(false);
  }
});
it('another failing case on the base cannot excuse the candidate failure', async () => {
  const p = project('go'); const exec: RegressionExec = async (_file, _args, options) => result(goOutput('fail', options.cwd === p.root ? 'TestNew' : 'TestOld'), 1);
  const checked = await runRegressionGate({ scope: p.scope, baseSha: p.baseSha }, { exec, businessRisk: noRisk });
  expect(checked.status).toBe('failed'); expect(checked.preexistingFailures).toEqual([]); expect(checked.failures[0].file).toBe('go:example/app/TestNew');
});
it('native execution cannot approve a candidate changed during the test', async () => {
  const p = project('go');
  const checked = await runRegressionGate({ scope: p.scope }, { businessRisk: noRisk, exec: async () => { p.write('app.go', 'package app\nfunc App() int { return 9 }'); return result(goOutput()); } });
  expect(checked.status).toBe('unavailable');
});

it('runs nested Go modules rather than pretending root ./... covers them', async () => {
  const p = project('go'); p.write('server/go.mod', 'module example/server\ngo 1.22\n'); p.write('server/main_test.go', 'package server\n');
  const exec = vi.fn<RegressionExec>(async () => result(goOutput()));
  const checked = await runRegressionGate({ scope: p.scope }, { exec, businessRisk: noRisk });
  expect(checked.status).toBe('passed'); expect(exec.mock.calls.map(call => call[2].cwd)).toEqual([p.root, path.join(p.root, 'server')]);
  expect(checked.testsRun).toContain('server::go:example/app/TestApp');
});
it('custom Cargo harness is unavailable without claiming another passing target covers it', async () => {
  const p = project('cargo');
  p.write('Cargo.toml', 'test=[{name="custom",harness=false}]\n[package]\nname="app"\nversion="0.1.0"\n');
  const exec = vi.fn<RegressionExec>(async () => result(rustOutput()));
  const checked = await runRegressionGate({ scope: p.scope }, { exec, businessRisk: noRisk });
  expect(checked.status).toBe('unavailable'); expect(exec).not.toHaveBeenCalled();
});
it('a lockfile generated during Cargo testing invalidates the receipt until the next candidate', async () => {
  const p = project('cargo'); const checked = await runRegressionGate({ scope: p.scope }, { businessRisk: noRisk,
    exec: async () => { p.write('Cargo.lock', '# generated\nversion = 3\n'); return result(rustOutput()); },
  });
  expect(checked).toMatchObject({ status: 'unavailable', retryable: true });
});
it('passing native tests cannot hide a failing JavaScript suite in a mixed project', async () => {
  const p = project('go'); p.write('package.json', '{"devDependencies":{"vitest":"*"}}');
  p.write('node_modules/.bin/vitest', '#!/bin/sh\n'); p.write('.gitignore', 'node_modules\n');
  p.write('app.ts', 'export const a=1;'); p.write('app.test.ts', "import {a} from './app';");
  const exec: RegressionExec = async (file, args, options) => {
    if (file === 'go') return result(goOutput());
    const outFile = args.find(arg => arg.startsWith('--outputFile='))!.slice('--outputFile='.length);
    fs.writeFileSync(outFile, JSON.stringify({ testResults: [{ name: path.join(options.cwd, 'app.test.ts'), status: 'failed', assertionResults: [{ status: 'failed', fullName: 'js', failureMessages: ['actual JS failure'] }] }] }));
    return result('', 1);
  };
  const checked = await runRegressionGate({ scope: p.scope }, { exec, businessRisk: noRisk });
  expect(checked.status).toBe('failed'); expect(checked.testsRun).toContain('go:example/app/TestApp'); expect(checked.failures.some(f => f.file === 'app.test.ts')).toBe(true);
});

it('a truncated native stream cannot certify even a syntactically complete passing prefix', async () => {
  const p = project('go'); const checked = await runRegressionGate({ scope: p.scope }, { businessRisk: noRisk,
    exec: async () => ({ ...result(goOutput()), outputTruncated: true }),
  });
  expect(checked.status).toBe('unavailable'); expect(checked.testsRun).toEqual([]);
});

it('does not omit a changed native module under an orientation-excluded build directory', async () => {
  const p = project('go'); p.write('build/sub/go.mod', 'module example/sub\ngo 1.22\n');
  p.write('build/sub/app.go', 'package sub\n'); p.write('build/sub/app_test.go', 'package sub\n');
  const git = new ProcessGitRunner(); git.run(p.root, ['add', 'build']); git.run(p.root, ['commit', '-qm', 'nested module']);
  p.write('build/sub/app.go', 'package sub\nfunc Value() int { return 2 }\n');
  const exec = vi.fn<RegressionExec>(async () => result(goOutput()));
  const checked = await runRegressionGate({ scope: p.scope }, { exec, businessRisk: noRisk });
  expect(checked.status).toBe('passed');
  expect(exec.mock.calls.map(call => call[2].cwd)).toContain(path.join(p.root, 'build/sub'));
  expect(checked.testsRun).toContain('build/sub::go:example/app/TestApp');
});

it('unrelated committed native fixtures are not new project test obligations', async () => {
  const p = project('go'); p.write('testdata/broken/go.mod', 'module broken\n'); p.write('testdata/broken/main.go', 'intentionally broken');
  const git = new ProcessGitRunner(); git.run(p.root, ['add', 'testdata']); git.run(p.root, ['commit', '-qm', 'fixture only']);
  const exec = vi.fn<RegressionExec>(async () => result(goOutput()));
  const checked = await runRegressionGate({ scope: p.scope }, { exec, businessRisk: noRisk });
  expect(checked.status).toBe('passed'); expect(exec).toHaveBeenCalledOnce(); expect(exec.mock.calls[0][2].cwd).toBe(p.root);
});
it('a proved zero-test module reports no-tests, never passed or an obligation to invent tests', async () => {
  const p = project('go'); fs.unlinkSync(path.join(p.root, 'app_test.go'));
  const checked = await runRegressionGate({ scope: p.scope }, { businessRisk: noRisk,
    exec: async () => result(JSON.stringify({ Action: 'skip', Package: 'example/app' })),
  });
  expect(checked.status).toBe('no-tests'); expect(checked.testsRun).toEqual([]); expect(checked.coverage?.indexComplete).toBe(true);
});
it('GoWork libraries with no tests do not invalidate the module with executed tests', async () => {
  const p = project('go'); p.write('go.work', 'go 1.22\nuse (\n.\n./lib\n)\n');
  p.write('lib/go.mod', 'module example/lib\ngo 1.22\n'); p.write('lib/lib.go', 'package lib\n');
  const exec: RegressionExec = async (_file, _args, options) => result(options.cwd === p.root ? goOutput() : JSON.stringify({ Action: 'skip', Package: 'example/lib' }));
  const checked = await runRegressionGate({ scope: p.scope }, { exec, businessRisk: noRisk });
  expect(checked.status).toBe('passed'); expect(checked.testsRun).toEqual(['go:example/app/TestApp']);
});
it('a GoWork-only root discovers scoped modules without any root go.mod', async () => {
  const p = project('go'); fs.unlinkSync(path.join(p.root, 'go.mod')); fs.unlinkSync(path.join(p.root, 'app.go')); fs.unlinkSync(path.join(p.root, 'app_test.go'));
  p.write('go.work', 'go 1.22\nuse ./module\n'); p.write('module/go.mod', 'module example/module\ngo 1.22\n'); p.write('module/module_test.go', 'package module\n');
  const exec = vi.fn<RegressionExec>(async () => result(goOutput()));
  const checked = await runRegressionGate({ scope: p.scope }, { exec, businessRisk: noRisk });
  expect(checked.status).toBe('passed'); expect(exec).toHaveBeenCalledOnce(); expect(exec.mock.calls[0][2].cwd).toBe(path.join(p.root, 'module'));
});

it('an invalid GoWork-only root cannot fall back to no-tests when discovery rejects its scope', async () => {
  const p = project('go'); fs.unlinkSync(path.join(p.root, 'go.mod')); fs.unlinkSync(path.join(p.root, 'app.go')); fs.unlinkSync(path.join(p.root, 'app_test.go'));
  p.write('go.work', 'go 1.22\nuse ../outside\n');
  const exec = vi.fn<RegressionExec>(async () => result(goOutput()));
  const checked = await runRegressionGate({ scope: p.scope }, { exec, businessRisk: noRisk });
  expect(checked.status).toBe('unavailable'); expect(checked.coverage?.indexComplete).toBe(false); expect(exec).not.toHaveBeenCalled();
});

it('a zero-test root Go module does not borrow its child GoWork module test obligation', async () => {
  const p = project('go'); fs.unlinkSync(path.join(p.root, 'app_test.go'));
  p.write('go.work', 'go 1.22\nuse (\n.\n./lib\n)\n');
  p.write('lib/go.mod', 'module example/lib\ngo 1.22\n'); p.write('lib/lib_test.go', 'package lib\n');
  const exec: RegressionExec = async (_file, _args, options) => result(options.cwd === p.root ? JSON.stringify({ Action: 'skip', Package: 'example/app' }) : goOutput());
  const checked = await runRegressionGate({ scope: p.scope }, { exec, businessRisk: noRisk });
  expect(checked.status).toBe('passed'); expect(checked.testsRun).toEqual(['lib::go:example/app/TestApp']);
  expect(checked.testsNotRun).toEqual([]);
});
it('a zero-test Cargo crate does not borrow tests from an unselected fixture crate', async () => {
  const p = project('cargo'); p.write('src/lib.rs', 'pub fn value() -> u8 { 1 }\n');
  p.write('fixtures/child/Cargo.toml', '[package]\nname="fixture"\nversion="0.1.0"\n');
  p.write('fixtures/child/src/lib.rs', '#[test]\nfn fixture_test() {}\n');
  const git = new ProcessGitRunner(); git.run(p.root, ['add', 'fixtures']); git.run(p.root, ['commit', '-qm', 'fixture crate']);
  const exec = vi.fn<RegressionExec>(async () => result('{"reason":"build-finished","success":true}\nrunning 0 tests\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n'));
  const checked = await runRegressionGate({ scope: p.scope }, { exec, businessRisk: noRisk });
  expect(checked.status).toBe('no-tests'); expect(checked.testsRun).toEqual([]); expect(exec).toHaveBeenCalledOnce();
});
it('zero Cargo execution cannot exempt a declared workspace member that has tests', async () => {
  const p = project('cargo'); p.write('Cargo.toml', '[workspace]\nmembers=["member"]\n');
  p.write('src/lib.rs', 'pub fn value() -> u8 { 1 }\n');
  p.write('member/Cargo.toml', '[package]\nname="member"\nversion="0.1.0"\n'); p.write('member/src/lib.rs', '#[test]\nfn member_test() {}\n');
  const exec = vi.fn<RegressionExec>(async () => result('{"reason":"build-finished","success":true}\nrunning 0 tests\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n'));
  const checked = await runRegressionGate({ scope: p.scope }, { exec, businessRisk: noRisk });
  expect(checked.status).toBe('unavailable'); expect(checked.testsRun).toEqual([]); expect(exec).toHaveBeenCalledOnce();
});

it('empty integration targets are required relative to their owning Cargo workspace member', async () => {
  const p = project('cargo'); p.write('Cargo.toml', '[workspace]\nmembers=["member"]\n');
  p.write('src/lib.rs', 'pub fn value() -> u8 { 1 }\n');
  p.write('member/Cargo.toml', '[package]\nname="member"\nversion="0.1.0"\n');
  p.write('member/src/lib.rs', 'pub fn value() -> u8 { 1 }\n');
  p.write('member/tests/contract.rs', 'fn helper_without_test_attribute() {}\n');
  const exec = vi.fn<RegressionExec>(async () => result('{"reason":"build-finished","success":true}\nrunning 0 tests\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n'));
  const checked = await runRegressionGate({ scope: p.scope }, { exec, businessRisk: noRisk });
  expect(checked.status).toBe('unavailable'); expect(checked.testsRun).toEqual([]); expect(exec).toHaveBeenCalledOnce();
});
