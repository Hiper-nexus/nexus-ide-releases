/**
 * BYOH (Bring Your Own Harness) catalog — schema and validation for
 * ACP-speaking agent runtimes.
 *
 * Design distilled from block/buzz buzz-acp (Apache-2.0), README section
 * "Bring Your Own Harness (BYOH)". Three tiers:
 *
 *  - tier "builtin": compiled-in runtimes with first-class onboarding.
 *    Their ids are reserved and cannot be shadowed by other tiers.
 *  - tier "preset": static catalog entries, PATH-probed, never editable or
 *    deletable by the user, `canAutoInstall` always false.
 *  - tier "custom": user-supplied JSON definitions. No install scripts, no
 *    icon URLs, `canAutoInstall` always false, reserved ids rejected.
 *
 * Security guarantees carried over from buzz:
 *  - No install shell commands in preset or custom definitions — only the
 *    user's own PATH is consulted.
 *  - Nexus identity env keys (the reserved list below) are ALWAYS stripped
 *    from a definition's `env` and cannot be overridden: they are injected
 *    at spawn time by Nexus itself.
 *
 * This schema is the foundation of multi-PC provider portability: a harness
 * definition is a plain, machine-independent JSON value.
 */

// ---------------------------------------------------------------------------
// Reserved namespaces
// ---------------------------------------------------------------------------

/**
 * Env keys a harness definition may never set. Analogous to buzz stripping
 * `BUZZ_MANAGED_AGENT` and other Buzz identity keys before merging: these
 * are injected by Nexus at spawn time and carry identity, credentials or
 * orchestration endpoints. A definition that could override them could
 * impersonate another pane or exfiltrate gate/MCP tokens.
 */
export const RESERVED_HARNESS_ENV_KEYS = [
  'NEXUS_MANAGED_AGENT',
  'NEXUS_MCP_TOKEN',
  'NEXUS_MCP_URL',
  'NEXUS_GATE_TOKEN',
  'NEXUS_GATE_URL',
  'NEXUS_HOOK_URL',
  'NEXUS_HOOK_STATUS',
  'NEXUS_BACKEND_URL',
  'NEXUS_CRON_BACKEND_URL',
  'NEXUS_PROVIDER_REROUTE',
] as const;

const RESERVED_ENV_KEY_SET: ReadonlySet<string> = new Set(
  RESERVED_HARNESS_ENV_KEYS,
);

/**
 * Reserved-key test, case-INSENSITIVE on every platform.
 *
 * Windows resolves environment variables case-insensitively: a definition
 * setting `nexus_mcp_token` would hand the child the very variable this list
 * exists to protect. Comparing case-sensitively would make the guarantee
 * platform-dependent — and a harness definition is meant to be portable, so
 * the same JSON must produce the same (stripped) environment on macOS, Linux
 * and Windows alike. Only the membership test is normalized: the caller's
 * original spelling is preserved for non-reserved keys.
 */
export function isReservedHarnessEnvKey(key: string): boolean {
  return RESERVED_ENV_KEY_SET.has(key.toUpperCase());
}

/**
 * Tier-1 reserved ids. Nothing is compiled-in yet in this increment — the
 * ids are reserved now (mirroring buzz's `BUILTIN_IDS`) so that increment 2
 * can wire the npm adapters (`@agentclientprotocol/claude-agent-acp`,
 * `codex-acp`) as first-class runtimes without a custom definition having
 * squatted the name in the meantime.
 */
export const BUILTIN_HARNESS_IDS = ['claude', 'codex', 'goose'] as const;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export type HarnessTier = 'builtin' | 'preset' | 'custom';

export interface HarnessDefinition {
  /** `[a-z0-9-]`, must start with `[a-z0-9]`. Doubles as file/picker key. */
  readonly id: string;
  /** Human-readable name shown in the UI. */
  readonly label: string;
  /** Executable name or absolute path. Must be non-empty. */
  readonly command: string;
  /** Default CLI arguments (e.g. `["acp"]`). */
  readonly args: readonly string[];
  /**
   * Env injected at spawn time. Definition env is a floor — user/global env
   * overrides it — and reserved keys are always stripped before this record
   * is built.
   */
  readonly env: Readonly<Record<string, string>>;
  readonly tier: HarnessTier;
  /**
   * Always `false` for preset and custom entries (enforced by the parser,
   * regardless of input): no definition may trigger an install.
   */
  readonly canAutoInstall: boolean;
  /** Shown when the binary is not on PATH. https only, length-capped. */
  readonly installInstructionsUrl?: string;
  readonly installHint?: string;
}

export interface HarnessParseOk {
  ok: true;
  harness: HarnessDefinition;
  /** Reserved env keys that were present in the input and removed. */
  strippedEnvKeys: readonly string[];
}

