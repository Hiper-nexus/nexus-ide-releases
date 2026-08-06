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
  /** Same authority semantics as AgentGateContext.allowedTools. */
  allowedTools?: readonly string[] | null;
}

export interface ResolvedGovernedCliProfile {
  readonly governed: boolean;
  /**
   * Physical provider homes are stricter than the logical `null = open`
   * gate: only named skills are materialized. An open gate never means
   * "inherit every executable extension from the user's real profile".
   */
  readonly allowedSkills: readonly string[];
  readonly allowedTools: readonly string[] | null;
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
    allowedTools:
      governed && ctx
        ? ctx.allowedTools === null
          ? null
          : [...ctx.allowedTools]
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
    allowedTools:
      options.governed && options.allowedTools === null
        ? null
        : options.governed && Array.isArray(options.allowedTools)
          ? [...options.allowedTools]
          : [],
  };
}
