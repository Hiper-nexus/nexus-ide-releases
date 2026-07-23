/**
 * Plan-mode tools — write/read mission plan.md (grok-build plan mode).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { McpToolDef } from './mcp-protocol';
import { assertMcpInvocationCurrent } from './mcp-protocol';
import { str } from './tool-util';
import { resolvePathForScope } from './workspace-path';
import { executionScopeFor } from './gate';
import { isPlanLaneWritablePath } from '../../shared/mission-intent';
import { writeWorkspaceTextFile } from './workspace-file';

const planWrite: McpToolDef = {
  name: 'nexus_plan_write',
  description:
    'Write the mission plan document (plan.md). Allowed in plan lane. ' +
    'Content is the full plan markdown (context, approach, files, verification).',
  inputSchema: {
    type: 'object',
    properties: {
      content: { type: 'string' },
      path: {
        type: 'string',
        description: 'Relative path (default plan.md). Only plan.md or docs/plan.md.',
      },
    },
    required: ['content'],
  },
  handler: async (args, ctx, invocation) => {
    const content = str(args, 'content') ?? '';
    if (content.trim().length < 20) {
      throw new Error('plan content too short (min 20 characters of real plan text)');
    }
    if (content.length > 200_000) {
      throw new Error('plan content too large (max 200KB)');
    }
    const rel = (str(args, 'path') ?? 'plan.md').replaceAll('\\', '/').replace(/^\.\//, '');
    if (rel.includes('..') || path.isAbsolute(rel)) {
      throw new Error('plan path must be relative plan.md or docs/plan.md');
    }
    if (!isPlanLaneWritablePath(rel)) {
      throw new Error(
        `plan writes only allowed to plan.md or docs/plan.md (got ${rel})`,
      );
    }
    const scope = executionScopeFor(ctx);
    assertMcpInvocationCurrent(invocation);
    writeWorkspaceTextFile(scope, rel, content);
    return { ok: true, path: rel, bytes: Buffer.byteLength(content, 'utf8') };
  },
};

const planRead: McpToolDef = {
  name: 'nexus_plan_read',
  description: 'Read the mission plan.md if present.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
    },
  },
  handler: async (args, ctx) => {
    const rel = (str(args, 'path') ?? 'plan.md').replaceAll('\\', '/');
    if (!isPlanLaneWritablePath(rel)) {
      throw new Error('invalid plan path');
    }
    const scope = executionScopeFor(ctx);
    const abs = resolvePathForScope(scope, rel);
    if (!fs.existsSync(abs)) {
      return { ok: true, exists: false, content: null };
    }
    const content = fs.readFileSync(abs, 'utf8');
    return { ok: true, exists: true, content, path: rel };
  },
};

export function buildPlanTools(): McpToolDef[] {
  return [planWrite, planRead];
}
