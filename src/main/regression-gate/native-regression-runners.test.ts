import { expect, it } from 'vitest';
import { nativeRegressionArgs, parseGoTestEvents, parseRustTestOutput } from './native-regression-runners';
const events = (...rows: object[]) => rows.map(row => JSON.stringify(row)).join('\n');
const go = (action: string, test?: string) => ({ Action: action, Package: 'example/app', ...(test ? { Test: test } : {}) });
it('Go requires actual run/completion events and a successful package/process', () => {
  expect(parseGoTestEvents(events(go('start'), go('run', 'TestApp'), go('pass', 'TestApp'), go('pass')), 0)).toMatchObject({ complete: true, ran: ['go:example/app/TestApp'], failures: [] });
  for (const output of [events(go('pass')), events(go('run', 'TestApp')), events(go('pass', 'TestApp'), go('pass')), events({ ...go('output'), Output: 'PASS' })]) {
    expect(parseGoTestEvents(output, 0).complete).toBe(false);
  }
});
it('Go reports exact failing cases, skips and build failure without inventing tests', () => {
  expect(parseGoTestEvents(events(go('run', 'TestApp'), go('fail', 'TestApp'), go('fail')), 1).failures).toEqual([{ file: 'go:example/app/TestApp', message: 'Go: TestApp falhou.' }]);
  expect(parseGoTestEvents(events(go('run', 'TestApp'), go('skip', 'TestApp'), go('pass')), 0)).toMatchObject({ complete: false, skipped: ['go:example/app/TestApp'] });
  expect(parseGoTestEvents(events(go('start'), { ...go('fail'), FailedBuild: 'example/app' }), 1)).toMatchObject({ complete: false, ran: [] });
});
it('Go refuses malformed/truncated JSON, unfinished packages, and wrong process status', () => {
  const valid = events(go('run', 'TestApp'), go('pass', 'TestApp'), go('pass'));
  expect(parseGoTestEvents(valid + '\n{', 0).complete).toBe(false);
  expect(parseGoTestEvents(valid, null).complete).toBe(false);
  expect(parseGoTestEvents(valid, 1).complete).toBe(false);
  expect(parseGoTestEvents(events(go('run', 'TestApp'), go('pass', 'TestApp')), 0).complete).toBe(false);
});
const rust = (status = 'ok', count = 1) => `running ${count} test\ntest app::works ... ${status}\n\ntest result: ${status === 'ok' ? 'ok' : 'FAILED'}. ${status === 'ok' ? 1 : 0} passed; ${status === 'ok' ? 0 : 1} failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n`;
it('Rust proves stable libtest execution, never Cargo build-finished', () => {
  expect(parseRustTestOutput(rust(), 0)).toMatchObject({ complete: true, ran: ['rust:app::works'], failures: [] });
  expect(parseRustTestOutput('{"reason":"build-finished","success":true}\n', 0).complete).toBe(false);
  expect(parseRustTestOutput(rust('FAILED'), 101).failures).toEqual([{ file: 'rust:app::works', message: 'Rust: app::works falhou.' }]);
});
it('Rust rejects incomplete/zero/mismatched/skipped reports and extra custom harness binaries', () => {
  for (const output of [rust().split('test result:')[0], rust('ok', 2), 'running 0 tests\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n', rust().replace('0 filtered out', '1 filtered out')]) {
    expect(parseRustTestOutput(output, 0).complete).toBe(false);
  }
  const artifacts = ['one', 'two'].map(executable => JSON.stringify({ reason: 'compiler-artifact', profile: { test: true }, executable })).join('\n');
  expect(parseRustTestOutput(artifacts + '\n' + rust(), 0).complete).toBe(false);
});
it('duplicate Rust names cannot be used as baseline failure identity', () => {
  const parsed = parseRustTestOutput(rust('FAILED') + rust('FAILED'), 101);
  expect(parsed.failures).toHaveLength(2); expect(parsed.failures.every(f => f.file.startsWith('(rust ambiguous)'))).toBe(true);
});
it('native plans serialize CPU and rerun tests without demanding a new lockfile', () => {
  expect(nativeRegressionArgs('go', false)).toEqual(['test', '-json', '-count=1', '-p=1', '-parallel=1', './...']);
  expect(nativeRegressionArgs('cargo', false)).not.toContain('--locked');
  expect(nativeRegressionArgs('cargo', true)).toContain('--locked');
  expect(nativeRegressionArgs('cargo', false)).toContain('--workspace');
  expect(nativeRegressionArgs('cargo', false)).not.toContain('--no-run');
});

