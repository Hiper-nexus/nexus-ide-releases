import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const scriptPath = path.resolve('scripts/codesign-with-retry.sh');

function classify(message) {
  const source = readFileSync(scriptPath, 'utf8');
  if (!source.includes('is_retryable_timestamp_failure')) return null;
  return spawnSync(
    '/bin/bash',
    [
      '-c',
      'source "$1"; is_retryable_timestamp_failure',
      'codesign-retry-test',
      scriptPath,
    ],
    { input: message, encoding: 'utf8' },
  ).status;
}

describe('codesign timestamp retry policy', () => {
  it('retries the transient Apple secure-timestamp failure', () => {
    expect(classify('bundle.node: A timestamp was expected but was not found.\n'))
      .toBe(0);
    expect(classify('The timestamp service is not available right now.\n'))
      .toBe(0);
  });

  it('does not retry identity, entitlement, or ordinary signature failures', () => {
    expect(classify('errSecInternalComponent\n')).toBe(1);
    expect(classify('CSSMERR_TP_NOT_TRUSTED\n')).toBe(1);
    expect(classify('unrecognized blob type\n')).toBe(1);
  });

  it('removes a partial signature before retrying a timestamp failure', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'nexus-codesign-retry-test-'));
    const targetPath = path.join(tempDir, 'native.node');
    const statePath = path.join(tempDir, 'calls.log');
    const fakeCodesignPath = path.join(tempDir, 'codesign');
    const wrapperPath = path.join(tempDir, 'wrapper.sh');
    writeFileSync(targetPath, 'fixture');
    writeFileSync(
      fakeCodesignPath,
      `#!/bin/bash
printf '%s\\n' "$*" >> ${JSON.stringify(statePath)}
if [[ "$1" == "--remove-signature" ]]; then exit 0; fi
if [[ "$(wc -l < ${JSON.stringify(statePath)})" -eq 1 ]]; then
  printf '%s: A timestamp was expected but was not found.\\n' "$5" >&2
  exit 1
fi
if [[ "$(wc -l < ${JSON.stringify(statePath)})" -eq 3 ]]; then
  printf '%s: internal error in Code Signing subsystem\\n' "$5" >&2
  exit 1
fi
if [[ "$1" == "-d" ]]; then
  printf 'Timestamp=Jul 23, 2026 at 11:00:00\\n' >&2
fi
exit 0
`,
    );
    chmodSync(fakeCodesignPath, 0o755);
    const source = readFileSync(scriptPath, 'utf8')
      .replaceAll('/usr/bin/codesign', fakeCodesignPath)
      .replace('set -u', 'resolve_apple_timestamp_ipv4() { return 1; }\nset -u')
      .replace('for delay in 0 4 8 15 30 60 90 120 180 240; do', 'for delay in 0 0 0; do')
      .replace('if (( attempt < 10 )); then', 'if (( attempt < 3 )); then');
    writeFileSync(wrapperPath, source);
    chmodSync(wrapperPath, 0o755);

    const result = spawnSync(
      wrapperPath,
      ['--sign', 'fixture', '--force', '--timestamp', targetPath],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
    expect(readFileSync(statePath, 'utf8').trim().split('\n')).toEqual([
      `--sign fixture --force --timestamp ${targetPath}`,
      `--remove-signature ${targetPath}`,
      `--sign fixture --force --timestamp ${targetPath}`,
      `--remove-signature ${targetPath}`,
      `--sign fixture --force --timestamp ${targetPath}`,
      `--verify --strict ${targetPath}`,
      `-d --verbose=4 ${targetPath}`,
    ]);
  });

  it('re-signs a DMG with force instead of removing its unsupported signature', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'nexus-codesign-dmg-retry-test-'));
    const targetPath = path.join(tempDir, 'NexusIDE.dmg');
    const statePath = path.join(tempDir, 'calls.log');
    const fakeCodesignPath = path.join(tempDir, 'codesign');
    const wrapperPath = path.join(tempDir, 'wrapper.sh');
    writeFileSync(targetPath, 'fixture');
    writeFileSync(
      fakeCodesignPath,
      `#!/bin/bash
printf '%s\\n' "$*" >> ${JSON.stringify(statePath)}
if [[ "$1" == "--remove-signature" ]]; then exit 91; fi
if [[ "$1" == "--sign" && "$*" != *"--force"* ]]; then
  printf '%s: A timestamp was expected but was not found.\\n' "$5" >&2
  exit 1
fi
if [[ "$1" == "-d" ]]; then
  printf 'Timestamp=Jul 23, 2026 at 11:00:00\\n' >&2
fi
exit 0
`,
    );
    chmodSync(fakeCodesignPath, 0o755);
    const source = readFileSync(scriptPath, 'utf8')
      .replaceAll('/usr/bin/codesign', fakeCodesignPath)
      .replace('set -u', 'resolve_apple_timestamp_ipv4() { printf 17.32.213.161; }\nset -u')
      .replace('for delay in 0 4 8 15 30 60 90 120 180 240; do', 'for delay in 0 0; do')
      .replace('if (( attempt < 10 )); then', 'if (( attempt < 2 )); then');
    writeFileSync(wrapperPath, source);
    chmodSync(wrapperPath, 0o755);

    const result = spawnSync(
      wrapperPath,
      ['--sign', 'fixture', '--timestamp', targetPath],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
    expect(readFileSync(statePath, 'utf8').trim().split('\n')).toEqual([
      `--sign fixture --timestamp ${targetPath}`,
      `--sign fixture --timestamp=http://17.32.213.161/ts01 --force ${targetPath}`,
      `--verify --strict ${targetPath}`,
      `-d --verbose=4 ${targetPath}`,
    ]);
  });

  it('never accepts a zero exit unless the target verifies with a secure timestamp', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'nexus-codesign-postcondition-test-'));
    const targetPath = path.join(tempDir, 'native.node');
    const statePath = path.join(tempDir, 'calls.log');
    const attemptPath = path.join(tempDir, 'attempt');
    const fakeCodesignPath = path.join(tempDir, 'codesign');
    const wrapperPath = path.join(tempDir, 'wrapper.sh');
    writeFileSync(targetPath, 'fixture');
    writeFileSync(attemptPath, '0');
    writeFileSync(
      fakeCodesignPath,
      `#!/bin/bash
printf '%s\\n' "$*" >> ${JSON.stringify(statePath)}
if [[ "$1" == "--remove-signature" ]]; then exit 0; fi
if [[ "$1" == "--sign" ]]; then
  attempt="$(cat ${JSON.stringify(attemptPath)})"
  printf '%s' "$((attempt + 1))" > ${JSON.stringify(attemptPath)}
  exit 0
fi
if [[ "$1" == "--verify" ]]; then
  if [[ "$(cat ${JSON.stringify(attemptPath)})" -eq 1 ]]; then
    printf '%s: code object is not signed at all\\n' "$3" >&2
    exit 1
  fi
  exit 0
fi
if [[ "$1" == "-d" ]]; then
  printf 'Timestamp=Jul 23, 2026 at 11:00:00\\n' >&2
  exit 0
fi
exit 1
`,
    );
    chmodSync(fakeCodesignPath, 0o755);
    const source = readFileSync(scriptPath, 'utf8')
      .replaceAll('/usr/bin/codesign', fakeCodesignPath)
      .replace('set -u', 'resolve_apple_timestamp_ipv4() { return 1; }\nset -u')
      .replace('for delay in 0 4 8 15 30 60 90 120 180 240; do', 'for delay in 0 0; do')
      .replace('if (( attempt < 10 )); then', 'if (( attempt < 2 )); then');
    writeFileSync(wrapperPath, source);
    chmodSync(wrapperPath, 0o755);

    const result = spawnSync(
      wrapperPath,
      ['--sign', 'fixture', '--force', '--timestamp', targetPath],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
    expect(readFileSync(statePath, 'utf8').trim().split('\n')).toEqual([
      `--sign fixture --force --timestamp ${targetPath}`,
      `--verify --strict ${targetPath}`,
      `--remove-signature ${targetPath}`,
      `--sign fixture --force --timestamp ${targetPath}`,
      `--verify --strict ${targetPath}`,
      `-d --verbose=4 ${targetPath}`,
    ]);
  });
});

