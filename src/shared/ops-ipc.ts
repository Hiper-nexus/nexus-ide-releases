/**
 * Read-only operational IPC used by Settings panels.
 * Keep this dependency-free: main, preload and renderer import it.
 */

export const OPS_CHANNELS = {
  auditLog: 'ops:auditLog',
  releaseReadiness: 'ops:releaseReadiness',
} as const;

export type AuditSource = 'http-mcp' | 'ipc-renderer' | 'jarvis-voice';
export type AuditResult = 'ok' | 'error' | 'denied';

export interface AuditLogEntry {
  timestamp: string;
  session: string;
  source: AuditSource;
  tool: string;
  args: Record<string, unknown>;
  result: AuditResult;
  duration_ms: number;
  user_authorized: boolean;
  error?: string;
}

export interface AuditLogSnapshot {
  path: string;
  readAt: string;
  entries: AuditLogEntry[];
}

export type ReadinessStatus = 'pass' | 'warn' | 'fail';

export interface ReleaseReadinessCheck {
  id: string;
  label: string;
  status: ReadinessStatus;
  detail: string;
}

export interface ReleaseReadinessSnapshot {
  checkedAt: string;
  appVersion: string;
  packageVersion: string | null;
  releaseNotesVersion: string;
  packaged: boolean;
  updateSource: 'feed' | 'gh' | 'none';
  checks: ReleaseReadinessCheck[];
}
