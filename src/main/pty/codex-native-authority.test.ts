import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  codexGovernedSandboxLaunchMode,
  sealCodexPrivateProcessEnvironment,
} from './codex-native-authority';

const roots: string[] = [];

function tempRuntime(): {
  sandboxDir: string;
  processHome: string;
  processTmp: string;
} {
  const sandboxDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'nexus-codex-native-authority-'),
  );
  roots.push(sandboxDir);
  const processHome = path.join(sandboxDir, 'home');
  const processTmp = path.join(sandboxDir, 'tmp');
  fs.mkdirSync(processHome);
  fs.mkdirSync(processTmp);
  return { sandboxDir, processHome, processTmp };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('Codex governed native authority', () => {
  it('always uses the Nexus-owned outer process sandbox', () => {
    expect(codexGovernedSandboxLaunchMode('darwin')).toBe('outer-process');
    expect(codexGovernedSandboxLaunchMode('linux')).toBe('outer-process');
    expect(codexGovernedSandboxLaunchMode('win32')).toBe('outer-process');
  });

  it('pins HOME and every temp alias to the private runtime', () => {
    const runtime = tempRuntime();
    const sealed = sealCodexPrivateProcessEnvironment(
      { HOME: '/Users/operator', TMPDIR: '/private/tmp', PATH: '/bin' },
      runtime,
    );

    expect(sealed).toMatchObject({
      HOME: fs.realpathSync(runtime.processHome),
      TMPDIR: fs.realpathSync(runtime.processTmp),
      TMP: fs.realpathSync(runtime.processTmp),
      TEMP: fs.realpathSync(runtime.processTmp),
      PATH: '/bin',
    });
  });

  it('fails closed when HOME resolves outside the private runtime', () => {
    const runtime = tempRuntime();
    const outside = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nexus-codex-native-outside-'),
    );
    roots.push(outside);
    const escapedHome = path.join(runtime.sandboxDir, 'escaped-home');
    fs.symlinkSync(outside, escapedHome);

    expect(() =>
      sealCodexPrivateProcessEnvironment(
        {},
        { ...runtime, processHome: escapedHome },
      ),
    ).toThrow(/escapes its runtime directory/i);
  });
});
