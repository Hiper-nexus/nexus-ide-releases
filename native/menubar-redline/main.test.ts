import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

it.skipIf(process.platform !== 'darwin')('keeps Redline readable and every account reachable in a bounded vertical panel', () => {
  const directory = mkdtempSync(join(tmpdir(), 'redline-ui-test-'));
  try {
    const root = 'native/menubar-redline';
    // Compile the real AppKit sources — every one the app ships, in the same
    // order the build script uses — without starting the event loop.
    const sources = readdirSync(root)
      .filter((name) => name.endsWith('.swift') && !name.endsWith('.test.swift'))
      .sort()
      .map((name) => {
        const code = readFileSync(`${root}/${name}`, 'utf8');
        return name === 'main.swift' ? code.split('// MARK: - Bootstrap')[0] : code;
      });
    const spec = readFileSync(`${root}/main.test.swift`, 'utf8');
    writeFileSync(join(directory, 'main.swift'), `${sources.join('\n')}\n${spec}`);
    const binary = join(directory, 'redline-ui-test');
    execFileSync('swiftc', ['-swift-version', '5', '-target', 'arm64-apple-macosx14.0', join(directory, 'main.swift'), '-o', binary], { timeout: 120_000 });
    // No .app around the probe, so point it at the committed companion assets.
    const output = execFileSync(binary, {
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...process.env, REDLINE_ASSETS_DIR: resolve(root, 'assets') },
    });
    expect(output).toContain('Redline UI checks passed');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
