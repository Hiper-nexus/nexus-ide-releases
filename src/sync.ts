// Portable sync contract adapted from nexus-ide/shared/sync-contract.ts.
import { z } from 'zod';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv } from './context.js';
import type { SyncProjectRow } from './db/schema.js';
import { requireNativeAuth, requirePro } from './middleware.js';
import { readBoundedBody } from './http.js';

export const SYNC_MAX_PROJECTS_PER_ACCOUNT = 500;
export const SYNC_MAX_ENTITIES_PER_PROJECT = 1_000;
export const SYNC_MAX_STATE_BYTES = 192 * 1024;
export const SYNC_MAX_MUTATION_BYTES = 256 * 1024;

export type SyncEntityType =
  | 'mission-metadata'
  | 'context-fact'
  | 'context-decision'
  | 'regression'
  | 'contract-metadata'
  | 'ledger-metadata';

export type SyncJsonScalar = string | number | boolean | null;
export type SyncJsonValue =
  | SyncJsonScalar
  | readonly SyncJsonValue[]
  | { readonly [key: string]: SyncJsonValue };

export interface SyncMutation {
  readonly entityType: SyncEntityType;
  readonly entityId: string;
  readonly entityVersion: number;
  readonly baseVersion: number;
  readonly payload: SyncJsonValue;
}

export interface SyncProjectState {
  readonly revision: number;
  readonly entities: readonly SyncMutation[];
}

export const SYNC_PORTABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export const syncProjectIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(SYNC_PORTABLE_ID_PATTERN, 'non-portable project id');

const syncEntityIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(SYNC_PORTABLE_ID_PATTERN, 'non-portable entity id');

const mutationMetadataSchema = z
  .object({
    entityType: z.enum([
      'mission-metadata',
      'context-fact',
      'context-decision',
      'regression',
      'contract-metadata',
      'ledger-metadata',
    ]),
    entityId: syncEntityIdSchema,
    entityVersion: z.number().int().positive(),
    baseVersion: z.number().int().nonnegative(),
  })
  .strict();

const FORBIDDEN_KEY_TOKENS = new Set([
  'authorization',
  'checkout',
  'cookie',
  'credential',
  'credentials',
  'cwd',
  'installation',
  'password',
  'path',
  'paths',
  'prompt',
  'prompts',
  'proto',
  'secret',
  'secrets',
  'session',
  'sessions',
  'token',
  'tokens',
]);

const FORBIDDEN_JOINED_KEYS = [
  'absolutepath',
  'accountcredential',
  'apikey',
  'checkoutid',
  'installationid',
  'provideraccount',
  'providersession',
  'rootrealpath',
  'sourcecode',
  'sourcecontent',
  'workingdirectory',
  'workspacepath',
];

function keyTokens(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function assertSafeKey(path: readonly string[]): void {
  const tokens = path.flatMap(keyTokens);
  const joined = tokens.join('');
  if (
    tokens.some((token) => FORBIDDEN_KEY_TOKENS.has(token)) ||
    FORBIDDEN_JOINED_KEYS.some((key) => joined.includes(key)) ||
    tokens.includes('__proto__') ||
    tokens.includes('prototype') ||
    tokens.includes('constructor')
  ) {
    throw new Error(`payload is not sync-safe: ${path.at(-1) ?? 'key'}`);
  }
}

function looksLikePath(value: string): boolean {
  return (
    value.startsWith('/') ||
    value.startsWith('\\\\') ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    /(?:^|[\s"'(])file:\/\/[^\s"'),;]+/i.test(value) ||
    /(?:^|[\s"'(])~[\\/][^\s"'),;]+/.test(value) ||
    /(?:^|[\s"'(])\\\\[^\\\s]+\\[^\s"'),;]+/.test(value) ||
    /(?:^|[\s"'(])\/(?!\/)[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*(?:$|[\s"'),.;:])/.test(
      value,
    ) ||
    /(?:^|\s)[A-Za-z]:[\\/][^\s]+/.test(value) ||
    /^(?:\.{1,2}[\\/])?(?:[A-Za-z0-9._-]+[\\/])+[A-Za-z0-9._-]+$/.test(
      value,
    )
  );
}

function looksLikeCredential(value: string): boolean {
  return (
    /\bBearer\s+[A-Za-z0-9._~+/-]+=*/i.test(value) ||
    /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}\b/.test(value) ||
    /\bglpat-[A-Za-z0-9_-]{12,}\b/.test(value) ||
    /(?:^|[^A-Za-z0-9])(?:[A-Za-z][A-Za-z0-9]{0,31}[_-])+(?:key|token|secret|password|credential)\s*["']?\s*[:=]\s*["']?[^\s"',;}\]]{4,}/i.test(
      value,
    ) ||
    /(?:^|[^A-Za-z0-9])(?:password|passwd|pwd|(?:aws[_ -]?)?secret[_ -]?access[_ -]?key|(?:aws[_ -]?)?access[_ -]?key(?:[_ -]?id)?|api[_ -]?key|client[_ -]?secret|private[_ -]?key|token|secret|credential|authorization|auth|cookie)\s*["']?\s*[:=]\s*["']?[^\s"',;}\]]{4,}/i.test(
      value,
    ) ||
    /\b(?:sk-|gh[pousr]_|xox[baprs]-)[A-Za-z0-9_-]{12,}/.test(value) ||
    /\bAIza[0-9A-Za-z_-]{20,}/.test(value) ||
    /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/.test(value) ||
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value) ||
    /^[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i.test(value)
  );
}

export function assertNoCredentialMaterial(value: string): void {
  if (looksLikeCredential(value)) {
    throw new Error('value is not sync-safe: credential material');
  }
}

export function assertPortableText(value: string): void {
  if (looksLikePath(value)) {
    throw new Error('value is not sync-safe: non-portable path');
  }
  assertNoCredentialMaterial(value);
}

function syncSafe(
  value: unknown,
  keyPath: readonly string[] = [],
  depth = 0,
): SyncJsonValue {
  if (depth > 32) throw new Error('payload is not sync-safe: nesting limit');
  if (keyPath.length > 0) assertSafeKey(keyPath);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('payload is not sync-safe: number');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === 'string') {
    assertPortableText(value);
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(
      value.map((item) => syncSafe(item, keyPath, depth + 1)),
    );
  }
  if (typeof value === 'object' && value !== null) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('payload is not sync-safe: object prototype');
    }
    const result: Record<string, SyncJsonValue> = Object.create(null) as Record<
      string,
      SyncJsonValue
    >;
    for (const [childKey, childValue] of Object.entries(
      value as Record<string, unknown>,
    )) {
      result[childKey] = syncSafe(
        childValue,
        [...keyPath, childKey],
        depth + 1,
      );
    }
    return Object.freeze(result);
  }
  throw new Error(`payload is not sync-safe: ${typeof value}`);
}

