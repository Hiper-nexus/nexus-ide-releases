// Portable cron contract adapted from nexus-ide/server/src/cron/cron-contract.ts.
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv } from './context.js';
import type { CronScheduleRow } from './db/schema.js';
import { requireNativeAuth } from './middleware.js';
import { readBoundedBody } from './http.js';
import { hashToken, randomToken } from './crypto.js';
import { z } from 'zod';
import {
  assertNoCredentialMaterial,
  assertPortableText,
} from './sync.js';

export const portableProjectIdSchema = z.string().uuid();
export const portableScheduleIdSchema = z.string().uuid();
export const definitionHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

const portableWorkingDirectorySchema = credentialFreeText(
  z
    .string()
    .min(1)
    .max(1_024)
    .refine(
      (value) =>
        !value.startsWith('/') &&
        !value.includes('\\') &&
        !value
          .split('/')
          .some((segment) => segment === '' || segment === '.' || segment === '..') &&
        !/^[A-Za-z]:/.test(value),
    ),
);

function validCronField(raw: string, min: number, max: number): boolean {
  return raw.split(',').every((part) => {
    const [range, stepRaw, extra] = part.split('/');
    if (extra !== undefined) return false;
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) return false;
    if (range === '*') return true;
    const [left, right, extraRange] = range.split('-');
    if (extraRange !== undefined) return false;
    const low = Number(left);
    const high = right === undefined ? low : Number(right);
    return (
      Number.isInteger(low) &&
      Number.isInteger(high) &&
      low >= min &&
      high <= max &&
      low <= high
    );
  });
}

function validCronExpression(value: string): boolean {
  const fields = value.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return (
    validCronField(fields[0], 0, 59) &&
    validCronField(fields[1], 0, 23) &&
    validCronField(fields[2], 1, 31) &&
    validCronField(fields[3], 1, 12) &&
    validCronField(fields[4], 0, 6)
  );
}

function portableText(schema: z.ZodString): z.ZodString {
  return schema.superRefine((value, context) => {
    try {
      assertPortableText(value as string);
    } catch (error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : 'value is not portable',
      });
    }
  });
}

function credentialFreeText(schema: z.ZodString): z.ZodString {
  return schema.superRefine((value, context) => {
    try {
      assertNoCredentialMaterial(value as string);
    } catch (error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          error instanceof Error ? error.message : 'credential material is forbidden',
      });
    }
  });
}

export const portableCronDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    name: portableText(z.string().trim().min(1).max(120)),
    schedule: z.string().trim().min(1).max(512).refine(validCronExpression),
    brief: portableText(z.string().max(64 * 1024)),
    workingDirectory: portableWorkingDirectorySchema.optional(),
    target: z
      .object({
        kind: z.enum(['agent', 'squad']),
        id: portableText(z.string().trim().min(1).max(256)),
      })
      .strict(),
    status: z.enum(['active', 'paused', 'deleted']),
  })
  .strict();

export type PortableCronDefinition = z.infer<typeof portableCronDefinitionSchema>;

export const publishScheduleSchema = z
  .object({
    expectedVersion: z.number().int().min(0).max(2_147_483_646),
    definition: portableCronDefinitionSchema,
  })
  .strict();

export const leaseRequestSchema = z
  .object({
    projectId: portableProjectIdSchema,
    scheduleId: portableScheduleIdSchema,
    definitionVersion: z.number().int().positive().max(2_147_483_647),
    definitionHash: definitionHashSchema,
    occurrenceAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    ttlMs: z.number().int().min(1_000).max(24 * 60 * 60_000),
  })
  .strict();

export const leaseTokenRequestSchema = leaseRequestSchema.extend({
  token: z.string().min(1).max(4_096),
});

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalValue(child)]),
    );
  }
  return value;
}

export async function cronDefinitionHash(raw: unknown): Promise<string> {
  const definition = portableCronDefinitionSchema.parse(raw);
  return hashToken(JSON.stringify(canonicalValue(definition)));
}

export interface CronServiceDeps { readonly db: D1Database; readonly now?: () => number; readonly makeToken?: () => string; }
export interface StoredCronSchedule { readonly projectId: string; readonly scheduleId: string; readonly version: number; readonly definition: PortableCronDefinition; readonly definitionHash: string; readonly updatedAt: number; }
export type PublishScheduleResult =
  | { readonly ok: true; readonly created: boolean; readonly schedule: StoredCronSchedule }
  | { readonly ok: false; readonly expectedVersion: number; readonly actualVersion: number; readonly current: StoredCronSchedule | null };
export type LeaseOperationResult =
  | { readonly acquired: true; readonly token: string; readonly expiresAt: number; readonly reused: boolean }
  | { readonly acquired: false; readonly reason: 'held-by-peer' | 'expired-or-not-owner' | 'definition-conflict'; readonly retryAt?: number; readonly actualVersion?: number; readonly actualDefinitionHash?: string };
type LeaseCoordinates = z.infer<typeof leaseRequestSchema>;
type CronDb = Pick<D1Database, 'prepare'>;

