import type { AgentGateContext } from './gate';
import { getContext } from './gate';
import { requiresSpawnGate } from './spawn-home-policy';

export interface GovernedCliProfileOptions {
  /**
   * Test/adapter seam. Production normally derives this from the main-owned
   * bearer context instead of trusting a renderer or provider payload.
   */
  governed?: boolean;
  /** Same authority semantics as AgentGateContext.allowedSkills. */
  allowedSkills?: readonly string[] | null;
}

export interface ResolvedGovernedCliProfile {
  readonly governed: boolean;
  /**
   * Physical provider homes are stricter than the logical `null = open`
   * gate: only named skills are materialized. An open gate never means
   * "inherit every executable extension from the user's real profile".
   */
  readonly allowedSkills: readonly string[];
}

const EXECUTABLE_PROFILE_KEYS = new Set([
  'agent',
  'agents',
  'command',
  'commands',
  'extension',
  'extensions',
  'hook',
  'hooks',
  'lsp',
  'lspservers',
  'marketplace',
  'marketplaces',
  'mcp',
  'mcpservers',
  'plugin',
  'plugins',
  'skill',
  'skills',
]);

function normalizedConfigKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Remove provider config roots that can load executable code, MCP servers,
 * hooks, agents or skills. Ordinary model/UI/provider preferences survive.
 */
export function stripExecutableProfileConfig(
  source: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(source).filter(
      ([key]) => !EXECUTABLE_PROFILE_KEYS.has(normalizedConfigKey(key)),
    ),
  );
}

function contextPolicy(
  ctx: AgentGateContext | null,
): ResolvedGovernedCliProfile {
  const governed = Boolean(ctx && requiresSpawnGate(ctx));
  return {
    governed,
    allowedSkills:
      governed && Array.isArray(ctx?.allowedSkills)
        ? [...ctx.allowedSkills]
        : [],
  };
}

/**
 * Resolve session confinement from the bearer minted in main. Callers may
 * override it only through a local test/adapter seam; no value comes from the
 * renderer, workspace, CLI output or MCP request.
 */
export function resolveGovernedCliProfile(
  token: string,
  options: GovernedCliProfileOptions = {},
): ResolvedGovernedCliProfile {
  const fromContext = contextPolicy(getContext(token));
  if (options.governed === undefined) return fromContext;
  return {
    governed: options.governed,
    allowedSkills:
      options.governed && Array.isArray(options.allowedSkills)
        ? [...options.allowedSkills]
        : [],
  };
}

/**
 * OMP 17.0.4's parser-accepted toolset except `task`, which launches native
 * subagents outside the Nexus roster/gate. Keeping this as an explicit
 * allowlist also makes a future OMP tool fail closed until Nexus reviews it.
 * (The help text advertises optional python/notebook tools that this build's
 * parser rejects, so the executable's own validation is authoritative.)
 */
export const GOVERNED_OMP_TOOL_NAMES = [
  'read',
  'bash',
  'edit',
  'ast_grep',
  'ast_edit',
  'ask',
  'debug',
  'eval',
  'github',
  'glob',
  'grep',
  'lsp',
  'inspect_image',
  'browser',
  'checkpoint',
  'rewind',
  'hub',
  'todo',
  'web_search',
  'write',
  'memory_edit',
  'retain',
  'recall',
  'reflect',
  'learn',
  'manage_skill',
  'yield',
  'goal',
] as const;

/** Provider-native hardening that does not depend on profile file schemas. */
export function governedOmpArgs(allowedSkills: readonly string[]): string[] {
  const args = [
    '--no-extensions',
    '--no-rules',
    `--tools=${GOVERNED_OMP_TOOL_NAMES.join(',')}`,
  ];
  if (allowedSkills.length === 0) {
    args.push('--no-skills');
  } else {
    args.push(`--skills=${allowedSkills.join(',')}`);
  }
  return args;
}
