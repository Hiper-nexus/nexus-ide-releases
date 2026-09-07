// Manifest schema and validation for the agent screen-state detection engine.
// Ported from herdrdev/herdr `src/detect/manifest.rs` (Apache-2.0, see
// THIRD_PARTY_NOTICES.md): the TOML documents under resources/agent-detection/
// are verbatim upstream manifests, so this schema mirrors the upstream
// `AgentManifest`/`ManifestRule`/`ManifestGate` structs including
// deny-unknown-fields and the same complexity limits. A manifest that Herdr
// would reject must be rejected here.

import fs from 'node:fs';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';

export const MANIFEST_ENGINE_VERSION = 3;
/** Region gated upstream behind engine >= 3 (TOP_NON_EMPTY_LINES_ENGINE_VERSION). */
const TOP_NON_EMPTY_LINES_ENGINE_VERSION = 3;

export const MAX_RULES_PER_MANIFEST = 128;
export const MAX_GATE_DEPTH = 8;
export const MAX_TOTAL_GATES = 512;
export const MAX_MATCHERS_PER_GATE = 32;
export const MAX_TOTAL_MATCHERS = 1024;
export const MAX_MATCHER_CHARS = 512;

export const MANIFEST_STATES = ['idle', 'working', 'blocked', 'unknown'] as const;
export type ManifestState = (typeof MANIFEST_STATES)[number];

const gateSchema: z.ZodType<ManifestGate> = z.lazy(() =>
  z
    .object({
      all: z.array(gateSchema).default([]),
      any: z.array(gateSchema).default([]),
      not: z.array(gateSchema).default([]),
      contains: z.array(z.string()).default([]),
      regex: z.array(z.string()).default([]),
      line_regex: z.array(z.string()).default([]),
    })
    .strict(),
);

const ruleSchema = z
  .object({
    id: z.string(),
    state: z.enum(MANIFEST_STATES).optional(),
    priority: z.number().int().default(0),
    region: z.string().default('whole_recent'),
    visible_idle: z.boolean().default(false),
    visible_blocker: z.boolean().default(false),
    visible_working: z.boolean().default(false),
    skip_state_update: z.boolean().default(false),
    all: z.array(gateSchema).default([]),
    any: z.array(gateSchema).default([]),
    not: z.array(gateSchema).default([]),
    contains: z.array(z.string()).default([]),
    regex: z.array(z.string()).default([]),
    line_regex: z.array(z.string()).default([]),
  })
  .strict();

const manifestSchema = z
  .object({
    id: z.string(),
    version: z.string().optional(),
    min_engine_version: z.number().int().optional(),
    updated_at: z.string().optional(),
    aliases: z.array(z.string()).default([]),
    rules: z.array(ruleSchema).default([]),
  })
  .strict();

export interface ManifestGate {
  all: ManifestGate[];
  any: ManifestGate[];
  not: ManifestGate[];
  contains: string[];
  regex: string[];
  line_regex: string[];
}

export interface ManifestRule extends ManifestGate {
  id: string;
  state?: ManifestState;
  priority: number;
  region: string;
  visible_idle: boolean;
  visible_blocker: boolean;
  visible_working: boolean;
  skip_state_update: boolean;
}

export interface AgentManifest {
  id: string;
  version?: string;
  min_engine_version?: number;
  updated_at?: string;
  aliases: string[];
  rules: ManifestRule[];
}

/** Region names accepted upstream (`validate_region_name`). */
const NAMED_REGIONS = new Set([
  'whole_recent',
  'after_last_prompt_marker',
  'before_current_prompt_marker',
  'whole_recent_without_current_prompt_marker',
  'current_prompt_block_marker',
  'after_current_prompt_block_marker',
  'prompt_box_body',
  'above_prompt_box',
  'last_non_empty_above_prompt_box',
  'after_last_horizontal_rule',
  'osc_title',
  'osc_progress',
]);

const MAX_TOP_REGION_LINE_COUNT = 0xffff;

function regionCount(spec: string, name: string): number | null {
  if (!spec.startsWith(`${name}(`) || !spec.endsWith(')')) return null;
  const raw = spec.slice(name.length + 1, -1);
  // Rust's usize::from_str is all-or-nothing; parseInt would accept "12x".
  if (!/^[0-9]+$/.test(raw)) return null;
  const count = Number.parseInt(raw, 10);
  return Number.isSafeInteger(count) ? count : null;
}

