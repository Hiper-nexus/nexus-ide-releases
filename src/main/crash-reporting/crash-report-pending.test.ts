import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  clearCrashReportPending,
  readCrashReportPending,
  writeCrashReportPending,
} from './crash-report-pending';

let dir: string;

afterEach(() => {
  if (dir) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe('crash-report-pending', () => {
  it('writes pending without telemetry consent', () => {
    dir = mkdtempSync(join(tmpdir(), 'nexus-crash-pending-'));
    const record = writeCrashReportPending(dir, {
      source: 'child',
      processType: 'gpu',
      reason: 'crashed',
      exitCode: 1,
    });
    expect(record.telemetryConsent).toBe(false);
    const read = readCrashReportPending(dir);
    expect(read?.reason).toBe('crashed');
    expect(read?.telemetryConsent).toBe(false);
    clearCrashReportPending(dir);
    expect(readCrashReportPending(dir)).toBeNull();
  });
});
