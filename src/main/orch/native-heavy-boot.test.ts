import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const prepare = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }));
vi.mock('../pty/pty-manager', () => ({ prepareNativeHeavyJobBase: prepare }));

import { DARWIN_NESTED_HEAVY_JOB_LAUNCH_SOURCE, DARWIN_PTY_SUPERVISOR_IDENTIFIER } from '../pty/darwin-pty-supervisor';

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

// Estado do módulo (base provada, falha de boot) recomeça em cada caso.
const freshPreload = () => import('./native-heavy-preload');

describe.runIf(process.platform === 'darwin')('native heavy-job base at boot', () => {
  beforeEach(() => {
    vi.resetModules();
    prepare.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens the app when the PTY host misses the deadline and keeps proving until it succeeds', async () => {
    vi.useFakeTimers();
    const { proveNativeHeavyJobBaseAtBoot } = await freshPreload();
    prepare.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(null)
      .mockResolvedValue(validJobBase());

    await expect(proveNativeHeavyJobBaseAtBoot([10, 20])).resolves.toBe(false);
    expect(prepare).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10);
    expect(prepare).toHaveBeenCalledTimes(2);
    // Esgotada a lista, o último intervalo se repete até provar.
    await vi.advanceTimersByTimeAsync(20);
    expect(prepare).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(20);
    expect(prepare).toHaveBeenCalledTimes(4);
    // Provada a base, o background para de tentar.
    await vi.advanceTimersByTimeAsync(100);
    expect(prepare).toHaveBeenCalledTimes(4);
  });

  it('keeps the single boot proof when the host answers in time', async () => {
    const { proveNativeHeavyJobBaseAtBoot, ensureNativeHeavyJobBase } = await freshPreload();
    prepare.mockResolvedValue(validJobBase());
    await expect(proveNativeHeavyJobBaseAtBoot([10])).resolves.toBe(true);
    await ensureNativeHeavyJobBase();
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it('proves on demand if a spawn arrives before boot started the proof', async () => {
    const { ensureNativeHeavyJobBase } = await freshPreload();
    prepare.mockResolvedValue(validJobBase());
    await ensureNativeHeavyJobBase();
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it('after a failed boot, a spawn proves the base first and a fresh failure is not retried by every spawn', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-07T12:00:00Z') });
    const { proveNativeHeavyJobBaseAtBoot, ensureNativeHeavyJobBase } = await freshPreload();
    // Background longe: o caso mede só os spawns.
    prepare.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValue(validJobBase());
    await expect(proveNativeHeavyJobBaseAtBoot([60_000])).resolves.toBe(false);

    await expect(ensureNativeHeavyJobBase()).rejects.toThrow('native_heavy_job_authority_unavailable');
    expect(prepare).toHaveBeenCalledTimes(2);
    // Falhou agora há pouco: o próximo spawn não espera o host de novo.
    await expect(ensureNativeHeavyJobBase()).rejects.toThrow('native_heavy_job_authority_unavailable');
    expect(prepare).toHaveBeenCalledTimes(2);

    vi.setSystemTime(new Date('2026-10-07T12:00:11Z'));
    await ensureNativeHeavyJobBase();
    expect(prepare).toHaveBeenCalledTimes(3);
    // Base provada: spawns seguintes não consultam o host.
    await ensureNativeHeavyJobBase();
    expect(prepare).toHaveBeenCalledTimes(3);
  });

  it('holds concurrent agent spawns behind the boot proof without a second host request', async () => {
    const { proveNativeHeavyJobBaseAtBoot, ensureNativeHeavyJobBase } = await freshPreload();
    let prove!: (value: ReturnType<typeof validJobBase>) => void;
    prepare.mockReturnValue(new Promise((resolve) => { prove = resolve; }));
    const boot = proveNativeHeavyJobBaseAtBoot();
    const spawn = vi.fn();
    const first = (async () => { await ensureNativeHeavyJobBase(); spawn(); })();
    const second = (async () => { await ensureNativeHeavyJobBase(); spawn(); })();
    await Promise.resolve();
    expect(spawn).not.toHaveBeenCalled();
    prove(validJobBase());
    await Promise.all([boot, first, second]);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(ensureNativeHeavyJobBase()).toBeUndefined();
  });

  it('refuses a waiting agent when the boot proof fails instead of fixing an unproved env for its lifetime', async () => {
    vi.useFakeTimers();
    const { proveNativeHeavyJobBaseAtBoot, ensureNativeHeavyJobBase } = await freshPreload();
    let prove!: (value: null) => void;
    prepare.mockReturnValue(new Promise((resolve) => { prove = resolve; }));
    const boot = proveNativeHeavyJobBaseAtBoot([60_000]);
    const spawn = vi.fn();
    const pending = (async () => { await ensureNativeHeavyJobBase(); spawn(); })();
    const rejected = expect(pending).rejects.toThrow('native_heavy_job_authority_unavailable');
    prove(null);
    await expect(boot).resolves.toBe(false);
    await rejected;
    expect(spawn).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledTimes(1);
  });
});