import { cargoRegressionWorkspaces } from './native-regression-runners';
it('deduplicates declared Cargo members but still runs excluded independent crates', () => {
  expect(cargoRegressionWorkspaces(new Map([
    ['Cargo.toml', '[workspace]\nmembers=["crates/*"]\nexclude=["crates/solo"]\n'],
    ['crates/a/Cargo.toml', '[package]\nname="a"\n'],
    ['crates/solo/Cargo.toml', '[package]\nname="solo"\n'],
  ]))).toMatchObject({ roots: ['Cargo.toml', 'crates/solo/Cargo.toml'], unsupported: [] });
});
it('rejects custom inline harness and external workspace members without matching comments', () => {
  expect(cargoRegressionWorkspaces(new Map([['Cargo.toml', 'test=[{name="custom",harness=false}]']])).unsupported).toContain('Cargo.toml');
  expect(cargoRegressionWorkspaces(new Map([['Cargo.toml', '[workspace]\nmembers=["../other"]']])).unsupported).toContain('Cargo.toml');
  expect(cargoRegressionWorkspaces(new Map([['Cargo.toml', '# harness=false\n[package]\nname="valid"']])).unsupported).toEqual([]);
});

import { isNativeContainerCommand } from './native-regression-runners';
it('Windows OCI only accepts the fixed Main native env and exact suite arguments', () => {
  const args = ['CARGO_HOME=/nexus-runtime/native/cargo', 'CARGO_BUILD_JOBS=1', 'cargo', ...nativeRegressionArgs('cargo', false)];
  expect(isNativeContainerCommand('env', args, 'cargo')).toBe(true);
  expect(isNativeContainerCommand('env', ['LD_PRELOAD=/nexus-runtime/evil', ...args], 'cargo')).toBe(false);
  expect(isNativeContainerCommand('env', args.concat('--nocapture'), 'cargo')).toBe(false);
  expect(isNativeContainerCommand('env', ['CARGO_HOME=/nexus-runtime/../../secret', 'cargo', ...nativeRegressionArgs('cargo', false)], 'cargo')).toBe(false);
});

it('a custom benchmark excluded from cargo test is not an unverified test harness', () => {
  expect(cargoRegressionWorkspaces(new Map([['Cargo.toml', '[package]\nname="app"\n[[bench]]\nname="performance"\nharness=false']])).unsupported).toEqual([]);
  expect(cargoRegressionWorkspaces(new Map([['Cargo.toml', '[package]\nname="app"\n[[bench]]\nname="performance"\nharness=false\ntest=true']])).unsupported).toEqual(['Cargo.toml']);
});

it('absolute workspace member paths cannot become relative through normalization', () => {
  expect(cargoRegressionWorkspaces(new Map([['Cargo.toml', '[workspace]\nmembers=["/tmp/external"]']])).unsupported).toEqual(['Cargo.toml']);
});
it('Rust doctest blocks cannot hide an unreported custom test binary', () => {
  const artifacts = ['one', 'two'].map(executable => JSON.stringify({ reason: 'compiler-artifact', profile: { test: true }, executable })).join('\n');
  expect(parseRustTestOutput(artifacts + '\n' + rust() + rust(), 0, '   Doc-tests library\n').complete).toBe(false);
});