export function canonicalSyncJson(value: unknown): string {
  const seen = new Set<object>();
  const visit = (input: unknown): string => {
    if (input === null || typeof input === 'boolean' || typeof input === 'string') {
      return JSON.stringify(input);
    }
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) throw new Error('invalid sync number');
      return JSON.stringify(Object.is(input, -0) ? 0 : input);
    }
    if (typeof input !== 'object') throw new Error('invalid sync JSON');
    if (seen.has(input)) throw new Error('cyclic sync JSON');
    seen.add(input);
    try {
      if (Array.isArray(input)) {
        return `[${input.map(visit).join(',')}]`;
      }
      const record = input as Record<string, unknown>;
      return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${visit(record[key])}`)
        .join(',')}}`;
    } finally {
      seen.delete(input);
    }
  };
  return visit(value);
}

export class SyncContractValidationError extends Error {
  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : 'invalid sync value';
    super(detail, { cause });
    this.name = 'SyncContractValidationError';
  }
}

export function normalizeSyncMutation(raw: unknown): SyncMutation {
  try {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error('invalid sync mutation');
    }
    const { payload, ...metadata } = raw as Record<string, unknown>;
    const parsed = mutationMetadataSchema.parse(metadata);
    if (parsed.entityVersion !== parsed.baseVersion + 1) {
      throw new Error(
        'sync mutation entityVersion must advance exactly one version',
      );
    }
    const safePayload = syncSafe(payload);
    if (
      new TextEncoder().encode(canonicalSyncJson(safePayload)).byteLength >
      SYNC_MAX_MUTATION_BYTES
    ) {
      throw new Error('payload is not sync-safe: size limit');
    }
    return Object.freeze({ ...parsed, payload: safePayload });
  } catch (error) {
    if (error instanceof SyncContractValidationError) throw error;
    throw new SyncContractValidationError(error);
  }
}

export interface SyncStateLimits {
  readonly maxEntities?: number;
  readonly maxStateBytes?: number;
}

export class SyncContractQuotaError extends Error {
  readonly quota: 'entities-per-project' | 'bytes-per-project';
  readonly limit: number;
  readonly actual: number;

  constructor(
    quota: 'entities-per-project' | 'bytes-per-project',
    limit: number,
    actual: number,
  ) {
    super(`sync quota exceeded: ${quota}`);
    this.name = 'SyncContractQuotaError';
    this.quota = quota;
    this.limit = limit;
    this.actual = actual;
  }
}

