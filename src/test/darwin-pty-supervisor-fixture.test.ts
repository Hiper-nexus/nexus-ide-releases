import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveDarwinPtySupervisor } from '../main/pty/darwin-pty-supervisor';
import { buildTestDarwinPtySupervisor } from './darwin-pty-supervisor-fixture';

describe.runIf(process.platform === 'darwin')('supervisor Darwin das suítes nativas (F-1036)', () => {
  it('resolve o helper compilado deste checkout, nunca um de checkout pai ou ausente', () => {
    const { runtime, dispose } = buildTestDarwinPtySupervisor();
    try {
      const helper = resolveDarwinPtySupervisor(runtime);
      expect(helper).toBe(fs.realpathSync(path.join(runtime.cwd, 'resources/native/darwin/nexus-pty-supervisor')));
    } finally {
      dispose();
    }
    expect(fs.existsSync(runtime.cwd)).toBe(false);
  }, 60_000);
});