function scheduleRecord(row: CronScheduleRow): StoredCronSchedule {
  return Object.freeze({ projectId: row.project_id, scheduleId: row.schedule_id, version: row.version, definition: portableCronDefinitionSchema.parse(JSON.parse(row.definition)), definitionHash: row.definition_hash, updatedAt: row.updated_at });
}
async function findSchedule(db: CronDb, accountId: string, projectId: string, scheduleId: string): Promise<StoredCronSchedule | null> {
  const row = await db.prepare('SELECT * FROM cron_schedules WHERE account_id=? AND project_id=? AND schedule_id=?').bind(accountId, projectId, scheduleId).first<CronScheduleRow>();
  return row ? scheduleRecord(row) : null;
}
export async function listCronSchedules(deps: CronServiceDeps, accountId: string, projectId: string): Promise<StoredCronSchedule[]> {
  const rows = await deps.db.withSession('first-primary').prepare('SELECT * FROM cron_schedules WHERE account_id=? AND project_id=? ORDER BY schedule_id').bind(accountId, projectId).all<CronScheduleRow>();
  return rows.results.map(scheduleRecord);
}
export async function publishCronSchedule(deps: CronServiceDeps, input: { readonly accountId: string; readonly projectId: string; readonly scheduleId: string; readonly expectedVersion: number; readonly definition: PortableCronDefinition }): Promise<PublishScheduleResult> {
  const definition = portableCronDefinitionSchema.parse(input.definition);
  const hash = await cronDefinitionHash(definition);
  const now = (deps.now ?? Date.now)();
  const db = deps.db.withSession('first-primary');
  const common = [JSON.stringify(definition), hash, definition.status, now];
  const row = input.expectedVersion === 0
    ? await db.prepare('INSERT INTO cron_schedules(account_id,project_id,schedule_id,version,definition,definition_hash,status,updated_at) VALUES(?,?,?,1,?,?,?,?) ON CONFLICT(account_id,project_id,schedule_id) DO NOTHING RETURNING *').bind(input.accountId, input.projectId, input.scheduleId, ...common).first<CronScheduleRow>()
    : await db.prepare('UPDATE cron_schedules SET version=version+1,definition=?,definition_hash=?,status=?,updated_at=? WHERE account_id=? AND project_id=? AND schedule_id=? AND version=? RETURNING *').bind(...common, input.accountId, input.projectId, input.scheduleId, input.expectedVersion).first<CronScheduleRow>();
  if (row) return { ok: true, created: input.expectedVersion === 0, schedule: scheduleRecord(row) };
  const current = await findSchedule(db, input.accountId, input.projectId, input.scheduleId);
  return { ok: false, expectedVersion: input.expectedVersion, actualVersion: current?.version ?? 0, current };
}
async function definitionConflict(db: CronDb, accountId: string, input: LeaseCoordinates): Promise<Extract<LeaseOperationResult, { acquired: false }> | null> {
  const current = await findSchedule(db, accountId, input.projectId, input.scheduleId);
  if (!current || current.version !== input.definitionVersion || current.definitionHash !== input.definitionHash || current.definition.status !== 'active') {
    return { acquired: false, reason: 'definition-conflict', actualVersion: current?.version ?? 0, ...(current ? { actualDefinitionHash: current.definitionHash } : {}) };
  }
  return null;
}
export async function acquireCronLease(deps: CronServiceDeps, accountId: string, input: LeaseCoordinates): Promise<LeaseOperationResult> {
  const now = (deps.now ?? Date.now)();
  const expiresAt = now + input.ttlMs;
  const token = (deps.makeToken ?? randomToken)();
  const tokenHash = await hashToken(token);
  const db = deps.db.withSession('first-primary');
  // Schedule fencing, expired lease takeover and token assignment are one write.
  const row = await db.prepare(`INSERT INTO cron_leases(account_id,project_id,schedule_id,occurrence_at,token_hash,version,expires_at,updated_at)
    SELECT account_id,project_id,schedule_id,?,?,1,?,? FROM cron_schedules
    WHERE account_id=? AND project_id=? AND schedule_id=? AND version=? AND definition_hash=? AND status='active'
    ON CONFLICT(account_id,project_id,schedule_id,occurrence_at) DO UPDATE SET token_hash=excluded.token_hash,expires_at=excluded.expires_at,updated_at=excluded.updated_at,version=cron_leases.version+1
    WHERE cron_leases.token_hash IS NULL OR cron_leases.expires_at<=? RETURNING expires_at`).bind(input.occurrenceAt, tokenHash, expiresAt, now, accountId, input.projectId, input.scheduleId, input.definitionVersion, input.definitionHash, now).first<{ expires_at: number }>();
  if (row) return { acquired: true, token, expiresAt: row.expires_at, reused: false };
  const conflict = await definitionConflict(db, accountId, input);
  if (conflict) return conflict;
  const held = await db.prepare('SELECT expires_at FROM cron_leases WHERE account_id=? AND project_id=? AND schedule_id=? AND occurrence_at=?').bind(accountId, input.projectId, input.scheduleId, input.occurrenceAt).first<{ expires_at: number }>();
  return { acquired: false, reason: 'held-by-peer', ...(held ? { retryAt: held.expires_at } : {}) };
}
export async function renewCronLease(deps: CronServiceDeps, accountId: string, input: LeaseCoordinates & { readonly token: string }): Promise<LeaseOperationResult> {
  const now = (deps.now ?? Date.now)();
  const db = deps.db.withSession('first-primary');
  const row = await db.prepare(`UPDATE cron_leases SET expires_at=?,updated_at=?,version=version+1
    WHERE account_id=? AND project_id=? AND schedule_id=? AND occurrence_at=? AND token_hash=? AND expires_at>?
    AND EXISTS(SELECT 1 FROM cron_schedules WHERE account_id=? AND project_id=? AND schedule_id=? AND version=? AND definition_hash=? AND status='active') RETURNING expires_at`).bind(now + input.ttlMs, now, accountId, input.projectId, input.scheduleId, input.occurrenceAt, await hashToken(input.token), now, accountId, input.projectId, input.scheduleId, input.definitionVersion, input.definitionHash).first<{ expires_at: number }>();
  if (row) return { acquired: true, token: input.token, expiresAt: row.expires_at, reused: true };
  return (await definitionConflict(db, accountId, input)) ?? { acquired: false, reason: 'expired-or-not-owner' };
}
export async function releaseCronLease(deps: CronServiceDeps, accountId: string, input: LeaseCoordinates & { readonly token: string }): Promise<boolean> {
  const now = (deps.now ?? Date.now)();
  const row = await deps.db.withSession('first-primary').prepare('UPDATE cron_leases SET token_hash=NULL,expires_at=?,updated_at=?,version=version+1 WHERE account_id=? AND project_id=? AND schedule_id=? AND occurrence_at=? AND token_hash=? RETURNING version').bind(now, now, accountId, input.projectId, input.scheduleId, input.occurrenceAt, await hashToken(input.token)).first();
  return row !== null;
}

