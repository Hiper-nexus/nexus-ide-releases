// Manifest evaluator for the detection engine. Ports Herdr's
// `evaluate_loaded_manifest` + `fallback_explain` (src/detect/manifest.rs
// ~446-584): the matched rule with the highest priority wins (ties keep the
// first declared rule); no match with a known agent falls back to `idle` with
// a fallback reason; `skip_state_update` rules resolve to `unknown` and carry
// the skipped-update reason. Every evaluation also produces a DetectionExplain
// for debugging (matched rule, per-rule evidence, bounded region preview).

import { compiledGateMatches, type CompiledManifest } from './compiler';
import type { ManifestState } from './manifest';
import { sliceRegion, type DetectionInput } from './regions';

export type DetectedAgentState = ManifestState;

export const DEFAULT_KNOWN_AGENT_IDLE_FALLBACK = 'default_known_agent_idle_fallback';

const REGION_PREVIEW_MAX_CHARS = 240;

export interface RuleEvidence {
  contains: string[];
  regex: string[];
  lineRegex: string[];
  allCount: number;
  anyCount: number;
  notCount: number;
  regionBytes: number;
  regionPreview: string;
}

export interface EvaluatedRule {
  id: string;
  priority: number;
  region: string;
  state: DetectedAgentState;
  matched: boolean;
  evidence: RuleEvidence;
}

export interface MatchedRule {
  id: string;
  priority: number;
  region: string;
  state: DetectedAgentState;
}

export interface DetectionExplain {
  /** Manifest id the evaluation ran against; null when no manifest exists. */
  agent: string | null;
  state: DetectedAgentState;
  /** Always 'bundled' today; kept for a future override/remote source. */
  source: 'bundled' | null;
  manifestVersion: string | null;
  matchedRule: MatchedRule | null;
  visibleIdle: boolean;
  visibleBlocker: boolean;
  visibleWorking: boolean;
  skipStateUpdate: boolean;
  skippedUpdateReason: string | null;
  fallbackReason: string | null;
  evaluatedRules: EvaluatedRule[];
  warnings: string[];
}

function boundedPreview(text: string): string {
  const chars = [...text];
  const preview = chars.slice(0, REGION_PREVIEW_MAX_CHARS).join('');
  return chars.length > REGION_PREVIEW_MAX_CHARS ? `${preview}...` : preview;
}

/** Evaluate one compiled manifest against a detection input. Total function. */
export function evaluateManifest(
  compiled: CompiledManifest,
  input: DetectionInput,
): DetectionExplain {
  let matched: { rule: MatchedRule; visibleIdle: boolean; visibleBlocker: boolean; visibleWorking: boolean; skipStateUpdate: boolean } | null = null;
  const evaluatedRules: EvaluatedRule[] = [];

  for (const { rule, gate } of compiled.rules) {
    const regionText = sliceRegion(input, rule.region);
    const isMatch = compiledGateMatches(
      gate,
      regionText,
      regionText.toLowerCase(),
    );
    const state: DetectedAgentState = rule.state ?? 'unknown';
    evaluatedRules.push({
      id: rule.id,
      priority: rule.priority,
      region: rule.region,
      state,
      matched: isMatch,
      evidence: {
        contains: [...rule.contains],
        regex: [...rule.regex],
        lineRegex: [...rule.line_regex],
        allCount: rule.all.length,
        anyCount: rule.any.length,
        notCount: rule.not.length,
        regionBytes: regionText.length,
        regionPreview: boundedPreview(regionText),
      },
    });

    if (!isMatch) continue;
    // Higher priority wins; on a tie the first declared rule keeps the match.
    if (matched && matched.rule.priority >= rule.priority) continue;
    matched = {
      rule: { id: rule.id, priority: rule.priority, region: rule.region, state },
      visibleIdle: rule.visible_idle,
      visibleBlocker: rule.visible_blocker,
      visibleWorking: rule.visible_working,
      skipStateUpdate: rule.skip_state_update,
    };
  }

  if (!matched) {
    return {
      agent: compiled.manifest.id,
      state: 'idle',
      source: 'bundled',
      manifestVersion: compiled.manifest.version ?? null,
      matchedRule: null,
      visibleIdle: false,
      visibleBlocker: false,
      visibleWorking: false,
      skipStateUpdate: false,
      skippedUpdateReason: null,
      fallbackReason: DEFAULT_KNOWN_AGENT_IDLE_FALLBACK,
      evaluatedRules,
      warnings: compiled.warnings,
    };
  }

  const { rule } = matched;
  return {
    agent: compiled.manifest.id,
    state: rule.state,
    source: 'bundled',
    manifestVersion: compiled.manifest.version ?? null,
    matchedRule: rule,
    visibleIdle: matched.visibleIdle && rule.state === 'idle',
    visibleBlocker: matched.visibleBlocker && rule.state === 'blocked',
    visibleWorking: matched.visibleWorking && rule.state === 'working',
    skipStateUpdate: matched.skipStateUpdate,
    skippedUpdateReason: matched.skipStateUpdate
      ? `matched_rule:${rule.id}`
      : null,
    fallbackReason: null,
    evaluatedRules,
    warnings: compiled.warnings,
  };
}

/** Explain for an adapter with no manifest at all (unknown agent). */
export function unknownAgentExplain(agentLabel: string): DetectionExplain {
  return {
    agent: agentLabel,
    state: 'unknown',
    source: null,
    manifestVersion: null,
    matchedRule: null,
    visibleIdle: false,
    visibleBlocker: false,
    visibleWorking: false,
    skipStateUpdate: false,
    skippedUpdateReason: null,
    fallbackReason: 'unknown_agent',
    evaluatedRules: [],
    warnings: [],
  };
}
