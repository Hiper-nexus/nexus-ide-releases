import { randomUUID } from 'node:crypto';
import {
  projectExecutionScopeSchema,
  type ProjectExecutionScope,
} from '../../shared/types';
import { ScopedStoreBinding } from '../orch/scoped-store';
import type { ProjectRuntimeManager } from '../runtime/project-runtime-manager';

const REDACTED = '[REDACTED]';
const REDACTED_TEXT = '[REDACTED_TEXT]';
const TRUNCATED = '[TRUNCATED]';
const LARGE_ARGS_REDACTION = '[REDACTED_LARGE_ARGS]';
const PAYLOAD_SCHEMA = 'nexus.mcp-audit/v1';
const MAX_STRING_LENGTH = 2_000;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 100;
const MAX_REDACTION_DEPTH = 8;
const MAX_AUDIT_PAYLOAD_BYTES = 64 * 1024;
const MAX_READ_LIMIT = 10_000;
const SECRET_KEY_RE =
  /(authorization|cookie|set-cookie|x-api-key|password|secret|token|api[_-]?key|access[_-]?key|credential|bearer)/i;
const CONTENT_KEY_RE = /^(content|oldText|newText|text)$/i;
const ENV_SECRET_RE =
  /(^|\n)\s*(?=[A-Za-z_][A-Za-z0-9_]*\s*=)[A-Za-z0-9_]*(TOKEN|SECRET|PASSWORD|PASS|API_KEY|CREDENTIAL|AUTH|BEARER)[A-Za-z0-9_]*\s*=/i;
const SECRET_VALUE_RE =
  /\b(Bearer\s+[A-Za-z0-9._~+/-]+=*|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|npm_[A-Za-z0-9_]{16,})\b/i;
const COMMAND_SECRET_RE =
  /(--?(token|secret|password|pass|api-key|authorization|cookie|credential)\b|Bearer\s+|(?=[A-Za-z_][A-Za-z0-9_]*=)[A-Za-z0-9_]*(TOKEN|SECRET|PASSWORD|PASS|API_KEY|CREDENTIAL|AUTH|BEARER)[A-Za-z0-9_]*=)/i;

export type AuditSource = 'http-mcp' | 'omp-rpc-stdio' | 'ipc-renderer' | 'jarvis-voice';
export type AuditResult = 'intent' | 'ok' | 'error' | 'denied';

export interface AuditContext {
  readonly scope: ProjectExecutionScope;
  readonly missionId?: string;
  readonly contextRevision?: string;
}

export interface AuditEntry {
  readonly timestamp: string;
  readonly session: string;
  readonly project_id: string;
  readonly checkout_id: string;
  readonly mission_id?: string;
  readonly context_revision?: string;
  readonly source: AuditSource;
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly result: AuditResult;
  readonly invocation_id?: string;
  readonly duration_ms: number;
  readonly user_authorized: boolean;
  readonly error?: string;
}

export type AuditEntryInput = Omit<
  AuditEntry,
  'project_id' | 'checkout_id' | 'mission_id' | 'context_revision'
>;

interface ValidAuditContext {
  readonly scope: ProjectExecutionScope;
  readonly missionId?: string;
  readonly contextRevision?: string;
}

interface AuditPayload {
  readonly schema: typeof PAYLOAD_SCHEMA;
  readonly timestamp: string;
  readonly project_id: string;
  readonly checkout_id: string;
  readonly context_revision?: string;
  readonly source: AuditSource;
  readonly args: Record<string, unknown>;
  readonly invocation_id?: string;
  readonly duration_ms: number;
  readonly user_authorized: boolean;
  readonly error?: string;
}

interface AuditRow {
  readonly mission_id: string | null;
  readonly actor: string;
  readonly action: string;
  readonly outcome: string;
  readonly payload_json: string;
  readonly occurred_at: number;
}

export class AuditLogCorruptionError extends Error {
  constructor(options: { cause?: unknown } = {}) {
    super(
      'project runtime contains an invalid audit event',
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'AuditLogCorruptionError';
  }
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

export function redactArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
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

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > 256 ||
    value.includes('\0')
  ) {
    throw new Error(`invalid audit ${label}`);
  }
}