describe('Apple timestamp IPv4 transport fallback', () => {
  function prepare(args, resolution = '17.32.213.161') {
    return spawnSync('/bin/bash', ['-c', `
      source "$1"
      tsa_test_resolution="$2"
      resolve_apple_timestamp_ipv4() { printf '%s' "$tsa_test_resolution"; }
      command_args=("\${@:3}")
      prefer_apple_timestamp_ipv4 || true
      printf '%s\\n' "\${command_args[@]}"
    `, 'tsa-test', scriptPath, resolution, ...args], { encoding: 'utf8' }).stdout.trim().split('\n');
  }
  it.each([{ timestamp: [] }, { timestamp: ['--timestamp'] }, { timestamp: ['--timestamp=http://timestamp.apple.com/ts01'] }])('pins only Apple default timestamp requests to its resolved IPv4 ($timestamp)', ({ timestamp }) => {
    expect(prepare(['--sign', 'fixture', ...timestamp, '/tmp/target.dmg']))
      .toEqual(['--sign', 'fixture', '--timestamp=http://17.32.213.161/ts01', '/tmp/target.dmg']);
  });
  it.each(['--timestamp=none', '--timestamp=http://custom.example/tsa'])('preserves explicit caller timestamp policy %s', (timestamp) => {
    const args = ['--sign', 'fixture', timestamp, '/tmp/target.dmg'];
    expect(prepare(args)).toEqual(args);
  });
  it('does not add signing arguments to verification commands', () => {
    const args = ['--verify', '--strict', '/tmp/target.dmg'];
    expect(prepare(args)).toEqual(args);
  });
  it('preserves the original request when DNS supplies no IPv4', () => {
    const args = ['--sign', 'fixture', '--timestamp', '/tmp/target.dmg'];
    expect(prepare(args, '')).toEqual(args);
  });
});

