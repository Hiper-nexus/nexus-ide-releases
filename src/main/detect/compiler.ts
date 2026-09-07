// Gate compiler for the detection engine. Ports Herdr's `compile_gate` /
// `compiled_gate_matches` (src/detect/manifest.rs) to JavaScript RegExp.
//
// Rust → JS regex translation happens once at load time:
//  - `\x{2722}` → `\u{2722}` (every compiled pattern carries the `u` flag,
//    which also unlocks the `\p{Alphabetic}` binary property used upstream).
//  - `\A` → `^` and `\z` → `$`: valid because inline `(?m)` is lifted into the
//    JS `m` flag before anchoring, so these absolute anchors only appear in
//    patterns without multiline semantics.
//  - Leading inline flag groups `(?i)`/`(?m)`/`(?s)` become JS flags. Every
//    bundled manifest places them at the pattern head; mid-pattern or scoped
//    `(?i:…)` forms are rejected rather than mis-translated. Unknown flag
//    letters (Rust's `x`/`u`, or the hypothetical `(?z)`) are dropped with a
//    compile warning instead of failing the whole manifest.
//
// Matcher semantics mirror `compiled_gate_matches` exactly: `contains` is
// case-insensitive on both sides, `regex` matches anywhere in the whole region
// text, `line_regex` requires at least one line of the region to match.

import type { AgentManifest, ManifestGate, ManifestRule } from './manifest';

export interface CompiledGate {
  all: CompiledGate[];
  any: CompiledGate[];
  not: CompiledGate[];
  contains: string[];
  regex: RegExp[];
  lineRegex: RegExp[];
}

export interface CompiledRule {
  rule: ManifestRule;
  gate: CompiledGate;
}

export interface CompiledManifest {
  manifest: AgentManifest;
  rules: CompiledRule[];
  /** Non-fatal translation notes (e.g. dropped unsupported inline flags). */
  warnings: string[];
}

const SUPPORTED_INLINE_FLAGS = new Set(['i', 'm', 's']);

function translatePattern(
  pattern: string,
  warnings: string[],
  context: string,
): { source: string; flags: string } {
  let source = pattern;
  let flags = 'u';

  // Lift leading inline flag groups (?ims) into JS flags.
  for (;;) {
    const match = /^\(\?([a-z]+)\)/.exec(source);
    if (!match) break;
    for (const flag of match[1]) {
      if (SUPPORTED_INLINE_FLAGS.has(flag)) {
        if (!flags.includes(flag)) flags += flag;
      } else {
        warnings.push(
          `${context}: dropped unsupported inline regex flag "(?${flag})" in ${JSON.stringify(pattern)}`,
        );
      }
    }
    source = source.slice(match[0].length);
  }
  // `(?:…)` non-capturing groups are fine; only lettered `(?flags:…)` scoped
  // forms are rejected — JS has no equivalent we can safely translate to.
  if (/\(\?[a-z]+:/.test(source)) {
    throw new Error(
      `${context}: scoped inline flags "(?flags:…)" are not supported: ${JSON.stringify(pattern)}`,
    );
  }
  if (/\(\?[a-z]+\)/.test(source)) {
    throw new Error(
      `${context}: inline flags are only supported at pattern start: ${JSON.stringify(pattern)}`,
    );
  }

  source = source
    .replace(/\\x\{([0-9a-fA-F]+)\}/g, '\\u{$1}')
    .replace(/\\A/g, '^')
    .replace(/\\z/g, '$');

  return { source, flags };
}

function compileRegex(
  pattern: string,
  warnings: string[],
  context: string,
): RegExp {
  const { source, flags } = translatePattern(pattern, warnings, context);
  try {
    return new RegExp(source, flags);
  } catch (err) {
    throw new Error(
      `${context}: invalid regex ${JSON.stringify(pattern)} (translated ${JSON.stringify(source)}): ${String(err)}`,
    );
  }
}

function compileGate(
  gate: ManifestGate,
  warnings: string[],
  context: string,
): CompiledGate {
  return {
    all: gate.all.map((nested, i) =>
      compileGate(nested, warnings, `${context}.all[${i}]`),
    ),
    any: gate.any.map((nested, i) =>
      compileGate(nested, warnings, `${context}.any[${i}]`),
    ),
    not: gate.not.map((nested, i) =>
      compileGate(nested, warnings, `${context}.not[${i}]`),
    ),
    contains: gate.contains.map((needle) => needle.toLowerCase()),
    regex: gate.regex.map((pattern) => compileRegex(pattern, warnings, context)),
    lineRegex: gate.line_regex.map((pattern) =>
      compileRegex(pattern, warnings, context),
    ),
  };
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

/** Compile a validated manifest; throws on any untranslatable pattern. */
export function compileManifest(manifest: AgentManifest): CompiledManifest {
  const warnings: string[] = [];
  const rules = manifest.rules.map((rule) => ({
    rule,
    gate: compileGate(gateFromRule(rule), warnings, `rule ${rule.id}`),
  }));
  return { manifest, rules, warnings };
}

/** `compiled_gate_matches`: direct matchers AND, nested all/any, not vetoes. */
export function compiledGateMatches(
  gate: CompiledGate,
  text: string,
  lowerText: string,
): boolean {
  for (const needle of gate.contains) {
    if (!lowerText.includes(needle)) return false;
  }
  for (const regex of gate.regex) {
    if (!regex.test(text)) return false;
  }
  for (const regex of gate.lineRegex) {
    let lineMatched = false;
    for (const line of text.split('\n')) {
      if (regex.test(line)) {
        lineMatched = true;
        break;
      }
    }
    if (!lineMatched) return false;
  }
  for (const nested of gate.all) {
    if (!compiledGateMatches(nested, text, lowerText)) return false;
  }
  if (gate.any.length > 0) {
    let anyMatched = false;
    for (const nested of gate.any) {
      if (compiledGateMatches(nested, text, lowerText)) {
        anyMatched = true;
        break;
      }
    }
    if (!anyMatched) return false;
  }
  for (const nested of gate.not) {
    if (compiledGateMatches(nested, text, lowerText)) return false;
  }
  return true;
}
