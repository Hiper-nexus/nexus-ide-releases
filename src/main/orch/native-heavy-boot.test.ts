import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const prepare = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }));
vi.mock('../pty/pty-manager', () => ({ prepareNativeHeavyJobBase: prepare }));

import { DARWIN_NESTED_HEAVY_JOB_LAUNCH_SOURCE, DARWIN_PTY_SUPERVISOR_IDENTIFIER } from '../pty/darwin-pty-supervisor';
import { proveNativeHeavyJobBaseAtBoot } from './native-heavy-preload';

function validJobBase() {
  const helper = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-heavy-boot-')));
  const file = path.join(helper, 'helper');
  fs.writeFileSync(file, '');
  return {
    file: '/usr/bin/perl',
    args: ['-T', '-e', DARWIN_NESTED_HEAVY_JOB_LAUNCH_SOURCE, '--', '--helper', file, '--identifier', DARWIN_PTY_SUPERVISOR_IDENTIFIER,
      '--team-id', '-', '--cdhash', 'a'.repeat(40), '--timeout-seconds', '0', '--', 'heavy-job'],
  };
}

describe.runIf(process.platform === 'darwin')('native heavy-job base at boot', () => {
  afterEach(() => {
    vi.useRealTimers();
    prepare.mockReset();
  });

  it('opens the app when the PTY host misses the deadline and proves the base later', async () => {
    vi.useFakeTimers();
    prepare.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValue(validJobBase());

    await expect(proveNativeHeavyJobBaseAtBoot([10, 20, 30])).resolves.toBe(false);
    expect(prepare).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10);
    expect(prepare).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20);
    expect(prepare).toHaveBeenCalledTimes(3);
    // Provada a base, o background para de tentar.
    await vi.advanceTimersByTimeAsync(30);
    expect(prepare).toHaveBeenCalledTimes(3);
  });

  it('keeps the single boot proof when the host answers in time', async () => {
    prepare.mockResolvedValue(validJobBase());
    await expect(proveNativeHeavyJobBaseAtBoot([10])).resolves.toBe(true);
    expect(prepare).toHaveBeenCalledTimes(1);
  });
});