export function normalizeSyncEntities(
  raw: unknown,
  limits: SyncStateLimits = {},
): readonly SyncMutation[] {
  try {
    if (!Array.isArray(raw)) throw new Error('invalid sync entities');
    const maxEntities = limits.maxEntities ?? SYNC_MAX_ENTITIES_PER_PROJECT;
    if (raw.length > maxEntities) {
      throw new SyncContractQuotaError(
        'entities-per-project',
        maxEntities,
        raw.length,
      );
    }
    const normalized = raw.map(normalizeSyncMutation);
    const keys = normalized.map(
      (mutation) => `${mutation.entityType}:${mutation.entityId}`,
    );
    if (new Set(keys).size !== keys.length) {
      throw new Error('sync state contains duplicate entities');
    }
    normalized.sort((left, right) =>
      `${left.entityType}:${left.entityId}`.localeCompare(
        `${right.entityType}:${right.entityId}`,
      ),
    );
    const maxStateBytes = limits.maxStateBytes ?? SYNC_MAX_STATE_BYTES;
    const stateBytes = new TextEncoder().encode(canonicalSyncJson(normalized)).byteLength;
    if (stateBytes > maxStateBytes) {
      throw new SyncContractQuotaError(
        'bytes-per-project',
        maxStateBytes,
        stateBytes,
      );
    }
    return Object.freeze(normalized);
  } catch (error) {
    if (
      error instanceof SyncContractQuotaError ||
      error instanceof SyncContractValidationError
    ) {
      throw error;
    }
    throw new SyncContractValidationError(error);
  }
}

export function syncEntityKey(mutation: SyncMutation): string {
  return `${mutation.entityType}:${mutation.entityId}`;
}

export interface SyncLimits {
  readonly maxProjectsPerAccount?: number;
  readonly maxEntitiesPerProject?: number;
  readonly maxStateBytes?: number;
}
export interface SyncServiceDeps { readonly db: D1Database; readonly now?: () => number; readonly limits?: SyncLimits; }
type SyncDb = Pick<D1Database, 'prepare'>;
type SyncConflictReason = 'revision-conflict' | 'entity-version-conflict';
export type SyncCasResult =
  | { readonly ok: true; readonly revision: number; readonly serverTime: number }
  | { readonly ok: false; readonly reason: SyncConflictReason; readonly expectedRevision: number; readonly actualRevision: number; readonly conflictingEntityIds: readonly string[]; readonly serverTime: number }
  | { readonly ok: false; readonly reason: 'projects-per-account'; readonly limit: number; readonly actual: number; readonly serverTime: number };

function findProject(db: SyncDb, accountId: string, projectId: string) {
  return db.prepare('SELECT * FROM sync_projects WHERE account_id=? AND project_id=?').bind(accountId, projectId).first<SyncProjectRow>();
}
function stateFromRow(row: SyncProjectRow | null): SyncProjectState {
  return Object.freeze({ revision: row?.revision ?? 0, entities: row ? normalizeSyncEntities(JSON.parse(row.entities)) : Object.freeze([]) });
}
export async function readSyncProject(deps: SyncServiceDeps, accountId: string, projectId: string): Promise<SyncProjectState> {
  return stateFromRow(await findProject(deps.db.withSession('first-primary'), accountId, projectId));
}
function transitionConflicts(current: readonly SyncMutation[], next: readonly SyncMutation[]): string[] {
  const existing = new Map(current.map((row) => [syncEntityKey(row), row]));
  const proposed = new Map(next.map((row) => [syncEntityKey(row), row]));
  const conflicts = new Set<string>();
  for (const [key, row] of existing) {
    const candidate = proposed.get(key);
    if (!candidate) { conflicts.add(key); continue; }
    if (canonicalSyncJson(candidate) === canonicalSyncJson(row)) continue;
    if (candidate.baseVersion !== row.entityVersion || candidate.entityVersion !== row.entityVersion + 1) conflicts.add(key);
  }
  for (const [key, row] of proposed) if (!existing.has(key) && (row.baseVersion !== 0 || row.entityVersion !== 1)) conflicts.add(key);
  return [...conflicts].sort();
}
function conflict(reason: SyncConflictReason, expectedRevision: number, actualRevision: number, conflictingEntityIds: readonly string[], serverTime: number): SyncCasResult {
  return { ok: false, reason, expectedRevision, actualRevision, conflictingEntityIds: Object.freeze([...conflictingEntityIds].sort()), serverTime };
}
export async function compareAndSwapSyncProject(deps: SyncServiceDeps, input: { readonly accountId: string; readonly projectId: string; readonly expectedRevision: number; readonly entities: unknown }): Promise<SyncCasResult> {
  const entities = normalizeSyncEntities(input.entities, { maxEntities: deps.limits?.maxEntitiesPerProject, maxStateBytes: deps.limits?.maxStateBytes });
  const serialized = canonicalSyncJson(entities);
  const stateBytes = new TextEncoder().encode(serialized).byteLength;
  const serverTime = (deps.now ?? Date.now)();
  const db = deps.db.withSession('first-primary');
  const keys = entities.map(syncEntityKey);
  if (input.expectedRevision === 0) {
    const invalid = transitionConflicts([], entities);
    if (invalid.length) return conflict('entity-version-conflict', 0, 0, invalid, serverTime);
    const limit = deps.limits?.maxProjectsPerAccount ?? SYNC_MAX_PROJECTS_PER_ACCOUNT;
    // Quota check and create are one serialized SQLite write, so competing
    // projects cannot both claim the final slot.
    const created = await db.prepare(`INSERT INTO sync_projects(account_id,project_id,revision,entities,entity_count,state_bytes,updated_at)
      SELECT ?,?,1,?,?,?,? WHERE (SELECT count(*) FROM sync_projects WHERE account_id=?) < ?
      ON CONFLICT(account_id,project_id) DO NOTHING RETURNING revision`).bind(input.accountId, input.projectId, serialized, entities.length, stateBytes, serverTime, input.accountId, limit).first<{ revision: number }>();
    if (created) return { ok: true, revision: created.revision, serverTime };
    const raced = await findProject(db, input.accountId, input.projectId);
    if (raced) return conflict('revision-conflict', 0, raced.revision, keys, serverTime);
    const usage = await db.prepare('SELECT count(*) AS count FROM sync_projects WHERE account_id=?').bind(input.accountId).first<{ count: number }>();
    return { ok: false, reason: 'projects-per-account', limit, actual: (usage?.count ?? 0) + 1, serverTime };
  }
  const current = await findProject(db, input.accountId, input.projectId);
  if (!current || current.revision !== input.expectedRevision) return conflict('revision-conflict', input.expectedRevision, current?.revision ?? 0, keys, serverTime);
  const invalid = transitionConflicts(stateFromRow(current).entities, entities);
  if (invalid.length) return conflict('entity-version-conflict', input.expectedRevision, current.revision, invalid, serverTime);
  const updated = await db.prepare('UPDATE sync_projects SET revision=revision+1,entities=?,entity_count=?,state_bytes=?,updated_at=? WHERE account_id=? AND project_id=? AND revision=? RETURNING revision').bind(serialized, entities.length, stateBytes, serverTime, input.accountId, input.projectId, input.expectedRevision).first<{ revision: number }>();
  if (updated) return { ok: true, revision: updated.revision, serverTime };
  const raced = await findProject(db, input.accountId, input.projectId);
  return conflict('revision-conflict', input.expectedRevision, raced?.revision ?? 0, keys, serverTime);
}

