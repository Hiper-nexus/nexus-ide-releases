import crypto from 'node:crypto';
import { z } from 'zod';
import {
  assertNoCredentialMaterial,
  assertPortableText,
} from '../../../shared/sync-contract';

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

function portableText<T extends z.ZodTypeAny>(schema: T): z.ZodEffects<T> {
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

function credentialFreeText<T extends z.ZodTypeAny>(
  schema: T,
): z.ZodEffects<T> {
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

export function cronDefinitionHash(raw: unknown): string {
  const definition = portableCronDefinitionSchema.parse(raw);
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalValue(definition)))
    .digest('hex');
}
