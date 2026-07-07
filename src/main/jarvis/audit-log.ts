import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Audit log for Jarvis agent actions.
 *
 * Every MCP tool invocation (whether allowed, denied, successful, or failed)
 * is written to a JSONL file at:
 *   ~/Library/Logs/NexusIDE/jarvis-actions.log
 *
 * Format (one JSON object per line):
 *   {ts, session, tool, args, result, duration_ms, user_confirmed, error?}
 */

const LOG_DIR = path.join(os.homedir(), 'Library', 'Logs', 'NexusIDE');
const LOG_FILE = path.join(LOG_DIR, 'jarvis-actions.log');

let logStream: fs.WriteStream | null = null;

function ensureStream(): fs.WriteStream {
  if (!logStream || logStream.destroyed) {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }
    logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  }
  return logStream;
}

export interface AuditEntry {
  /** ISO 8601 timestamp */
  ts: string;
  /** Session identifier */
  session: string;
  /** MCP tool name (e.g. "nexus_file_write") */
  tool: string;
  /** Tool arguments (serialized as JSON string) */
  args: string;
  /** Result status */
  result: 'ok' | 'error' | 'denied';
  /** Duration in milliseconds */
  durationMs: number;
  /** Whether the user explicitly confirmed this action */
  userConfirmed: boolean;
  /** Error message, if result is 'error' */
  error?: string;
}

/**
 * Append an audit entry to the JSONL log file.
 * Uses synchronous writes to ensure entries are never lost during process exit
 * and to make tests deterministic.
 */
export function writeAuditEntry(entry: AuditEntry): void {
  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(LOG_FILE, line, 'utf-8');
  } catch {
    // Silently fail — audit log should never crash the app
    console.warn('[jarvis:audit] failed to write audit entry');
  }
}

/**
 * Convenience: log a successful tool invocation.
 */
export function auditSuccess(
  session: string,
  tool: string,
  args: Record<string, unknown>,
  durationMs: number,
  userConfirmed: boolean,
): void {
  writeAuditEntry({
    ts: new Date().toISOString(),
    session,
    tool,
    args: JSON.stringify(args),
    result: 'ok',
    durationMs,
    userConfirmed,
  });
}

/**
 * Convenience: log a failed tool invocation.
 */
export function auditError(
  session: string,
  tool: string,
  args: Record<string, unknown>,
  durationMs: number,
  error: string,
  userConfirmed: boolean,
): void {
  writeAuditEntry({
    ts: new Date().toISOString(),
    session,
    tool,
    args: JSON.stringify(args),
    result: 'error',
    durationMs,
    userConfirmed,
    error,
  });
}

/**
 * Convenience: log a denied tool invocation.
 */
export function auditDenied(
  session: string,
  tool: string,
  args: Record<string, unknown>,
  durationMs: number,
  reason: string,
): void {
  writeAuditEntry({
    ts: new Date().toISOString(),
    session,
    tool,
    args: JSON.stringify(args),
    result: 'denied',
    durationMs,
    userConfirmed: false,
    error: reason,
  });
}

/**
 * Read the audit log back as an array of entries.
 * Returns the last N entries (default 100).
 */
export function readAuditLog(limit = 100): AuditEntry[] {
  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    const raw = fs.readFileSync(LOG_FILE, 'utf-8');
    const lines = raw.trim().split('\n');
    const entries = lines
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line) as AuditEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is AuditEntry => e !== null);
    return entries;
  } catch {
    return [];
  }
}

/**
 * Clear the audit log file (for testing).
 */
export function clearAuditLog(): void {
  try {
    if (logStream) {
      logStream.close();
      logStream = null;
    }
    if (fs.existsSync(LOG_FILE)) {
      fs.unlinkSync(LOG_FILE);
    }
  } catch {
    // Silent
  }
}

/**
 * Get the audit log file path.
 */
export function getAuditLogPath(): string {
  return LOG_FILE;
}

/**
 * Close the log stream (for graceful shutdown).
 */
export function closeAuditLog(): void {
  try {
    if (logStream) {
      logStream.end();
      logStream = null;
    }
  } catch {
    // Silent
  }
}