/** Mirrors `top_region_count`: no leading zero, ASCII digits only, u16 cap. */
function topRegionCount(spec: string): number | null {
  const count = regionCount(spec, 'top_non_empty_lines');
  if (count === null) return null;
  const raw = spec.slice('top_non_empty_lines('.length, -1);
  if (raw.startsWith('0') || !/^[0-9]+$/.test(raw)) return null;
  return count <= MAX_TOP_REGION_LINE_COUNT ? count : null;
}

export function isValidRegionName(spec: string): boolean {
  const trimmed = spec.trim();
  if (NAMED_REGIONS.has(trimmed)) return true;
  return (
    regionCount(trimmed, 'bottom_lines') !== null ||
    regionCount(trimmed, 'bottom_non_empty_lines') !== null ||
    topRegionCount(trimmed) !== null
  );
}

interface ManifestComplexity {
  totalGates: number;
  totalMatchers: number;
}

function gateMatchers(gate: ManifestGate): string[] {
  return [...gate.contains, ...gate.regex, ...gate.line_regex];
}

function gateHasPositiveMatcher(gate: ManifestGate): boolean {
  return (
    gate.contains.length > 0 ||
    gate.regex.length > 0 ||
    gate.line_regex.length > 0 ||
    gate.all.length > 0 ||
    gate.any.length > 0
  );
}

function validateMatcherLimits(
  gate: ManifestGate,
  context: string,
  complexity: ManifestComplexity,
): string | null {
  const matcherCount = gateMatchers(gate).length;
  if (matcherCount > MAX_MATCHERS_PER_GATE) {
    return `${context} has ${matcherCount} direct matchers, max is ${MAX_MATCHERS_PER_GATE}`;
  }
  complexity.totalMatchers += matcherCount;
  if (complexity.totalMatchers > MAX_TOTAL_MATCHERS) {
    return `manifest exceeds max matcher count ${MAX_TOTAL_MATCHERS}`;
  }
  for (const value of gateMatchers(gate)) {
    if ([...value].length > MAX_MATCHER_CHARS) {
      return `${context} matcher exceeds max length ${MAX_MATCHER_CHARS}`;
    }
  }
  return null;
}

function validateGate(
  gate: ManifestGate,
  context: string,
  depth: number,
  complexity: ManifestComplexity,
): string | null {
  if (depth > MAX_GATE_DEPTH) {
    return `${context} exceeds max gate depth ${MAX_GATE_DEPTH}`;
  }
  complexity.totalGates += 1;
  if (complexity.totalGates > MAX_TOTAL_GATES) {
    return `manifest exceeds max gate count ${MAX_TOTAL_GATES}`;
  }
  const limited = validateMatcherLimits(gate, context, complexity);
  if (limited) return limited;
  if (!gateHasPositiveMatcher(gate)) {
    return `${context} must contain a positive matcher`;
  }
  for (const nested of gate.all) {
    const err = validateGate(nested, 'all gate', depth + 1, complexity);
    if (err) return err;
  }
  for (const nested of gate.any) {
    const err = validateGate(nested, 'any gate', depth + 1, complexity);
    if (err) return err;
  }
  for (const nested of gate.not) {
    const err = validateNotGate(nested, depth + 1, complexity);
    if (err) return err;
  }
  return null;
}

function validateNotGate(
  gate: ManifestGate,
  depth: number,
  complexity: ManifestComplexity,
): string | null {
  if (depth > MAX_GATE_DEPTH) {
    return `not gate exceeds max gate depth ${MAX_GATE_DEPTH}`;
  }
  complexity.totalGates += 1;
  if (complexity.totalGates > MAX_TOTAL_GATES) {
    return `manifest exceeds max gate count ${MAX_TOTAL_GATES}`;
  }
  const limited = validateMatcherLimits(gate, 'not gate', complexity);
  if (limited) return limited;
  if (!gateHasPositiveMatcher(gate) && gate.not.length === 0) {
    return 'not gate must contain a matcher';
  }
  for (const nested of gate.all) {
    const err = validateGate(nested, 'not all gate', depth + 1, complexity);
    if (err) return err;
  }
  for (const nested of gate.any) {
    const err = validateGate(nested, 'not any gate', depth + 1, complexity);
    if (err) return err;
  }
  for (const nested of gate.not) {
    const err = validateNotGate(nested, depth + 1, complexity);
    if (err) return err;
  }
  return null;
}