function validateContext(context: AuditContext): ValidAuditContext {
  if (!context || typeof context !== 'object') {
    throw new Error('audit context is required');
  }
  const scope = Object.freeze(
    projectExecutionScopeSchema.parse({ ...context.scope }),
  );
  if (context.missionId !== undefined) {
    assertIdentifier(context.missionId, 'missionId');
  }
  if (context.contextRevision !== undefined) {
    assertIdentifier(context.contextRevision, 'contextRevision');
    if (!context.missionId) {
      throw new Error('audit contextRevision requires missionId');
    }
  }
  return Object.freeze({
    scope,
    ...(context.missionId ? { missionId: context.missionId } : {}),
    ...(context.contextRevision
      ? { contextRevision: context.contextRevision }
      : {}),
  });
}

function isAuditSource(value: unknown): value is AuditSource {
  return (
    value === 'http-mcp' ||
    value === 'omp-rpc-stdio' ||
    value === 'ipc-renderer' ||
    value === 'jarvis-voice'
  );
}

function isAuditResult(value: unknown): value is AuditResult {
  return value === 'intent' || value === 'ok' || value === 'error' || value === 'denied';
}

function boundedEntry(entry: AuditEntry): AuditEntry {
  assertIdentifier(entry.session, 'session');
  assertIdentifier(entry.tool, 'tool');
  if (!isAuditSource(entry.source) || !isAuditResult(entry.result)) {
    throw new Error('invalid audit source or result');
  }
  if (
    !Number.isSafeInteger(entry.duration_ms) ||
    entry.duration_ms < 0 ||
    typeof entry.user_authorized !== 'boolean' ||
    !Number.isSafeInteger(Date.parse(entry.timestamp))
  ) {
    throw new Error('invalid audit timing or authorization');
  }
  if (entry.invocation_id !== undefined) {
    assertIdentifier(entry.invocation_id, 'invocationId');
  }
  const sanitized: AuditEntry = Object.freeze({
    ...entry,
    args: redactArgs(
      entry.args && typeof entry.args === 'object' && !Array.isArray(entry.args)
        ? entry.args
        : {},
    ),
    ...(entry.error ? { error: redactAuditText(entry.error) } : {}),
  });
  if (Buffer.byteLength(JSON.stringify(sanitized), 'utf8') <= MAX_AUDIT_PAYLOAD_BYTES) {
    return sanitized;
  }
  return Object.freeze({
    ...sanitized,
    args: Object.freeze({ redacted: LARGE_ARGS_REDACTION }),
  });
}

function payloadFor(entry: AuditEntry): AuditPayload {
  return Object.freeze({
    schema: PAYLOAD_SCHEMA,
    timestamp: entry.timestamp,
    project_id: entry.project_id,
    checkout_id: entry.checkout_id,
    ...(entry.context_revision
      ? { context_revision: entry.context_revision }
      : {}),
    source: entry.source,
    args: entry.args,
    ...(entry.invocation_id ? { invocation_id: entry.invocation_id } : {}),
    duration_ms: entry.duration_ms,
    user_authorized: entry.user_authorized,
    ...(entry.error ? { error: entry.error } : {}),
  });
}

function serializePayload(payload: AuditPayload): string {
  const value = JSON.stringify(payload);
  if (Buffer.byteLength(value, 'utf8') > MAX_AUDIT_PAYLOAD_BYTES) {
    throw new Error('audit payload exceeds the persistence limit');
  }
  return value;
}

