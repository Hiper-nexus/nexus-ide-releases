import { z } from 'zod';
import { canonicalToolName } from './gate';
import { CHECKPOINT_REF_PATTERN } from '../git/hidden-checkpoint';

export const MAX_MCP_PAYLOAD_BYTES = 256 * 1024;
// F-1302: 16 cobre um `expect.schema` realista de pane_spawn (lista de objetos
// tipados ≈ profundidade 11 com anyOf); a largura já é limitada por keys/items.
const MAX_MCP_ARG_DEPTH = 16;
const MAX_OBJECT_KEYS = 200;
const MAX_ARRAY_ITEMS = 1000;

const text = z.string().min(1).max(MAX_MCP_PAYLOAD_BYTES);
const pathText = z.string().min(1).max(4096).refine((value) => !value.includes('\0'), {
  message: 'path cannot contain NUL',
});
const optionalPathText = pathText.optional();
// Git ref restrictions, not shell escaping: PR fields are sent as JSON.
const prBranch = z.string().min(1).max(255)
  .refine((value) => !/[\x00-\x20\x7f~^:?*\[\\]/.test(value) &&
    value !== 'HEAD' && value !== '@' && !value.startsWith('-') &&
    !value.includes('..') && !value.includes('@{') && !value.endsWith('.') &&
    value.split('/').every((part) => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock')),
  { message: 'invalid PR branch name' });
export const prCreateArgsSchema = z.object({
  title: z.string().trim().min(1).max(256).refine((value) => !/[\0\r\n]/.test(value)),
  body: z.string().max(65_536).refine((value) => !value.includes('\0')),
  head: prBranch.optional(),
  base: prBranch.optional(),
  draft: z.boolean().optional(),
  cwd: optionalPathText,
}).strict();
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

/** Inline `read` arg shared by every mutating browser tool. */
const browserInlineReadSchema = z
  .union([
    z.boolean(),
    z
      .object({
        maxChars: positiveInt.max(20_000).optional(),
        maxElements: positiveInt.max(200).optional(),
        format: z.enum(['json', 'compact']).optional(),
      })
      .strict(),
  ])
  .optional();
const browserJudgeArg = z.boolean().optional();

const browserClickSchema = z
  .object({
    paneId,
    ref: browserRef.optional(),
    text: z.string().min(1).max(200).optional(),
    read: browserInlineReadSchema,
    judge: browserJudgeArg,
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.ref === undefined) === (value.text === undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: 'provide exactly one of ref or text',
      });
    }
  });

const browserFillSchema = z
  .object({
    paneId,
    ref: browserRef.optional(),
    label: z.string().min(1).max(200).optional(),
    text: z.string().max(8192),
    read: browserInlineReadSchema,
    judge: browserJudgeArg,
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.ref === undefined) === (value.label === undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: 'provide exactly one of ref or label',
      });
    }
  });

const browserSelectSchema = z
  .object({
    paneId,
    ref: browserRef.optional(),
    label: z.string().min(1).max(200).optional(),
    option: z.string().min(1).max(200).optional(),
    value: z.string().max(1_000).optional(),
    index: z.number().int().min(0).max(100_000).optional(),
    read: browserInlineReadSchema,
    judge: browserJudgeArg,
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.ref === undefined) === (value.label === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'provide exactly one of ref or label' });
    }
    const choices = [value.option, value.value, value.index].filter((item) => item !== undefined);
    if (choices.length !== 1) {
      ctx.addIssue({ code: 'custom', message: 'provide exactly one of option, value or index' });
    }
  });