function gateFromRule(rule: ManifestRule): ManifestGate {
  return {
    all: rule.all,
    any: rule.any,
    not: rule.not,
    contains: rule.contains,
    regex: rule.regex,
    line_regex: rule.line_regex,
  };
}

/** Mirrors `validate_manifest`; returns the first violation or null. */
export function validateManifest(manifest: AgentManifest): string | null {
  if (manifest.rules.length === 0) {
    return 'manifest must contain at least one rule';
  }
  if (manifest.rules.length > MAX_RULES_PER_MANIFEST) {
    return `manifest contains ${manifest.rules.length} rules, max is ${MAX_RULES_PER_MANIFEST}`;
  }

  const complexity: ManifestComplexity = { totalGates: 0, totalMatchers: 0 };
  for (const rule of manifest.rules) {
    if (rule.id.trim().length === 0) {
      return 'manifest rule id must not be empty';
    }
    if (rule.skip_state_update) {
      if (rule.state !== 'unknown') {
        return `rule ${rule.id} uses skip_state_update without state = "unknown"`;
      }
      if (rule.visible_idle || rule.visible_blocker || rule.visible_working) {
        return `rule ${rule.id} uses skip_state_update with visible state evidence`;
      }
    }
    if (!isValidRegionName(rule.region)) {
      return `rule ${rule.id} uses invalid region: ${rule.region.trim()}`;
    }
    if (
      rule.region.trim().startsWith('top_non_empty_lines(') &&
      manifest.min_engine_version !== undefined &&
      manifest.min_engine_version < TOP_NON_EMPTY_LINES_ENGINE_VERSION
    ) {
      return `rule ${rule.id} uses top_non_empty_lines but min_engine_version is below ${TOP_NON_EMPTY_LINES_ENGINE_VERSION}`;
    }
    const gateError = validateGate(gateFromRule(rule), 'rule', 0, complexity);
    if (gateError) {
      return `rule ${rule.id} has invalid matcher gates: ${gateError}`;
    }
  }
  return null;
}

/**
 * Parse + validate one TOML manifest document. Throws on any schema or
 * semantic violation; regexes are compiled separately by compiler.ts.
 */
export function parseManifest(content: string): AgentManifest {
  let raw: unknown;
  try {
    raw = parseToml(content);
  } catch (err) {
    throw new Error(`manifest TOML parse failed: ${String(err)}`);
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`manifest schema violation: ${parsed.error.message}`);
  }
  const manifest = parsed.data as AgentManifest;
  const invalid = validateManifest(manifest);
  if (invalid) throw new Error(invalid);
  if (
    manifest.min_engine_version !== undefined &&
    manifest.min_engine_version > MANIFEST_ENGINE_VERSION
  ) {
    throw new Error(
      `manifest requires engine ${manifest.min_engine_version}, current engine is ${MANIFEST_ENGINE_VERSION}`,
    );
  }
  return manifest;
}

export interface LoadedManifestFile {
  manifest: AgentManifest;
  /** Manifest id, keyed by the file it was read from. */
  file: string;
}

/** Parse every `*.toml` under a directory. Throws on the first bad manifest. */
export function loadManifestDir(dir: string): LoadedManifestFile[] {
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.toml'))
    .sort();
  return files.map((file) => ({
    manifest: parseManifest(fs.readFileSync(path.join(dir, file), 'utf8')),
    file,
  }));
}

/**
 * Dev (repo) vs packaged (extraResource) resolution for
 * resources/agent-detection/, same candidate strategy as the pets library.
 */
export function resolveManifestDir(candidates?: {
  appPath?: string;
  resourcesPath?: string;
  packaged?: boolean;
  cwd?: string;
}): string {
  const cwd = candidates?.cwd ?? process.cwd();
  if (candidates?.packaged && candidates.resourcesPath) {
    return path.join(candidates.resourcesPath, 'agent-detection');
  }
  const appPath = candidates?.appPath ?? cwd;
  const options = [
    path.join(cwd, 'resources', 'agent-detection'),
    path.join(appPath, 'resources', 'agent-detection'),
    path.join(appPath, '..', 'resources', 'agent-detection'),
    path.join(appPath, '..', '..', 'resources', 'agent-detection'),
  ];
  for (const candidate of options) {
    if (fs.existsSync(path.join(candidate, 'claude.toml'))) {
      return path.resolve(candidate);
    }
  }
  return path.resolve(options[0]);
}