const casBodySchema = z.object({ expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1), entities: z.array(z.unknown()).max(SYNC_MAX_ENTITIES_PER_PROJECT) }).strict();
export const syncRoutes = new Hono<AppEnv>();
syncRoutes.use('/sync/*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); }, requireNativeAuth, requirePro);
syncRoutes.get('/sync/projects/:projectId', async (c) => {
  const path = syncProjectIdSchema.safeParse(c.req.param('projectId'));
  if (!path.success) return c.json({ ok: false, error: 'invalid-sync-state' }, 400);
  const state = await readSyncProject({ db: c.env.DB }, c.get('session').account_id, path.data);
  return c.json({ ok: true, data: { projectId: path.data, ...state, serverTime: Date.now() } });
});
syncRoutes.put('/sync/projects/:projectId', async (c) => {
  const path = syncProjectIdSchema.safeParse(c.req.param('projectId'));
  let raw: unknown;
  try { raw = JSON.parse(await readBoundedBody(c.req.raw)); } catch (error) { if (error instanceof HTTPException && error.status === 413) throw error; return c.json({ ok: false, error: 'invalid-sync-state' }, 400); }
  const body = casBodySchema.safeParse(raw);
  if (!path.success || !body.success) return c.json({ ok: false, error: 'invalid-sync-state' }, 400);
  try {
    const result = await compareAndSwapSyncProject({ db: c.env.DB }, { accountId: c.get('session').account_id, projectId: path.data, ...body.data });
    if (result.ok) return c.json({ ok: true, data: { revision: result.revision, serverTime: result.serverTime } });
    if (result.reason === 'projects-per-account') return c.json({ ok: false, error: 'quota-exceeded', quota: { name: result.reason, limit: result.limit, actual: result.actual } }, 413);
    return c.json({ ok: false, error: result.reason, conflict: { expectedRevision: result.expectedRevision, actualRevision: result.actualRevision, conflictingEntityIds: result.conflictingEntityIds, serverTime: result.serverTime } }, 409);
  } catch (error) {
    if (error instanceof SyncContractQuotaError) return c.json({ ok: false, error: 'quota-exceeded', quota: { name: error.quota, limit: error.limit, actual: error.actual } }, 413);
    if (error instanceof SyncContractValidationError) return c.json({ ok: false, error: 'invalid-sync-state' }, 400);
    throw error;
  }
});
