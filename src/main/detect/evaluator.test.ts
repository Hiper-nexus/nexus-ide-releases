import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { compileManifest, type CompiledManifest } from './compiler';
import {
  DEFAULT_KNOWN_AGENT_IDLE_FALLBACK,
  evaluateManifest,
  unknownAgentExplain,
} from './evaluator';
import { loadManifestDir, parseManifest } from './manifest';
import type { DetectionInput } from './regions';

const BUNDLED_DIR = path.resolve(
  __dirname,
  '../../../resources/agent-detection',
);

function compiledFor(id: string): CompiledManifest {
  const found = loadManifestDir(BUNDLED_DIR).find(
    ({ manifest }) => manifest.id === id,
  );
  if (!found) throw new Error(`manifest ${id} not bundled`);
  return compileManifest(found.manifest);
}

function input(screen: string, oscTitle = '', oscProgress = ''): DetectionInput {
  return { screen, oscTitle, oscProgress };
}

describe('evaluateManifest arbitration', () => {
  const doc = [
    'id = "x"',
    '[[rules]]',
    'id = "low"',
    'state = "idle"',
    'priority = 10',
    'contains = ["a"]',
    '[[rules]]',
    'id = "high"',
    'state = "blocked"',
    'priority = 20',
    'visible_blocker = true',
    'contains = ["a"]',
    '[[rules]]',
    'id = "tie-late"',
    'state = "working"',
    'priority = 20',
    'contains = ["a"]',
  ].join('\n');
  const compiled = compileManifest(parseManifest(doc));

  it('highest priority wins; ties keep the first declared rule', () => {
    const explain = evaluateManifest(compiled, input('a'));
    expect(explain.state).toBe('blocked');
    expect(explain.matchedRule?.id).toBe('high');
    expect(explain.visibleBlocker).toBe(true);
    expect(explain.fallbackReason).toBeNull();
    expect(explain.evaluatedRules).toHaveLength(3);
    expect(explain.evaluatedRules.every((rule) => rule.matched)).toBe(true);
  });

  it('no match with a known agent falls back to idle with a reason', () => {
    const explain = evaluateManifest(compiled, input('zzz'));
    expect(explain.state).toBe('idle');
    expect(explain.matchedRule).toBeNull();
    expect(explain.fallbackReason).toBe(DEFAULT_KNOWN_AGENT_IDLE_FALLBACK);
    expect(explain.visibleIdle).toBe(false);
  });

  it('skip_state_update resolves unknown and carries the matched rule reason', () => {
    const skipDoc = [
      'id = "x"',
      '[[rules]]',
      'id = "overlay"',
      'state = "unknown"',
      'priority = 1000',
      'skip_state_update = true',
      'contains = ["overlay"]',
    ].join('\n');
    const explain = evaluateManifest(
      compileManifest(parseManifest(skipDoc)),
      input('an overlay is open'),
    );
    expect(explain.state).toBe('unknown');
    expect(explain.skipStateUpdate).toBe(true);
    expect(explain.skippedUpdateReason).toBe('matched_rule:overlay');
  });

  it('visible flags only survive when the state agrees', () => {
    const visibleDoc = [
      'id = "x"',
      '[[rules]]',
      'id = "r"',
      'state = "idle"',
      'visible_idle = true',
      'visible_blocker = true',
      'contains = ["a"]',
    ].join('\n');
    const explain = evaluateManifest(
      compileManifest(parseManifest(visibleDoc)),
      input('a'),
    );
    expect(explain.visibleIdle).toBe(true);
    expect(explain.visibleBlocker).toBe(false);
  });

  it('evidence carries a bounded region preview', () => {
    const explain = evaluateManifest(compiled, input('a'.repeat(500)));
    const evidence = explain.evaluatedRules[0].evidence;
    expect(evidence.regionBytes).toBe(500);
    expect(evidence.regionPreview).toHaveLength(243); // 240 + "..."
  });

  it('unknownAgentExplain mirrors the upstream unknown-agent fallback', () => {
    const explain = unknownAgentExplain('mystery-cli');
    expect(explain.state).toBe('unknown');
    expect(explain.fallbackReason).toBe('unknown_agent');
    expect(explain.agent).toBe('mystery-cli');
  });
});

// ---------------------------------------------------------------------------
// Screen fixtures built from the real bundled rules. Each fixture exercises
// the exact controls the upstream rule gates on (see resources/agent-detection).
// ---------------------------------------------------------------------------

