import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { processSandboxRuntimeAvailable } from './process-sandbox-capability';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.mocked(execFileSync).mockReset(); });

describe('processSandboxRuntimeAvailable', () => {
  it('proves Seatbelt can run a process instead of trusting binary presence', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    expect(processSandboxRuntimeAvailable('darwin')).toBe(true);
    expect(execFileSync).toHaveBeenCalledWith('/usr/bin/sandbox-exec',
      ['-p', '(version 1)(allow default)', '/usr/bin/true'],
      { timeout: 5000, stdio: 'ignore' });
  });
  it('reports unavailable when an outer sandbox denies sandbox_apply', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('sandbox_apply: Operation not permitted'); });
    expect(processSandboxRuntimeAvailable('darwin')).toBe(false);
  });
  it('does not try an absent sandbox executable', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    expect(processSandboxRuntimeAvailable('darwin')).toBe(false);
    expect(execFileSync).not.toHaveBeenCalled();
  });
  it('does not claim a sandbox on an unsupported platform', () => {
    expect(processSandboxRuntimeAvailable('freebsd')).toBe(false);
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