function parsePayload(raw: string): AuditPayload {
  try {
    if (Buffer.byteLength(raw, 'utf8') > MAX_AUDIT_PAYLOAD_BYTES) {
      throw new Error('audit payload exceeds the read limit');
    }
    const value = JSON.parse(raw) as Partial<AuditPayload>;
    if (
      !value ||
      value.schema !== PAYLOAD_SCHEMA ||
      typeof value.timestamp !== 'string' ||
      typeof value.project_id !== 'string' ||
      typeof value.checkout_id !== 'string' ||
      !isAuditSource(value.source) ||
      !value.args ||
      typeof value.args !== 'object' ||
      Array.isArray(value.args) ||
      !Number.isSafeInteger(value.duration_ms) ||
      (value.duration_ms as number) < 0 ||
      typeof value.user_authorized !== 'boolean' ||
      (value.invocation_id !== undefined && typeof value.invocation_id !== 'string') ||
      (value.context_revision !== undefined &&
        typeof value.context_revision !== 'string') ||
      (value.error !== undefined && typeof value.error !== 'string')
    ) {
      throw new Error('audit payload shape is invalid');
    }
    return value as AuditPayload;
  } catch (error) {
    throw new AuditLogCorruptionError({ cause: error });
  }
}

class ProjectAuditStore {
  readonly #runtimeManager: ProjectRuntimeManager;
  readonly #context: ValidAuditContext;
  readonly #binding: ScopedStoreBinding;

  constructor(runtimeManager: ProjectRuntimeManager, context: AuditContext) {
    this.#runtimeManager = runtimeManager;
    this.#context = validateContext(context);
    this.#binding = new ScopedStoreBinding(runtimeManager, this.#context.scope);
  }

  ensureWritable(): void {
    this.#binding.writeDatabase()
      .prepare('SELECT 1 FROM audit_events LIMIT 1')
      .get();
  }

