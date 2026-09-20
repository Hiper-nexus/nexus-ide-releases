import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it.skipIf(process.platform !== 'darwin')('keeps Redline readable and every account reachable in a bounded vertical panel', () => {
  const directory = mkdtempSync(join(tmpdir(), 'redline-ui-test-'));
  try {
    const root = 'native/menubar-redline';
    // Compile the actual AppKit implementation without starting its event loop.
    const app = readFileSync(`${root}/main.swift`, 'utf8').split('// MARK: - Bootstrap')[0];
    const panel = existsSync(`${root}/quota-panel.swift`)
      ? readFileSync(`${root}/quota-panel.swift`, 'utf8') : '';
    writeFileSync(join(directory, 'main.swift'), `${app}\n${panel}\n${readFileSync(`${root}/main.test.swift`, 'utf8')}`);
    const binary = join(directory, 'redline-ui-test');
    execFileSync('swiftc', ['-swift-version', '5', join(directory, 'main.swift'), '-o', binary], { timeout: 60_000 });
    expect(execFileSync(binary, { encoding: 'utf8', timeout: 20_000 })).toContain('Redline UI checks passed');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 90_000);