async function parsedBody<T>(request: Request, schema: z.ZodType<T>): Promise<T | null> {
  let value: unknown;
  try { value = JSON.parse(await readBoundedBody(request)); } catch (error) { if (error instanceof HTTPException && error.status === 413) throw error; return null; }
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
export const cronRoutes = new Hono<AppEnv>();
cronRoutes.use('/cron/*', requireNativeAuth);
cronRoutes.get('/cron/projects/:projectId/schedules', async (c) => {
  const project = portableProjectIdSchema.safeParse(c.req.param('projectId'));
  if (!project.success) return c.json({ ok: false, error: 'invalid-project' }, 400);
  return c.json({ ok: true, data: await listCronSchedules({ db: c.env.DB }, c.get('session').account_id, project.data) });
});
cronRoutes.put('/cron/projects/:projectId/schedules/:scheduleId', async (c) => {
  const project = portableProjectIdSchema.safeParse(c.req.param('projectId'));
  const schedule = portableScheduleIdSchema.safeParse(c.req.param('scheduleId'));
  const body = await parsedBody(c.req.raw, publishScheduleSchema);
  if (!project.success || !schedule.success || !body) return c.json({ ok: false, error: 'invalid-schedule' }, 400);
  const result = await publishCronSchedule({ db: c.env.DB }, { accountId: c.get('session').account_id, projectId: project.data, scheduleId: schedule.data, ...body });
  if (!result.ok) return c.json({ ok: false, error: 'version-conflict', conflict: { expectedVersion: result.expectedVersion, actualVersion: result.actualVersion, current: result.current } }, 409);
  return c.json({ ok: true, data: result.schedule }, result.created ? 201 : 200);
});
cronRoutes.post('/cron/leases/acquire', async (c) => {
  const body = await parsedBody(c.req.raw, leaseRequestSchema);
  if (!body) return c.json({ ok: false, error: 'invalid-lease' }, 400);
  const result = await acquireCronLease({ db: c.env.DB }, c.get('session').account_id, body);
  return c.json({ ok: result.acquired, data: result }, result.acquired ? 200 : 409);
});
cronRoutes.post('/cron/leases/renew', async (c) => {
  const body = await parsedBody(c.req.raw, leaseTokenRequestSchema);
  if (!body) return c.json({ ok: false, error: 'invalid-lease' }, 400);
  const result = await renewCronLease({ db: c.env.DB }, c.get('session').account_id, body);
  return c.json({ ok: result.acquired, data: result }, result.acquired ? 200 : 409);
});
cronRoutes.post('/cron/leases/release', async (c) => {
  const body = await parsedBody(c.req.raw, leaseTokenRequestSchema);
  if (!body) return c.json({ ok: false, error: 'invalid-lease' }, 400);
  const released = await releaseCronLease({ db: c.env.DB }, c.get('session').account_id, body);
  return c.json({ ok: released, data: { released } }, released ? 200 : 409);
});
