// Adapted patterns from stablyai/orca crash reporting @ 143c36e
// Copyright (c) 2026 Lovecast Inc. — MIT License
// See third_party/licenses/orca-MIT.txt. Nexus changes: minimal pending surface
// in userData only; NO telemetry without explicit user consent.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const CRASH_REPORT_PENDING_FILE = 'crash-report-pending.json';

export type CrashReportPendingRecord = {
  readonly schemeVersion: 1;
  readonly recordedAt: number;
  readonly source: 'renderer' | 'child';
  readonly processType: string;
  readonly reason: string;
  readonly exitCode: number | null;
  readonly reportId?: string;
  /**
   * Consent is never implied. Upload/telemetry must stay off until the user
   * explicitly grants it via a future UI action. This flag only tracks that a
   * local report is available for the user to inspect.
   */
  readonly telemetryConsent: false;
};

function pendingPath(userDataPath: string): string {
  return join(userDataPath, CRASH_REPORT_PENDING_FILE);
}

export function writeCrashReportPending(
  userDataPath: string,
  input: Omit<CrashReportPendingRecord, 'schemeVersion' | 'telemetryConsent' | 'recordedAt'> & {
    recordedAt?: number;
  },
): CrashReportPendingRecord {
  const record: CrashReportPendingRecord = {
    schemeVersion: 1,
    recordedAt: input.recordedAt ?? Date.now(),
    source: input.source,
    processType: input.processType,
    reason: input.reason,
    exitCode: input.exitCode,
    reportId: input.reportId,
    telemetryConsent: false,
  };
  const path = pendingPath(userDataPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return record;
}

export function readCrashReportPending(
  userDataPath: string,
): CrashReportPendingRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(pendingPath(userDataPath), 'utf-8')) as Partial<
      CrashReportPendingRecord
    >;
    if (parsed.schemeVersion !== 1) return null;
    if (parsed.telemetryConsent !== false) return null;
    if (typeof parsed.recordedAt !== 'number' || typeof parsed.reason !== 'string') {
      return null;
    }
    if (parsed.source !== 'renderer' && parsed.source !== 'child') return null;
    return {
      schemeVersion: 1,
      recordedAt: parsed.recordedAt,
      source: parsed.source,
      processType: typeof parsed.processType === 'string' ? parsed.processType : 'unknown',
      reason: parsed.reason,
      exitCode: typeof parsed.exitCode === 'number' ? parsed.exitCode : null,
      reportId: typeof parsed.reportId === 'string' ? parsed.reportId : undefined,
      telemetryConsent: false,
    };
  } catch {
    return null;
  }
}

export function clearCrashReportPending(userDataPath: string): void {
  try {
    if (existsSync(pendingPath(userDataPath))) {
      rmSync(pendingPath(userDataPath), { force: true });
    }
  } catch {
    // best effort
  }
}
