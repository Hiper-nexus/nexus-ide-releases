import { z } from 'zod';

/**
 * Zod schemas and TypeScript types for the declarative CLI adapter system.
 * These are shared between main (validates JSON files) and renderer (receives
 * the trimmed AdapterInfo over IPC).
 *
 * Two adapter kinds:
 *  - cli-pty  : spawns a real PTY (interactive TUI agents — Claude, aider …)
 *  - api-provider : HTTP client (future chat pane — GLM, fugu …)
 */

const installSchema = z.object({
  method: z.enum(['brew', 'npm', 'pip', 'cargo', 'manual']),
  command: z.string().min(1),
});

const authSchema = z.object({
  method: z.enum(['oauth', 'api_key', 'device_code', 'subscription', 'none']),
  envVarFallback: z.string().optional(),
  credentialStore: z.enum(['keychain', 'env']).optional(),
  loginHint: z.string().optional(),
});

const spawnConfigSchema = z.object({
  interactive: z.array(z.string()),
  headless: z.array(z.string()),
  ptyRequired: z.boolean(),
  resumeArgs: z.array(z.string()).default([]),
  extraArgs: z.array(z.string()).default([]),
});

const envConfigSchema = z.object({
  static: z.record(z.string(), z.string()).default({}),
  passthrough: z.array(z.string()).default([]),
  ephemeralHome: z.boolean().default(false),
});

const modelsConfigSchema = z.object({
  flag: z.string(),
  list: z.array(z.string()),
  default: z.string(),
});

const promptInjectionSchema = z.object({
  method: z.enum(['stdin', 'arg', 'flag']),
  flag: z.string().optional(),
  trailingNewline: z.boolean().default(true),
  bracketedPaste: z.boolean().default(false),
});

const idlePatternSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('regex'), pattern: z.string() }),
  z.object({ type: z.literal('timeout'), ms: z.number().positive() }),
]);

const stateParsingSchema = z.object({
  idle: idlePatternSchema,
  busy: z
    .object({ type: z.literal('regex'), pattern: z.string() })
    .optional(),
  shellIntegration: z.boolean().default(false),
  exitCodes: z.record(z.string(), z.string()).default({}),
});

const quirksSchema = z.object({
  altScreen: z.boolean().default(false),
  requiresNoAutoUpdate: z.boolean().default(false),
  approvalFlag: z.string().optional(),
  mcpAutoload: z.boolean().default(false),
});

/**
 * Declarative control flags — how THIS CLI expresses permission mode, reasoning
 * effort and verbose output. Each CLI differs, so the mapping lives per adapter
 * and the settings UI only offers the modes an adapter actually supports.
 * Lets the user turn on "operate automatically" (yolo/bypass) per provider.
 */
const controlSchema = z
  .object({
    permission: z
      .object({
        /** Flag taking a mode value, e.g. "--permission-mode". */
        arg: z.string().optional(),
        /** Selectable mode → concrete value (e.g. { bypass:"bypassPermissions" }). */
        modes: z.record(z.string(), z.string()).default({}),
        /** Standalone full-auto args (e.g. ["--dangerously-skip-permissions"]). */
        yolo: z.array(z.string()).default([]),
        /** Default mode key applied when the user hasn't chosen (''=CLI default). */
        default: z.string().default(''),
      })
      .optional(),
    effort: z
      .object({
        arg: z.string(),
        levels: z.array(z.string()).default([]),
      })
      .optional(),
    /** Flag enabling verbose output (e.g. "--verbose"). */
    verbose: z.string().optional(),
  })
  .default({});

export const cliPtyAdapterSchema = z.object({
  kind: z.literal('cli-pty'),
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/, 'id must be lowercase alphanumeric with hyphens'),
  label: z.string().min(1).max(128),
  version: z.string().min(1),
  icon: z.string().max(8).default('🤖'),
  bin: z.string().min(1),
  detect: z.string().min(1),
  install: installSchema,
  auth: authSchema,
  spawn: spawnConfigSchema,
  env: envConfigSchema,
  models: modelsConfigSchema,
  promptInjection: promptInjectionSchema,
  stateParsing: stateParsingSchema,
  quirks: quirksSchema,
  control: controlSchema,
});

export const apiProviderAdapterSchema = z.object({
  kind: z.literal('api-provider'),
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/, 'id must be lowercase alphanumeric with hyphens'),
  label: z.string().min(1).max(128),
  version: z.string().min(1),
  icon: z.string().max(8).default('🌐'),
  endpoint: z.string().url(),
  protocol: z.enum(['openai-chat', 'openai-responses', 'anthropic-messages']),
  auth: z.object({
    method: z.literal('api_key'),
    header: z.string(),
    scheme: z.string(),
    envVar: z.string(),
    keychainKey: z.string(),
  }),
  models: modelsConfigSchema,
  streaming: z.boolean().default(true),
  quirks: z.record(z.string(), z.unknown()).default({}),
});

export const adapterSchema = z.discriminatedUnion('kind', [
  cliPtyAdapterSchema,
  apiProviderAdapterSchema,
]);

export type CliPtyAdapter = z.infer<typeof cliPtyAdapterSchema>;
export type ApiProviderAdapter = z.infer<typeof apiProviderAdapterSchema>;
export type Adapter = z.infer<typeof adapterSchema>;

/**
 * Replace {{KEY}} placeholders in an argv array. Unknown keys resolve to empty
 * string. This is a pure function — safe to call in tests without side effects.
 */
export function resolvePlaceholders(
  args: readonly string[],
  vars: Readonly<Record<string, string>>,
): string[] {
  return args.map((arg) =>
    arg.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? ''),
  );
}

/**
 * Trimmed adapter summary that crosses the IPC boundary to the renderer.
 * The full adapter config (including auth env vars) never leaves the main process.
 */
export interface AdapterInfo {
  id: string;
  kind: 'cli-pty' | 'api-provider';
  label: string;
  icon: string;
  models: { list: string[]; default: string };
  installed: boolean;
  installCommand: string;
  loginHint?: string;
  idleTimeoutMs: number;
}