const browserExtractFieldSchema = z
  .object({
    name: z.string().min(1).max(64),
    type: z.enum(['string', 'number', 'boolean', 'date', 'enum']),
    enum: z.array(z.string().min(1).max(64)).min(1).max(20).optional(),
    hint: z.string().min(1).max(200).optional(),
    // `description` is a common LLM-side synonym for `hint` in JSON Schema
    // tool definitions; accept it without adding a second field downstream.
    description: z.string().min(1).max(200).optional(),
  })
  .strict()
  .transform(({ description, ...value }) => ({
    ...value,
    ...(value.hint === undefined && description !== undefined ? { hint: description } : {}),
  }))
  .superRefine((value, ctx) => {
    if (value.type === 'enum' && !(value.enum && value.enum.length > 0)) {
      ctx.addIssue({
        code: 'custom',
        path: ['enum'],
        message: 'enum options are required when type=enum',
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
    'lsp_symbols',
    z.object({
      path: pathText,
      maxResults: positiveInt.max(100).optional(),
    }).strict(),
  ],
  [
    'lsp_definition',
    z.object({
      path: pathText,
      line: positiveInt,
      column: positiveInt,
      maxResults: positiveInt.max(100).optional(),
    }).strict(),
  ],
  [
    'lsp_references',
    z.object({
      path: pathText,
      line: positiveInt,
      column: positiveInt,
      maxResults: positiveInt.max(100).optional(),
    }).strict(),
  ],
  [
    'lsp_diagnostics',
    z.object({
      path: pathText,
      maxResults: positiveInt.max(100).optional(),
    }).strict(),
  ],
  [
    'terminal_run',
    z.object({
      command: text.max(8192),
      cwd: optionalPathText,
      timeoutMs,
      env: envSchema,
      sandboxProfile: z.enum(['workspace-only', 'workspace-net', 'yolo']).optional(),
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
      hashline: z.boolean().optional(),
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
      // Hard ceilings mirror tools-files.ts (HARD_SEARCH_*).
      maxFiles: positiveInt.max(100_000).optional(),
      maxDirectories: positiveInt.max(20_000).optional(),
      timeoutMs: positiveInt.max(10_000).optional(),
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
  ['checkpoint_list', z.object({ ref: z.string().regex(CHECKPOINT_REF_PATTERN).optional() }).strict()],
  ['checkpoint_restore', z.object({ ref: z.string().regex(CHECKPOINT_REF_PATTERN) }).strict()],
  [
    'git_branch_create',
    z.object({ name: z.string().min(1).max(255), cwd: optionalPathText }).strict(),
  ],
  [
    'git_branch_switch',
    z.object({ name: z.string().min(1).max(255), cwd: optionalPathText }).strict(),
  ],
  ['pr_create', prCreateArgsSchema],
  [
    'pr_inspect',
    z.object({
      number: positiveInt.max(1_000_000).optional(),
      cwd: optionalPathText,
    }).strict(),
  ],
  [
    'pr_enqueue',
    z.object({
      number: positiveInt.max(1_000_000).optional(),
      mode: z.enum(['when-ready', 'now']).optional(),
      mergeMethod: z.enum(['squash', 'merge', 'rebase']).optional(),
      cwd: optionalPathText,
    }).strict(),
  ],
  [
    'pr_auto_merge',
    z.object({
      enabled: z.boolean(),
      number: positiveInt.max(1_000_000).optional(),
      mergeMethod: z.enum(['squash', 'merge', 'rebase']).optional(),
      cwd: optionalPathText,
    }).strict(),
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
    'editor_apply_patch',
    z.object({
      patch: z.string().min(1).max(MAX_MCP_PAYLOAD_BYTES),
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
        // Only an automated design-review pane names its main-provisioned pane.
        paneId: paneId.optional(),
        read: browserInlineReadSchema,
        judge: browserJudgeArg,
        device: z.enum(['mobile', 'tablet', 'desktop']).optional(),
      })
      .strict(),
  ],
  [
    'browser_navigate',
    z
      .object({
        paneId,
        url: z.string().min(1).max(4096).optional(),
        history: z.enum(['back', 'forward', 'reload']).optional(),
        read: browserInlineReadSchema,
        judge: browserJudgeArg,
        device: z.enum(['mobile', 'tablet', 'desktop']).optional(),
      })
      .strict()
      .superRefine((value, ctx) => {
        if ((value.url === undefined) === (value.history === undefined)) {
          ctx.addIssue({ code: 'custom', message: 'provide exactly one of url or history' });
        }
      }),
  ],
  [
    'browser_screenshot',
    z
      .object({
        paneId,
        fullPage: z.boolean().optional(),
        ref: browserRef.optional(),
        theme: z.enum(['light', 'dark']).optional(),
        image: z.boolean().optional(),
      })
      .strict(),
  ],
  [
    'browser_responsive',
    z
      .object({
        paneId,
        devices: z.array(z.enum(['mobile', 'tablet', 'desktop'])).min(1).max(3).optional(),
      })
      .strict(),
  ],
  [
    'browser_read',
    z
      .object({
        paneId,
        maxChars: positiveInt.max(20_000).optional(),
        maxElements: positiveInt.max(200).optional(),
        format: z.enum(['json', 'compact']).optional(),
        judge: browserJudgeArg,
        focus: z.string().max(500).optional(),
      })
      .strict(),
  ],
  [
    'browser_find',
    z
      .object({
        paneId,
        text: z.string().min(1).max(200).optional(),
        role: z.string().min(1).max(64).optional(),
        limit: z.number().int().min(1).max(25).optional(),
        judge: browserJudgeArg,
      })
      .strict(),
  ],
  [
    'browser_extract',
    z
      .object({
        paneId,
        fields: z.array(browserExtractFieldSchema).min(1).max(20),
      })
      .strict(),
  ],
  ['browser_inspect', z.object({ paneId, ref: browserRef }).strict()],
  ['browser_click', browserClickSchema],
  ['browser_fill', browserFillSchema],
  ['browser_select', browserSelectSchema],
  ['browser_wait', browserWaitSchema],
  [
    'browser_scroll',
    z
      .object({
        paneId,
        ref: browserRef.optional(),
        dx: z.number().finite().optional(),
        dy: z.number().finite().optional(),
        x: z.number().finite().optional(),
        y: z.number().finite().optional(),
        behavior: z.enum(['auto', 'smooth']).optional(),
        read: browserInlineReadSchema,
        judge: browserJudgeArg,
      })
      .strict(),
  ],
  [
    'browser_press',
    z
      .object({
        paneId,
        key: z.string().min(1).max(32),
        ref: browserRef.optional(),
        holdMs: z.number().int().min(0).max(1_000).optional(),
        modifiers: z
          .array(z.enum(['Shift', 'Control', 'Alt', 'Meta']))
          .max(4)
          .optional(),
        read: browserInlineReadSchema,
        judge: browserJudgeArg,
      })
      .strict(),
  ],
  [
    'browser_hover',
    z
      .object({
        paneId,
        ref: browserRef,
        read: browserInlineReadSchema,
        judge: browserJudgeArg,
      })
      .strict(),
  ],
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

/**
 * Top-level keys the strict validator of `toolName` accepts, or null when the
 * tool has no validator. Used by the parity test against each tool's
 * advertised inputSchema.
 */
export function validatedToolArgKeys(toolName: string): string[] | null {
  const schema = schemas.get(canonicalToolName(toolName));
  if (!schema) return null;
  const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape;
  return shape ? Object.keys(shape) : null;
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
