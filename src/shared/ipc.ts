import path from 'node:path';
import { z } from 'zod';
import type { LayoutNode, WorkspaceLayout } from './types';

/**
 * Zod schemas validating every IPC payload the main process accepts. These run
 * at the trust boundary: the renderer is treated as untrusted input, so nothing
 * reaches the PTY layer or the filesystem without passing validation here.
 */

const DIMENSION = z.number().int().positive().max(2000);

export const spawnRequestSchema = z.object({
  cwd: z.string().min(1).max(4096).optional(),
  // A caller-supplied shell must be an absolute path — never a bare command name
  // resolved against PATH — so the renderer cannot coax the main process into
  // launching an arbitrary binary off the search path.
  shell: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => path.isAbsolute(value), {
      message: 'shell must be an absolute path',
    })
    .optional(),
  cols: DIMENSION,
  rows: DIMENSION,
  kind: z.enum(['shell', 'cli-agent']),
});

export const writeSchema = z.object({
  sessionId: z.string().min(1).max(128),
  data: z.string().max(1_000_000),
});

export const resizeSchema = z.object({
  sessionId: z.string().min(1).max(128),
  cols: DIMENSION,
  rows: DIMENSION,
});

export const killSchema = z.object({
  sessionId: z.string().min(1).max(128),
});

const paneModelSchema = z.object({
  id: z.string().min(1).max(128),
  kind: z.enum(['shell', 'cli-agent']),
  title: z.string().max(512),
  cwd: z.string().max(4096).optional(),
});

// Recursive layout tree schema (leaf | split with two children).
export const layoutNodeSchema: z.ZodType<LayoutNode> = z.lazy(() =>
  z.union([
    z.object({
      kind: z.literal('leaf'),
      id: z.string().min(1).max(128),
      pane: paneModelSchema,
    }),
    z.object({
      kind: z.literal('split'),
      id: z.string().min(1).max(128),
      direction: z.enum(['row', 'column']),
      children: z.tuple([layoutNodeSchema, layoutNodeSchema]),
    }),
  ]),
);

export const workspaceLayoutSchema: z.ZodType<WorkspaceLayout> = z.object({
  root: layoutNodeSchema,
  focusedPaneId: z.string().min(1).max(128).nullable(),
});