export interface HarnessParseFail {
  ok: false;
  errors: readonly string[];
}

export type HarnessParseResult = HarnessParseOk | HarnessParseFail;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const HARNESS_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_ID_LENGTH = 64;
const MAX_LABEL_LENGTH = 120;
/** Same cap the `app:openExternal` IPC handler enforces on any outbound link. */
const MAX_INSTALL_URL_LENGTH = 2_048;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A definition's docs link ends up in `shell.openExternal`, so it obeys the
 * same policy as every other outbound link in Nexus (`handleOpenExternalRequest`):
 * https only, bounded length. `javascript:`, `file:` and `data:` URLs from a
 * dropped-in JSON file must never reach the OS handler. Returns the error
 * message, or `null` when the URL is acceptable.
 */
function installUrlError(raw: string): string | null {
  if (raw.length > MAX_INSTALL_URL_LENGTH) {
    return `installInstructionsUrl exceeds ${MAX_INSTALL_URL_LENGTH} characters`;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return 'installInstructionsUrl is not a valid absolute URL';
  }
  if (parsed.protocol !== 'https:') {
    return `installInstructionsUrl must use https (got ${JSON.stringify(parsed.protocol)})`;
  }
  return null;
}

function deepFreezeDefinition(definition: HarnessDefinition): HarnessDefinition {
  Object.freeze(definition.args);
  Object.freeze(definition.env);
  return Object.freeze(definition);
}

// ---------------------------------------------------------------------------
// Tier-2 preset catalog
// ---------------------------------------------------------------------------

/**
 * Static tier-2 presets: always present in the runtime catalog, PATH-probed
 * for availability, not editable or deletable. Commands come from the
 * vendors' own ACP entrypoints:
 *  - claude: `@agentclientprotocol/claude-agent-acp` npm adapter
 *  - codex:  `codex-acp` npm adapter
 *  - goose:  native `goose acp` subcommand
 * None of them auto-install: if the binary is missing, the docs link shows.
 */
export const PRESET_HARNESSES: readonly HarnessDefinition[] = Object.freeze([
  deepFreezeDefinition({
    id: 'claude',
    label: 'Claude Code (ACP)',
    command: 'claude-agent-acp',
    args: [],
    env: {},
    tier: 'preset',
    canAutoInstall: false,
    installInstructionsUrl:
      'https://github.com/agentclientprotocol/claude-agent-acp',
    installHint: 'npm install -g @agentclientprotocol/claude-agent-acp',
  }),
  deepFreezeDefinition({
    id: 'codex',
    label: 'Codex (ACP)',
    command: 'codex-acp',
    args: [],
    env: {},
    tier: 'preset',
    canAutoInstall: false,
    installInstructionsUrl: 'https://github.com/agentclientprotocol/codex-acp',
    installHint: 'npm install -g @agentclientprotocol/codex-acp',
  }),
  deepFreezeDefinition({
    id: 'cursor',
    label: 'Cursor Agent (ACP)',
    command: 'cursor-agent',
    args: ['acp'],
    env: {},
    tier: 'preset',
    canAutoInstall: false,
    installInstructionsUrl: 'https://cursor.com',
    installHint: 'Install cursor-agent and ensure it is on your PATH',
  }),
  deepFreezeDefinition({
    id: 'opencode',
    label: 'OpenCode (ACP)',
    command: 'opencode',
    args: ['acp'],
    env: {},
    tier: 'preset',
    canAutoInstall: false,
    installInstructionsUrl: 'https://opencode.ai',
    installHint: 'Install opencode and ensure it is on your PATH',
  }),
  deepFreezeDefinition({
    id: 'kimi',
    label: 'Kimi (ACP)',
    command: 'kimi-acp',
    args: [],
    env: {},
    tier: 'preset',
    canAutoInstall: false,
    installInstructionsUrl: 'https://github.com/agentclientprotocol/kimi-acp',
    installHint: 'npm install -g @agentclientprotocol/kimi-acp',
  }),
  deepFreezeDefinition({
    id: 'copilot',
    label: 'GitHub Copilot (ACP)',
    command: 'copilot-acp',
    args: [],
    env: {},
    tier: 'preset',
    canAutoInstall: false,
    installInstructionsUrl: 'https://github.com/agentclientprotocol/copilot-acp',
    installHint: 'npm install -g @agentclientprotocol/copilot-acp',
  }),
  deepFreezeDefinition({
    id: 'goose',
    label: 'Goose (ACP)',
    command: 'goose',
    args: ['acp'],
    env: {},
    tier: 'preset',
    canAutoInstall: false,
    installInstructionsUrl: 'https://block.github.io/goose/',
    installHint: 'Install goose from block.github.io/goose',
  }),
]);

