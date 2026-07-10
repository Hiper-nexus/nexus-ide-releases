import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isSmokeTest } from '../smoke-core';

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
  /** Intent is appended before a high-impact effect; outcomes follow it. */
  result: 'intent' | 'ok' | 'error' | 'denied';
  /** Correlates a pre-effect intent with its eventual outcome. */
  invocation_id?: string;
  /** Duration in milliseconds */
  duration_ms: number;
  /** Whether the user explicitly confirmed this action */
  user_authorized: boolean;
  /** Error message, if result is 'error' */
  error?: string;
}

function smokeAuditLogPath(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): string | null {
  const userData = env.NEXUS_USER_DATA_DIR;
  if (!isSmokeTest(argv) || !userData) return null;
  return path.join(path.resolve(userData), 'jarvis-actions.log');
}

/**
 * The packaged smoke must not append synthetic tool calls to the operator's
 * real audit history. Its user-data directory is created per run and removed
 * by the smoke harness after process exit.
 */
export function resolveAuditLogPath(
  override: string | null,
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): string {
  return override ?? smokeAuditLogPath(argv, env) ?? LOG_FILE;
}

function currentLogFile(): string {
  return resolveAuditLogPath(auditLogFileOverride, process.argv, process.env);
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

export function redactAuditText(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-|gh[pousr]_|npm_)[A-Za-z0-9_-]{12,}\b/g, REDACTED)
    .replace(
      /([?&](?:token|secret|password|api[_-]?key|authorization|cookie|credential)=)[^&\s]+/gi,
      '$1[REDACTED]',
    )
    .replace(
      /(--?(?:token|secret|password|pass|api-key|authorization|cookie|credential)(?:=|\s+))[^\s]+/gi,
      '$1[REDACTED]',
    )
    .replace(
      /\b((?=[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASS|API_KEY|CREDENTIAL|AUTH|BEARER))[A-Za-z_][A-Za-z0-9_]*)=([^\s]+)/g,
      '$1=[REDACTED]',
    )
    .slice(0, MAX_STRING_LENGTH);
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
  const sanitized: AuditEntry = {
    ...entry,
    args: redactArgs(
      entry.args && typeof entry.args === 'object' ? entry.args : {},
    ),
    ...(entry.error ? { error: redactAuditText(entry.error) } : {}),
  };
  const line = JSON.stringify(sanitized);
  if (Buffer.byteLength(line) <= MAX_AUDIT_LINE_BYTES) return sanitized;
  return {
    ...sanitized,
    args: { redacted: '[REDACTED_LARGE_ARGS]' },
    error: sanitized.error,
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
  invocationId?: string,
): void {
  writeAuditEntry({
    timestamp: new Date().toISOString(),
    session,
    source,
    tool,
    args: redactArgs(args),
    result: 'ok',
    ...(invocationId ? { invocation_id: invocationId } : {}),
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
  invocationId?: string,
): void {
  writeAuditEntry({
    timestamp: new Date().toISOString(),
    session,
    source,
    tool,
    args: redactArgs(args),
    result: 'error',
    ...(invocationId ? { invocation_id: invocationId } : {}),
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

/**
 * Persist the authorized intent before starting a high-impact handler. If
 * this append fails, dispatch must fail closed and the effect must not start.
 */
export function auditIntent(
  session: string,
  tool: string,
  args: Record<string, unknown>,
  durationMs: number,
  userAuthorized: boolean,
  source: AuditSource,
  invocationId: string,
): void {
  writeAuditEntry({
    timestamp: new Date().toISOString(),
    session,
    source,
    tool,
    args: redactArgs(args),
    result: 'intent',
    invocation_id: invocationId,
    duration_ms: durationMs,
    user_authorized: userAuthorized,
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
      return boundedEntry({
        ...(raw as AuditEntry),
        source: raw.source ?? 'ipc-renderer',
      });
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
