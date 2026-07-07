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
 *   {timestamp, session, tool, args, result, duration_ms, user_authorized, error?}
 */

const LOG_DIR = path.join(os.homedir(), 'Library', 'Logs', 'NexusIDE');
const LOG_FILE = path.join(LOG_DIR, 'jarvis-actions.log');
const REDACTED = '[REDACTED]';
const REDACTED_TEXT = '[REDACTED_TEXT]';
const SECRET_KEY_RE = /(authorization|cookie|password|secret|token|api[_-]?key|access[_-]?key)/i;
const CONTENT_KEY_RE = /^(content|oldText|newText)$/i;

export interface AuditEntry {
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Session identifier */
  session: string;
  /** MCP tool name (e.g. "nexus_file_write") */
  tool: string;
  /** Redacted tool arguments */
  args: Record<string, unknown>;
  /** Result status */
  result: 'ok' | 'error' | 'denied';
  /** Duration in milliseconds */
  duration_ms: number;
  /** Whether the user explicitly confirmed this action */
  user_authorized: boolean;
  /** Error message, if result is 'error' */
  error?: string;
}

function redactValue(value: unknown, key = ''): unknown {
  if (SECRET_KEY_RE.test(key)) return REDACTED;
  if (CONTENT_KEY_RE.test(key)) return REDACTED_TEXT;
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([childKey, childValue]) => [
        childKey,
        redactValue(childValue, childKey),
      ]);
    return Object.fromEntries(entries);
  }
  if (typeof value === 'string' && value.length > 2000) {
    return `${value.slice(0, 2000)}...[TRUNCATED]`;
  }
  return value;
}

export function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  return redactValue(args) as Record<string, unknown>;
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
  userAuthorized: boolean,
): void {
  writeAuditEntry({
    timestamp: new Date().toISOString(),
    session,
    tool,
    args: redactArgs(args),
    result: 'ok',
    duration_ms: durationMs,
    user_authorized: userAuthorized,
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
  userAuthorized: boolean,
): void {
  writeAuditEntry({
    timestamp: new Date().toISOString(),
    session,
    tool,
    args: redactArgs(args),
    result: 'error',
    duration_ms: durationMs,
    user_authorized: userAuthorized,
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
    timestamp: new Date().toISOString(),
    session,
    tool,
    args: redactArgs(args),
    result: 'denied',
    duration_ms: durationMs,
    user_authorized: false,
    error: reason,
  });
}

function parseLegacyArgs(args: unknown): Record<string, unknown> {
  if (typeof args !== 'string') {
    return args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  }
  try {
    const parsed = JSON.parse(args);
    return parsed && typeof parsed === 'object'
      ? redactArgs(parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseAuditEntry(line: string): AuditEntry | null {
  try {
    const raw = JSON.parse(line) as Partial<AuditEntry> & {
      ts?: string;
      durationMs?: number;
      userConfirmed?: boolean;
    };
    if (typeof raw.timestamp === 'string') return raw as AuditEntry;
    if (typeof raw.ts === 'string') {
      return {
        timestamp: raw.ts,
        session: String(raw.session ?? ''),
        tool: String(raw.tool ?? ''),
        args: parseLegacyArgs(raw.args),
        result: raw.result ?? 'error',
        duration_ms: raw.durationMs ?? 0,
        user_authorized: raw.userConfirmed ?? false,
        error: raw.error,
      };
    }
    return null;
  } catch {
    return null;
  }
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
      .map(parseAuditEntry)
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
  // Synchronous appends keep no open handle.
}