describe('claude manifest fixtures', () => {
  const claude = compiledFor('claude');

  it('spinner footer with esc-to-interrupt classifies working', () => {
    const screen = [
      '⏺ Reading files…',
      '',
      '⏵⏵ Accomplishing… (esc to interrupt · 12s)',
      '',
    ].join('\n');
    const explain = evaluateManifest(claude, input(screen));
    expect(explain.state).toBe('working');
    expect(explain.matchedRule?.id).toBe('live_turn_working');
    expect(explain.visibleWorking).toBe(true);
  });

  it('OSC busy title classifies working at top priority', () => {
    const explain = evaluateManifest(claude, input('anything', '⠸ task'));
    expect(explain.state).toBe('working');
    expect(explain.matchedRule?.id).toBe('osc_title_working');
  });

  it('prompt box classifies idle with visible evidence', () => {
    const screen = [
      '⏺ Done with the change.',
      '',
      '────────────────────────────────────────────',
      '❯ ',
      '────────────────────────────────────────────',
      '  ? for shortcuts',
      '',
    ].join('\n');
    const explain = evaluateManifest(claude, input(screen));
    expect(explain.state).toBe('idle');
    expect(explain.matchedRule?.id).toBe('live_prompt_box');
    expect(explain.visibleIdle).toBe(true);
  });

  it('bash permission form classifies blocked (higher priority than generic)', () => {
    const screen = [
      '⏺ Bash(ls -la /tmp)',
      '',
      'Do you want to proceed?',
      '❯ 1. Yes',
      '  2. Yes, and don\'t ask again for: ls',
      '  3. No',
      'esc to cancel',
      '',
    ].join('\n');
    const explain = evaluateManifest(claude, input(screen));
    expect(explain.state).toBe('blocked');
    expect(explain.matchedRule?.id).toBe('bash_permission_prompt');
    expect(explain.visibleBlocker).toBe(true);
  });

  it('model picker overlay skips the state update', () => {
    const screen = [
      'Select model',
      'enter to set as default · esc to cancel',
      '',
    ].join('\n');
    const explain = evaluateManifest(claude, input(screen));
    expect(explain.state).toBe('unknown');
    expect(explain.skipStateUpdate).toBe(true);
    expect(explain.matchedRule?.id).toBe('model_picker_menu');
  });

  it('OSC idle title (✳) classifies idle', () => {
    const explain = evaluateManifest(claude, input('', '✳ Claude Code'));
    expect(explain.state).toBe('idle');
    expect(explain.matchedRule?.id).toBe('osc_title_idle');
  });
});

describe('codex manifest fixtures', () => {
  const codex = compiledFor('codex');

  it('• Working footer classifies working', () => {
    const screen = [
      '• Explored codebase',
      '• Working (12s • esc to interrupt) · 2.1k tokens',
      '',
    ].join('\n');
    const explain = evaluateManifest(codex, input(screen));
    expect(explain.state).toBe('working');
    expect(explain.matchedRule?.id).toBe('screen_working_fallback');
  });

  it('trust-directory prompt classifies blocked from the top region', () => {
    const screen = [
      '> You are in /Users/dev/project',
      '',
      'Do you trust the contents of this directory?',
      '',
      '› 1. Yes, continue',
      '',
    ].join('\n');
    const explain = evaluateManifest(codex, input(screen));
    expect(explain.state).toBe('blocked');
    expect(explain.matchedRule?.id).toBe('trust_directory');
    expect(explain.visibleBlocker).toBe(true);
  });

  it('OSC "Action Required" title classifies blocked', () => {
    const explain = evaluateManifest(
      codex,
      input('', 'Action Required — Codex'),
    );
    expect(explain.state).toBe('blocked');
    expect(explain.matchedRule?.id).toBe('osc_title_blocked');
  });

  it('live prompt with no work markers falls back to idle', () => {
    const screen = ['• Work complete', '', '› ', ''].join('\n');
    const explain = evaluateManifest(codex, input(screen));
    expect(explain.state).toBe('idle');
    expect(explain.matchedRule).toBeNull();
    expect(explain.fallbackReason).toBe(DEFAULT_KNOWN_AGENT_IDLE_FALLBACK);
  });

  it('transcript viewer skips the state update', () => {
    const screen = [
      '› open transcript',
      '',
      '↑/↓ to scroll · pgup/pgdn to jump · home/end to jump · q to quit',
      'esc to edit prev',
      '',
    ].join('\n');
    const explain = evaluateManifest(codex, input(screen));
    expect(explain.state).toBe('unknown');
    expect(explain.skipStateUpdate).toBe(true);
    expect(explain.matchedRule?.id).toBe('transcript_viewer');
  });

  it('osc progress 4;0 classifies idle via OSC evidence', () => {
    const explain = evaluateManifest(codex, input('', 'codex', '4;0;'));
    // osc_title_idle (regex \S on "codex", no spinner, no Action Required)
    // wins by priority over nothing else matching.
    expect(explain.state).toBe('idle');
    expect(explain.matchedRule?.id).toBe('osc_title_idle');
  });
});