function requestsSecureTimestamp(args) {
  return spawnSync(
    '/bin/bash',
    [
      '-c',
      'source "$1"; shift; requests_secure_timestamp "$@"',
      'codesign-retry-ts-policy',
      scriptPath,
      ...args,
    ],
    { encoding: 'utf8' },
  ).status;
}

describe('ad-hoc codesign never requires Apple TSA (F-609)', () => {
  it('does not demand a secure timestamp for --sign -', () => {
    expect(
      requestsSecureTimestamp(['--force', '--deep', '--sign', '-', '/tmp/Redline.app']),
    ).toBe(1);
    expect(
      requestsSecureTimestamp(['--sign', 'Developer ID Application: Example', '/tmp/app']),
    ).toBe(0);
    expect(
      requestsSecureTimestamp([
        '--sign',
        'Developer ID Application: Example',
        '--timestamp=none',
        '/tmp/app',
      ]),
    ).toBe(1);
  });

  it('accepts a zero-exit ad-hoc sign that has no Timestamp= field', () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'nexus-codesign-adhoc-test-'));
    const targetPath = path.join(tempDir, 'Nexus Redline.app');
    const statePath = path.join(tempDir, 'calls.log');
    const fakeCodesignPath = path.join(tempDir, 'codesign');
    const wrapperPath = path.join(tempDir, 'wrapper.sh');
    writeFileSync(targetPath, 'fixture');
    writeFileSync(
      fakeCodesignPath,
      `#!/bin/bash
printf '%s\\n' "$*" >> ${JSON.stringify(statePath)}
if [[ "$1" == "-d" ]]; then
  printf 'Signature=adhoc\\n' >&2
  exit 0
fi
exit 0
`,
    );
    chmodSync(fakeCodesignPath, 0o755);
    const source = readFileSync(scriptPath, 'utf8')
      .replaceAll('/usr/bin/codesign', fakeCodesignPath)
      .replace('set -u', 'resolve_apple_timestamp_ipv4() { return 1; }\nset -u')
      .replace('for delay in 0 4 8 15 30 60 90 120 180 240; do', 'for delay in 0; do')
      .replace('if (( attempt < 10 )); then', 'if (( attempt < 1 )); then');
    writeFileSync(wrapperPath, source);
    chmodSync(wrapperPath, 0o755);

    const result = spawnSync(
      wrapperPath,
      ['--force', '--deep', '--sign', '-', targetPath],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
    expect(result.stderr ?? '').not.toMatch(/secure timestamp/);
    expect(readFileSync(statePath, 'utf8').trim().split('\n')).toEqual([
      `--force --deep --sign - ${targetPath}`,
      `--verify --strict ${targetPath}`,
    ]);
  });
});
