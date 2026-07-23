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
      .replace('for delay in 0 4 8 15 30 60 90; do', 'for delay in 0 0 0; do')
      .replace('if (( attempt < 7 )); then', 'if (( attempt < 3 )); then');
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
      .replace('for delay in 0 4 8 15 30 60 90; do', 'for delay in 0 0; do')
      .replace('if (( attempt < 7 )); then', 'if (( attempt < 2 )); then');
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
