import { z } from 'zod';
import { canonicalToolName } from './gate';

export const MAX_MCP_PAYLOAD_BYTES = 256 * 1024;
const MAX_MCP_ARG_DEPTH = 8;
const MAX_OBJECT_KEYS = 200;
const MAX_ARRAY_ITEMS = 1000;

const text = z.string().min(1).max(MAX_MCP_PAYLOAD_BYTES);
const pathText = z.string().min(1).max(4096).refine((value) => !value.includes('\0'), {
  message: 'path cannot contain NUL',
});
const optionalPathText = pathText.optional();
const positiveInt = z.number().int().positive();
const timeoutMs = z.number().int().positive().max(300_000).optional();
const envSchema = z.record(z.string().min(1).max(128), z.string().max(4096)).optional();
const paneId = z.string().min(1).max(128);
const browserRef = z.string().regex(/^e[1-9]\d{0,7}$/);
const uiRef = z.string().regex(/^u[1-9]\d{0,15}e[1-9]\d{0,7}$/);
const uiActionSchema = z
  .object({
    action: z.enum(['click', 'focus', 'fill', 'select']),
    ref: uiRef,
    text: z.string().max(8192).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const needsText = value.action === 'fill' || value.action === 'select';
    if (needsText && typeof value.text !== 'string') {
      ctx.addIssue({
        code: 'custom',
        path: ['text'],
        message: `text is required when action=${value.action}`,
      });
    }
    if (!needsText && value.text !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['text'],
        message: `text is not allowed when action=${value.action}`,
      });
    }
  });
const browserWaitSchema = z
  .object({
    paneId,
    condition: z.enum(['load', 'text', 'ref']),
    value: z.string().min(1).max(256).optional(),
    ref: browserRef.optional(),
    timeoutMs: z.number().int().positive().max(15_000).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.condition === 'text' && !value.value) {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'value is required when condition=text',
      });
    }
    if (value.condition === 'ref' && !value.ref) {
      ctx.addIssue({
        code: 'custom',
        path: ['ref'],
        message: 'ref is required when condition=ref',
      });
    }
  });

const auditSourceSchema = z
  .object({
    path: pathText.optional(),
    content: z.string().min(1).max(MAX_MCP_PAYLOAD_BYTES).optional(),
    source: z.string().min(1).max(512).optional(),
    provenance: z
      .enum([
        'unknown',
        'user',
        'repo-trusted',
        'repo-untrusted',
        'web-page',
        'mcp-tool-result',
        'mcp-tool-description',
        'file-external',
      ])
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.path === undefined) === (value.content === undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'provide exactly one of path or content',
      });
    }
  });

