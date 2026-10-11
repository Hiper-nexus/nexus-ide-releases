import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// F-1184: the heavy-command guard is sourced into every shell of an agent
// pane (BASH_ENV / ZDOTDIR). It must not break the caller's own script.
const resources = path.join(process.cwd(), 'resources/heavy-command');
const guardEnv = (extra: Record<string, string> = {}) => ({
  PATH: '/usr/bin:/bin',
  HOME: os.tmpdir(),
  // Admission armed; the commands below are not heavy, so no request is made.
  NEXUS_HEAVY_COMMAND_URL: 'http://127.0.0.1:9/hook/heavy-command',
  NEXUS_GATE_TOKEN: 'strict-mode-fixture',
  ...extra,
});
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('F-1184: heavy shell guard under strict mode', () => {
  it('a bash script with set -euo pipefail runs every line', () => {
    const run = spawnSync('/bin/bash', ['-c', 'set -euo pipefail; echo one; echo two'], {
      env: guardEnv({ BASH_ENV: path.join(resources, 'shell.bash') }),
      encoding: 'utf8',
    });
    expect(run.stderr).toBe('');
    expect(run.stdout).toBe('one\ntwo\n');
    expect(run.status).toBe(0);
  });

  it('bash started with -u sources the guard cleanly', () => {
    const run = spawnSync('/bin/bash', ['-u', '-c', 'echo ok'], {
      env: guardEnv({ BASH_ENV: path.join(resources, 'shell.bash') }),
      encoding: 'utf8',
    });
    expect(run.stderr).toBe('');
    expect(run.stdout).toBe('ok\n');
    expect(run.status).toBe(0);
  });

  it('zsh loading the guard twice, with nounset, neither recurses nor complains', () => {
    const zdotdir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-heavy-zsh-'));
    dirs.push(zdotdir);
    const guard = path.join(resources, 'shell.zsh');
    const run = spawnSync('/bin/zsh', ['-c', `source ${JSON.stringify(guard)}; source ${JSON.stringify(guard)}; setopt nounset; echo one`], {
      env: guardEnv({ ZDOTDIR: zdotdir }),
      encoding: 'utf8',
    });
    expect(run.stderr).toBe('');
    expect(run.stdout).toBe('one\n');
    expect(run.status).toBe(0);
  });
});
