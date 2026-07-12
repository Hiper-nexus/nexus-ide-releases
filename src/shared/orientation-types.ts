import { z } from 'zod';

/**
 * Project Orientation Map (L1) — structural, regenerable, non-authoritative.
 * See docs/superpowers/specs/2026-07-11-project-orientation-map-design.md
 */

export const ORIENTATION_CHANNELS = {
  get: 'orientation:get',
  ensure: 'orientation:ensure',
  refresh: 'orientation:refresh',
} as const;

export const orientationStatusSchema = z.enum([
  'ready',
  'partial',
  'stale',
  'building',
  'failed',
]);

export type OrientationStatus = z.infer<typeof orientationStatusSchema>;

/** Compact payload for renderer / kickoff (not the full map). */
export const orientationSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId: z.string().min(1).max(256),
    checkoutId: z.string().min(1).max(256),
    headSha: z.string().nullable(),
    treeFingerprint: z.string().min(1).max(128),
    builtAt: z.string().min(1).max(64),
    buildDurationMs: z.number().int().nonnegative(),
    status: orientationStatusSchema,
    error: z.string().max(4_096).optional(),
    mapHash: z.string().regex(/^[a-f0-9]{64}$/),
    contextReady: z.boolean(),
    orientationMarkdown: z.string().max(24_000),
  })
  .strict();

export type OrientationSnapshot = z.infer<typeof orientationSnapshotSchema>;
