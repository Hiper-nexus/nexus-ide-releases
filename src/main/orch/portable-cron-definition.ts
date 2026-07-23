import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  assertNoCredentialMaterial,
  assertPortableText,
} from '../../../shared/sync-contract';
import { parseCronExpr } from './cron-loop';

export const portableProjectIdSchema = z.string().uuid();
export const portableScheduleIdSchema = z.string().uuid();
export const cronDefinitionHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

function isPortableText(value: string): boolean {
  try {
    assertPortableText(value);
    return true;
  } catch {
    return false;
  }
}

function portableText(schema: z.ZodString): z.ZodString {
  return schema.refine(isPortableText, 'value is not sync-safe');
}

function credentialFreeText(schema: z.ZodString): z.ZodString {
  return schema.refine((value) => {
    try {
      assertNoCredentialMaterial(value);
      return true;
    } catch {
      return false;
    }
  }, 'credential material is forbidden');
}

export const portableWorkingDirectorySchema = credentialFreeText(
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
      'working directory must be a normalized relative project path',
    ),
);

export const portableCronDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    name: portableText(z.string().trim().min(1).max(120)),
    schedule: z
      .string()
      .trim()
      .min(1)
      .max(512)
      .refine((value) => {
        try {
          parseCronExpr(value);
          return true;
        } catch {
          return false;
        }
      }, 'invalid cron expression'),
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

export type PortableCronDefinition = z.infer<
  typeof portableCronDefinitionSchema
>;

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

export function cronDefinitionHash(raw: unknown): string {
  const definition = portableCronDefinitionSchema.parse(raw);
  return createHash('sha256')
    .update(JSON.stringify(canonicalValue(definition)))
    .digest('hex');
}

export interface PortableCronSchedule {
  readonly projectId: string;
  readonly scheduleId: string;
  readonly version: number;
  readonly definition: PortableCronDefinition;
  readonly definitionHash: string;
  readonly updatedAt: number;
}

export type PublishPortableScheduleResult =
  | { readonly ok: true; readonly created: boolean; readonly schedule: PortableCronSchedule }
  | {
      readonly ok: false;
      readonly reason: 'version-conflict' | 'backend-unavailable';
      readonly expectedVersion: number;
      readonly actualVersion: number;
      readonly current: PortableCronSchedule | null;
    };

export interface PortableCronScheduleRequestOptions {
  readonly signal?: AbortSignal;
}

export interface PortableCronScheduleBackend {
  list(
    projectId: string,
    options?: PortableCronScheduleRequestOptions,
  ): Promise<
    | { readonly ok: true; readonly schedules: readonly PortableCronSchedule[] }
    | { readonly ok: false; readonly reason: 'backend-unavailable' }
  >;
  publish(
    projectId: string,
    scheduleId: string,
    expectedVersion: number,
    definition: PortableCronDefinition,
    options?: PortableCronScheduleRequestOptions,
  ): Promise<PublishPortableScheduleResult>;
}
