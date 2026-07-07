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
const TRUNCATED = '[TRUNCATED]';
const MAX_STRING_LENGTH = 2000;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 100;
const MAX_REDACTION_DEPTH = 8;
const MAX_AUDIT_LINE_BYTES = 64 * 1024;
const SECRET_KEY_RE =
  /(authorization|cookie|set-cookie|x-api-key|password|secret|token|api[_-]?key|access[_-]?key|credential|bearer)/i;
const CONTENT_KEY_RE = /^(content|oldText|newText|text)$/i;
const ENV_SECRET_RE =
  /(^|\n)\s*(?=[A-Za-z_][A-Za-z0-9_]*\s*=)[A-Za-z0-9_]*(TOKEN|SECRET|PASSWORD|PASS|API_KEY|CREDENTIAL|AUTH|BEARER)[A-Za-z0-9_]*\s*=/i;
const SECRET_VALUE_RE =
  /\b(Bearer\s+[A-Za-z0-9._~+/-]+=*|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|npm_[A-Za-z0-9_]{16,})\b/i;
const COMMAND_SECRET_RE =
  /(--?(token|secret|password|pass|api-key|authorization|cookie|credential)\b|Bearer\s+|(?=[A-Za-z_][A-Za-z0-9_]*=)[A-Za-z0-9_]*(TOKEN|SECRET|PASSWORD|PASS|API_KEY|CREDENTIAL|AUTH|BEARER)[A-Za-z0-9_]*=)/i;

export type AuditSource = 'http-mcp' | 'ipc-renderer' | 'jarvis-voice';

let auditLogFileOverride: string | null = null;

export interface AuditEntry {
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Session identifier */
  session: string;
  /** Transport/source that requested the tool call */
  source: AuditSource;
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

function currentLogFile(): string {
  return auditLogFileOverride ?? LOG_FILE;
}

function currentLogDir(): string {
  return path.dirname(currentLogFile());
}

function redactValue(
  value: unknown,
  key = '',
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (SECRET_KEY_RE.test(key)) return REDACTED;
  if (CONTENT_KEY_RE.test(key)) return REDACTED_TEXT;
  if (depth > MAX_REDACTION_DEPTH) return TRUNCATED;
  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => redactValue(item, key, depth + 1, seen));
    if (value.length > MAX_ARRAY_ITEMS) items.push(TRUNCATED);
    return items;
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) return TRUNCATED;
    seen.add(value);
    const entries = Object.entries(value as Record<string, unknown>)
      .slice(0, MAX_OBJECT_KEYS)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([childKey, childValue]) => [
        childKey,
        redactValue(childValue, childKey, depth + 1, seen),
      ]);
    if (Object.keys(value).length > MAX_OBJECT_KEYS) {
      entries.push(['__truncated_keys', TRUNCATED]);
    }
    return Object.fromEntries(entries);
  }
  if (typeof value === 'string') {
    if (
      ENV_SECRET_RE.test(value) ||
      SECRET_VALUE_RE.test(value) ||
      (key === 'command' && COMMAND_SECRET_RE.test(value))
    ) {
      return REDACTED;
    }
    if (value.length > MAX_STRING_LENGTH) {
      return `${value.slice(0, MAX_STRING_LENGTH)}...${TRUNCATED}`;
    }
  }
  return value;
}

export function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  return redactValue(args) as Record<string, unknown>;
}

export function setAuditLogPathForTests(filePath: string | null): void {
  auditLogFileOverride = filePath;
}

export function ensureAuditLogWritable(): void {
  const dir = currentLogDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const fd = fs.openSync(currentLogFile(), 'a');
  fs.closeSync(fd);
}

function boundedEntry(entry: AuditEntry): AuditEntry {
  const line = JSON.stringify(entry);
  if (Buffer.byteLength(line) <= MAX_AUDIT_LINE_BYTES) return entry;
  return {
    ...entry,
    args: { redacted: '[REDACTED_LARGE_ARGS]' },
    error: entry.error
      ? String(entry.error).slice(0, MAX_STRING_LENGTH)
      : entry.error,
  };
}

/**
 * Append an audit entry to the JSONL log file.
 * Uses synchronous writes to ensure entries are never lost during process exit
 * and to make tests deterministic.
 */
export function writeAuditEntry(entry: AuditEntry): void {
  ensureAuditLogWritable();
  const line = JSON.stringify(boundedEntry(entry)) + '\n';
  fs.appendFileSync(currentLogFile(), line, 'utf-8');
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
  source: AuditSource = 'ipc-renderer',
): void {
  writeAuditEntry({
    timestamp: new Date().toISOString(),
    session,
    source,
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
  source: AuditSource = 'ipc-renderer',
): void {
  writeAuditEntry({
    timestamp: new Date().toISOString(),
    session,
    source,
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
  source: AuditSource = 'ipc-renderer',
): void {
  writeAuditEntry({
    timestamp: new Date().toISOString(),
    session,
    source,
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
    if (typeof raw.timestamp === 'string') {
      return {
        ...(raw as AuditEntry),
        source: raw.source ?? 'ipc-renderer',
      };
    }
    if (typeof raw.ts === 'string') {
      return {
        timestamp: raw.ts,
        session: String(raw.session ?? ''),
        source: 'ipc-renderer',
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
    const logFile = currentLogFile();
    if (!fs.existsSync(logFile)) return [];
    const raw = fs.readFileSync(logFile, 'utf-8');
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
  if (!auditLogFileOverride) {
    throw new Error('clearAuditLog requires a test audit log path override');
  }
  if (fs.existsSync(auditLogFileOverride)) {
    fs.unlinkSync(auditLogFileOverride);
  }
}

/**
 * Get the audit log file path.
 */
export function getAuditLogPath(): string {
  return currentLogFile();
}

/**
 * Close the log stream (for graceful shutdown).
 */
export function closeAuditLog(): void {
  // Synchronous appends keep no open handle.
}