  append(input: AuditEntryInput): AuditEntry {
    const entry = boundedEntry({
      timestamp: input.timestamp,
      session: input.session,
      project_id: this.#context.scope.projectId,
      checkout_id: this.#context.scope.checkoutId,
      ...(this.#context.missionId ? { mission_id: this.#context.missionId } : {}),
      ...(this.#context.contextRevision
        ? { context_revision: this.#context.contextRevision }
        : {}),
      source: input.source,
      tool: input.tool,
      args: input.args,
      result: input.result,
      ...(input.invocation_id ? { invocation_id: input.invocation_id } : {}),
      duration_ms: input.duration_ms,
      user_authorized: input.user_authorized,
      ...(input.error ? { error: input.error } : {}),
    });
    const occurredAt = Date.parse(entry.timestamp);
    const db = this.#binding.writeDatabase();
    db.prepare(
      `INSERT INTO audit_events
         (id, mission_id, actor, action, outcome, payload_json, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `audit-${randomUUID()}`,
      entry.mission_id ?? null,
      entry.session,
      entry.tool,
      entry.result,
      serializePayload(payloadFor(entry)),
      occurredAt,
    );
    return entry;
  }

  list(limit: number): AuditEntry[] {
    const rows = this.#binding.readDatabase()
      .prepare(
        `SELECT mission_id, actor, action, outcome, payload_json, occurred_at
         FROM audit_events
         ORDER BY occurred_at DESC, rowid DESC
         LIMIT ?`,
      )
      .all(limit) as AuditRow[];
    return rows.reverse().map((row) => this.#entryFromRow(row));
  }

  clear(): void {
    this.#binding.writeDatabase().prepare('DELETE FROM audit_events').run();
  }

  storagePath(): string {
    return this.#runtimeManager.open(this.#context.scope).databasePath;
  }

  #entryFromRow(row: AuditRow): AuditEntry {
    try {
      const payload = parsePayload(row.payload_json);
      if (
        payload.project_id !== this.#context.scope.projectId ||
        payload.checkout_id !== this.#context.scope.checkoutId ||
        Date.parse(payload.timestamp) !== row.occurred_at ||
        !isAuditResult(row.outcome)
      ) {
        throw new Error('audit row does not match its physical project scope');
      }
      return boundedEntry({
        timestamp: payload.timestamp,
        session: row.actor,
        project_id: payload.project_id,
        checkout_id: payload.checkout_id,
        ...(row.mission_id ? { mission_id: row.mission_id } : {}),
        ...(payload.context_revision
          ? { context_revision: payload.context_revision }
          : {}),
        source: payload.source,
        tool: row.action,
        args: payload.args,
        result: row.outcome,
        ...(payload.invocation_id ? { invocation_id: payload.invocation_id } : {}),
        duration_ms: payload.duration_ms,
        user_authorized: payload.user_authorized,
        ...(payload.error ? { error: payload.error } : {}),
      });
    } catch (error) {
      if (error instanceof AuditLogCorruptionError) throw error;
      throw new AuditLogCorruptionError({ cause: error });
    }
  }
}

class AuditLogRuntime {
  readonly #manager: ProjectRuntimeManager;

  constructor(manager: ProjectRuntimeManager) {
    this.#manager = manager;
  }

  forContext(context: AuditContext): ProjectAuditStore {
    return new ProjectAuditStore(this.#manager, context);
  }
}

let runtime: AuditLogRuntime | null = null;

export function configureAuditLogRuntime(
  manager: ProjectRuntimeManager,
): void {
  if (!manager || typeof manager.open !== 'function') {
    throw new Error('a ProjectRuntimeManager is required for audit persistence');
  }
  runtime = new AuditLogRuntime(manager);
}

export function disposeAuditLogRuntime(): void {
  runtime = null;
}

function storeFor(context: AuditContext): ProjectAuditStore {
  if (!runtime) {
    throw new Error('project-scoped audit persistence is not initialized');
  }
  return runtime.forContext(context);
}

function readLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_READ_LIMIT) {
    throw new Error(`audit read limit must be between 1 and ${MAX_READ_LIMIT}`);
  }
  return value;
}

export function ensureAuditLogWritable(context: AuditContext): void {
  storeFor(context).ensureWritable();
}

export function writeAuditEntry(
  context: AuditContext,
  entry: AuditEntryInput,
): AuditEntry {
  return storeFor(context).append(entry);
}

export function auditSuccess(
  context: AuditContext,
  session: string,
  tool: string,
  args: Record<string, unknown>,
  durationMs: number,
  userAuthorized: boolean,
  source: AuditSource = 'ipc-renderer',
  invocationId?: string,
): void {
  writeAuditEntry(context, {
    timestamp: new Date().toISOString(),
    session,
    source,
    tool,
    args,
    result: 'ok',
    ...(invocationId ? { invocation_id: invocationId } : {}),
    duration_ms: durationMs,
    user_authorized: userAuthorized,
  });
}

export function auditError(
  context: AuditContext,
  session: string,
  tool: string,
  args: Record<string, unknown>,
  durationMs: number,
  error: string,
  userAuthorized: boolean,
  source: AuditSource = 'ipc-renderer',
  invocationId?: string,
): void {
  writeAuditEntry(context, {
    timestamp: new Date().toISOString(),
    session,
    source,
    tool,
    args,
    result: 'error',
    ...(invocationId ? { invocation_id: invocationId } : {}),
    duration_ms: durationMs,
    user_authorized: userAuthorized,
    error,
  });
}

export function auditDenied(
  context: AuditContext,
  session: string,
  tool: string,
  args: Record<string, unknown>,
  durationMs: number,
  reason: string,
  source: AuditSource = 'ipc-renderer',
): void {
  writeAuditEntry(context, {
    timestamp: new Date().toISOString(),
    session,
    source,
    tool,
    args,
    result: 'denied',
    duration_ms: durationMs,
    user_authorized: false,
    error: reason,
  });
}

export function auditIntent(
  context: AuditContext,
  session: string,
  tool: string,
  args: Record<string, unknown>,
  durationMs: number,
  userAuthorized: boolean,
  source: AuditSource,
  invocationId: string,
): void {
  writeAuditEntry(context, {
    timestamp: new Date().toISOString(),
    session,
    source,
    tool,
    args,
    result: 'intent',
    invocation_id: invocationId,
    duration_ms: durationMs,
    user_authorized: userAuthorized,
  });
}

export function readAuditLog(
  context: AuditContext,
  limit = 100,
): AuditEntry[] {
  return storeFor(context).list(readLimit(limit));
}

export function clearAuditLogForTests(context: AuditContext): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('audit events are append-only outside tests');
  }
  storeFor(context).clear();
}

export function getAuditStoragePath(context: AuditContext): string {
  return storeFor(context).storagePath();
}