/**
 * Full reserved namespace: builtin ids plus every preset id. Custom
 * definitions may use any other id matching the pattern.
 */
export const RESERVED_HARNESS_IDS: readonly string[] = Object.freeze([
  ...new Set([
    ...BUILTIN_HARNESS_IDS,
    ...PRESET_HARNESSES.map((preset) => preset.id),
  ]),
]);

const RESERVED_HARNESS_ID_SET: ReadonlySet<string> = new Set(
  RESERVED_HARNESS_IDS,
);

/**
 * Parse and validate one harness definition from untrusted input
 * (custom JSON file dropped by the user, or a preset entry self-check).
 *
 * Strict: unknown ids in reserved namespaces, malformed ids, empty
 * commands, non-string args/env and non-https install links are all explicit
 * errors — an invalid file must never produce a spawnable definition.
 * Reserved env keys are the one exception: they are silently stripped and
 * reported in `strippedEnvKeys` (case-insensitively), so a definition written
 * on another PC still loads (portability) without ever overriding Nexus
 * identity. A hostile `javascript:` docs link is not a portability problem,
 * so it fails loudly instead.
 *
 * The returned definition is deeply frozen — immutable by construction.
 */
export function parseHarnessDefinition(
  input: unknown,
  tier: Exclude<HarnessTier, 'builtin'> = 'custom',
): HarnessParseResult {
  const errors: string[] = [];
  if (!isRecord(input)) {
    return { ok: false, errors: ['definition is not an object'] };
  }

  const { id, label, command, args, env } = input;

  if (typeof id !== 'string' || !HARNESS_ID_PATTERN.test(id)) {
    errors.push(
      `invalid id ${JSON.stringify(id)} — must match ${HARNESS_ID_PATTERN}`,
    );
  } else if (id.length > MAX_ID_LENGTH) {
    errors.push(`id exceeds ${MAX_ID_LENGTH} characters`);
  } else if (tier === 'custom' && RESERVED_HARNESS_ID_SET.has(id)) {
    errors.push(`id "${id}" is reserved for a builtin/preset runtime`);
  }

  const resolvedLabel =
    typeof label === 'string' && label.trim().length > 0
      ? label.trim()
      : typeof id === 'string'
        ? id
        : '';
  if (resolvedLabel.length > MAX_LABEL_LENGTH) {
    errors.push(`label exceeds ${MAX_LABEL_LENGTH} characters`);
  }

  if (typeof command !== 'string' || command.trim().length === 0) {
    errors.push('command must be a non-empty string');
  } else if (command.includes('\0')) {
    errors.push('command contains a NUL byte');
  }

  const parsedArgs: string[] = [];
  if (args !== undefined) {
    if (!Array.isArray(args)) {
      errors.push('args must be an array of strings');
    } else {
      for (const [index, arg] of args.entries()) {
        if (typeof arg !== 'string') {
          errors.push(`args[${index}] is not a string`);
        } else {
          parsedArgs.push(arg);
        }
      }
    }
  }

  const parsedEnv: Record<string, string> = {};
  const strippedEnvKeys: string[] = [];
  if (env !== undefined) {
    if (!isRecord(env)) {
      errors.push('env must be an object of string values');
    } else {
      for (const [key, value] of Object.entries(env)) {
        if (isReservedHarnessEnvKey(key)) {
          strippedEnvKeys.push(key);
          continue;
        }
        if (!ENV_KEY_PATTERN.test(key)) {
          errors.push(`env key ${JSON.stringify(key)} is not a valid env name`);
          continue;
        }
        if (typeof value !== 'string') {
          errors.push(`env["${key}"] is not a string`);
          continue;
        }
        parsedEnv[key] = value;
      }
    }
  }

  let installInstructionsUrl: string | undefined;
  if (
    typeof input.installInstructionsUrl === 'string' &&
    input.installInstructionsUrl.length > 0
  ) {
    const urlError = installUrlError(input.installInstructionsUrl);
    if (urlError !== null) errors.push(urlError);
    else installInstructionsUrl = input.installInstructionsUrl;
  }
  const installHint =
    typeof input.installHint === 'string' && input.installHint.length > 0
      ? input.installHint
      : undefined;

  if (errors.length > 0) return { ok: false, errors };

  const harness: HarnessDefinition = deepFreezeDefinition({
    id: id as string,
    label: resolvedLabel,
    command: (command as string).trim(),
    args: parsedArgs,
    env: parsedEnv,
    tier,
    // Enforced false for preset/custom regardless of input — no definition
    // may trigger an install (buzz: "can_auto_install is always false").
    canAutoInstall: false,
    ...(installInstructionsUrl !== undefined ? { installInstructionsUrl } : {}),
    ...(installHint !== undefined ? { installHint } : {}),
  });

  return { ok: true, harness, strippedEnvKeys };
}
