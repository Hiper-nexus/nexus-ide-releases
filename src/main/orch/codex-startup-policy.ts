import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CliMcpSessionOptions, CodexStartupPolicy } from './cli-mcp-session-types';

/**
 * Exclude only the exact prefix captured by prepareProviderSpawn in Main.
 * Never derive provenance from argv content or strip an equal user argument
 * later in the list. Missing/stale provenance keeps everything explicit.
 * This classifies startup intent; it never changes the executed argv.
 */
export function codexExplicitProviderArgs(
  extraArgs: readonly string[],
  generatedControlArgs?: readonly string[],
): readonly string[] {
  return generatedControlArgs && generatedControlArgs.length > 0 &&
    generatedControlArgs.length <= extraArgs.length &&
    generatedControlArgs.every((arg, index) => extraArgs[index] === arg)
    ? extraArgs.slice(generatedControlArgs.length)
    : extraArgs;
}

/** Narrow Main's intent using the actual launch, never probe auth or the API. */
export function resolveCodexStartupPolicy(
  policy: CodexStartupPolicy | undefined,
  launch: {
    readonly isFrictionless: boolean;
    readonly cliVersion: string | null;
    readonly model?: string;
    readonly resume: boolean;
    /** Operator/adapter argv before Nexus's own MCP/hook -c injections. */
    readonly explicitArgs: readonly string[];
  },
): CodexStartupPolicy | undefined {
  if (!policy || !launch.isFrictionless) return undefined;
  // Profiles/config overrides may carry trust, feature or model preferences.
  // Preserve their precedence instead of trying to reimplement Codex's parser.
  if (launch.explicitArgs.some(arg =>
    /^-(?:c|p|m|C)/u.test(arg) ||
    /^--(?:config|profile|model|enable|disable|cyber-access-program|cd|worktree)(?:=|$)/u.test(arg) ||
    arg === 'resume' || arg === 'fork',
  )) return undefined;
  return {
    ...policy,
    daybreak: policy.daybreak === 'suppress-unrequested' &&
      launch.cliVersion === '0.163.0' && !launch.resume && !isDaybreakModel(launch.model)
      ? 'suppress-unrequested' : 'preserve',
  };
}

function isDaybreakModel(model: unknown): boolean {
  return typeof model === 'string' && /daybreak|cyber/iu.test(model);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function contains(root: string, cwd: string): boolean {
  const relative = path.relative(root, cwd);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Existing project layers retain CLI precedence (including malformed layers). */
function hasProjectLayer(cwd: string, providerHome: string, home: string): boolean {
  for (let cursor = cwd;; cursor = path.dirname(cursor)) {
    // The user tier is already supplied by the selected providerHome. Do not
    // reinterpret it (or scan past it) as repository configuration.
    if (path.relative(cursor, home) === '') return false;
    const dir = path.join(cursor, '.codex');
    if (path.relative(dir, providerHome) !== '') {
      try {
        fs.lstatSync(path.join(dir, 'config.toml'));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true;
      }
    }
    if (path.dirname(cursor) === cursor) return false;
  }
}

/** Only used by the operator overlay. Governed config never calls this. */
export function codexStartupConfig(
  config: Record<string, unknown>,
  options: CliMcpSessionOptions,
  providerHome: string,
): Record<string, unknown> {
  const policy = options.codexStartupPolicy;
  if (!policy || !options.cwd || !options.workspaceRoot ||
      config.profile !== undefined || config.profiles !== undefined) return config;
  try {
    const cwd = fs.realpathSync(options.cwd);
    const root = fs.realpathSync(options.workspaceRoot);
    if (cwd !== options.cwd || root !== options.workspaceRoot ||
        !fs.statSync(cwd).isDirectory() || !fs.statSync(root).isDirectory() ||
        !contains(root, cwd) || hasProjectLayer(cwd, providerHome, options.home ?? os.homedir())) return config;

    let projected = config;
    const proof = policy.projectTrust;
    const projects = record(config.projects);
    if (proof && proof.cwdRealPath === cwd && proof.workspaceRootRealPath === root &&
        (proof.basis === 'opened-workspace' || proof.basis === 'approved-mission') &&
        (config.projects === undefined || projects)) {
      const blocked = Object.entries(projects ?? {}).some(([key, value]) => {
        const entry = record(value);
        if (!entry || !path.isAbsolute(key)) return true;
        let canonical = path.resolve(key);
        try { canonical = fs.realpathSync(key); } catch { /* Lexical ancestor still counts. */ }
        return contains(canonical, cwd) && entry.trust_level !== undefined && entry.trust_level !== 'trusted';
      });
      if (!blocked) projected = { ...projected, projects: {
        ...projects, [cwd]: { ...record(projects?.[cwd]), trust_level: 'trusted' },
      } };
    }

    const features = record(config.features);
    if (policy.daybreak === 'suppress-unrequested' && !options.codexResumeSessionId &&
        config.daybreak === undefined && !isDaybreakModel(options.model) && !isDaybreakModel(config.model) &&
        (config.features === undefined || features) && features?.cli_daybreak === undefined) {
      projected = { ...projected, features: { ...features, cli_daybreak: false } };
    }
    return projected;
  } catch {
    // Disappeared/rebound cwd, inaccessible layer or ambiguous state: no new decisions.
    return config;
  }
}