const schemas = new Map<string, z.ZodType<Record<string, unknown>>>([
  ['load_workspace_dependencies', z.object({}).strict()],
  [
    'terminal_run',
    z.object({
      command: text.max(8192),
      cwd: optionalPathText,
      timeoutMs,
      env: envSchema,
    }).strict(),
  ],
  [
    'terminal_kill',
    z.object({ processId: z.string().min(1).max(128).optional() }).strict(),
  ],
  [
    'file_open',
    z.object({ path: pathText, encoding: z.string().min(1).max(32).optional() }).strict(),
  ],
  ['file_close', z.object({ path: pathText }).strict()],
  [
    'file_read',
    z.object({
      path: pathText,
      offset: positiveInt.optional(),
      limit: positiveInt.max(20_000).optional(),
      encoding: z.string().min(1).max(32).optional(),
    }).strict(),
  ],
  [
    'file_write',
    z.object({
      path: pathText,
      content: z.string().max(MAX_MCP_PAYLOAD_BYTES),
      encoding: z.string().min(1).max(32).optional(),
    }).strict(),
  ],
  [
    'file_search',
    z.object({
      pattern: z.string().min(1).max(512),
      maxResults: positiveInt.max(1000).optional(),
    }).strict(),
  ],
  ['git_status', z.object({ cwd: optionalPathText }).strict()],
  ['git_sync', z.object({ cwd: optionalPathText }).strict()],
  [
    'git_add',
    z.object({
      paths: z.array(pathText).min(1).max(200).optional(),
      cwd: optionalPathText,
    }).strict(),
  ],
  [
    'git_commit',
    z.object({ message: text.max(4096), cwd: optionalPathText }).strict(),
  ],
  [
    'git_push',
    z.object({
      remote: z.string().min(1).max(512).optional(),
      branch: z.string().min(1).max(512).optional(),
      cwd: optionalPathText,
    }).strict(),
  ],
  [
    'git_pull',
    z.object({
      remote: z.string().min(1).max(512).optional(),
      branch: z.string().min(1).max(512).optional(),
      rebase: z.boolean().optional(),
      cwd: optionalPathText,
    }).strict(),
  ],
  ['git_diff', z.object({ staged: z.boolean().optional(), cwd: optionalPathText }).strict()],
  [
    'git_log',
    z.object({ count: positiveInt.max(100).optional(), cwd: optionalPathText }).strict(),
  ],
  ['git_branch_list', z.object({ cwd: optionalPathText }).strict()],
  [
    'git_branch_create',
    z.object({ name: z.string().min(1).max(255), cwd: optionalPathText }).strict(),
  ],
  [
    'git_branch_switch',
    z.object({ name: z.string().min(1).max(255), cwd: optionalPathText }).strict(),
  ],
  [
    'editor_focus',
    z.object({
      path: pathText,
      line: positiveInt.optional(),
      column: positiveInt.optional(),
    }).strict(),
  ],
  [
    'editor_insert',
    z.object({
      path: pathText,
      text: z.string().max(MAX_MCP_PAYLOAD_BYTES),
      line: positiveInt,
      column: z.number().int().min(0).optional(),
    }).strict(),
  ],
  [
    'editor_replace_selection',
    z.object({
      path: pathText,
      oldText: z.string().min(1).max(MAX_MCP_PAYLOAD_BYTES),
      newText: z.string().max(MAX_MCP_PAYLOAD_BYTES),
      replaceAll: z.boolean().optional(),
    }).strict(),
  ],
  [
    'editor_goto_line',
    z.object({
      path: pathText,
      line: positiveInt,
      column: positiveInt.optional(),
    }).strict(),
  ],
  [
    'browser_open',
    z
      .object({
        url: z.string().min(1).max(4096),
        title: z.string().min(1).max(512).optional(),
      })
      .strict(),
  ],
  [
    'browser_navigate',
    z.object({ paneId, url: z.string().min(1).max(4096) }).strict(),
  ],
  ['browser_screenshot', z.object({ paneId }).strict()],
  [
    'browser_read',
    z
      .object({
        paneId,
        maxChars: positiveInt.max(20_000).optional(),
        maxElements: positiveInt.max(200).optional(),
      })
      .strict(),
  ],
  ['browser_inspect', z.object({ paneId, ref: browserRef }).strict()],
  ['browser_click', z.object({ paneId, ref: browserRef }).strict()],
  [
    'browser_fill',
    z.object({ paneId, ref: browserRef, text: z.string().max(8192) }).strict(),
  ],
  ['browser_wait', browserWaitSchema],
  ['ui_action', uiActionSchema],
  ['content_audit', auditSourceSchema],
  ['security_audit', auditSourceSchema],
]);

function assertArgsShape(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('tool arguments must be an object');
  }
}

function assertPayloadLimits(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): void {
  if (depth > MAX_MCP_ARG_DEPTH) {
    throw new Error(`tool arguments exceed max depth ${MAX_MCP_ARG_DEPTH}`);
  }
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) throw new Error('tool arguments cannot contain cycles');
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS) {
      throw new Error(`tool arguments exceed max array length ${MAX_ARRAY_ITEMS}`);
    }
    value.forEach((item) => assertPayloadLimits(item, depth + 1, seen));
    return;
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_OBJECT_KEYS) {
    throw new Error(`tool arguments exceed max object keys ${MAX_OBJECT_KEYS}`);
  }
  entries.forEach(([, child]) => assertPayloadLimits(child, depth + 1, seen));
}

function assertSerializedSize(args: Record<string, unknown>): void {
  const serialized = JSON.stringify(args);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_MCP_PAYLOAD_BYTES) {
    throw new Error(`tool arguments exceed ${MAX_MCP_PAYLOAD_BYTES} bytes`);
  }
}

export function validateToolArgs(
  toolName: string,
  rawArgs: unknown,
): Record<string, unknown> {
  const args = rawArgs ?? {};
  assertArgsShape(args);
  assertPayloadLimits(args);
  assertSerializedSize(args);

  const schema = schemas.get(canonicalToolName(toolName));
  if (!schema) return args;
  return schema.parse(args);
}
