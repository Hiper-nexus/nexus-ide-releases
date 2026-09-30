import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { compileManifest } from './compiler';
import {
  isValidRegionName,
  loadManifestDir,
  parseManifest,
  resolveManifestDir,
} from './manifest';

const BUNDLED_DIR = path.resolve(
  __dirname,
  '../../../resources/agent-detection',
);

function minimalManifest(ruleExtra = '', headerExtra = ''): string {
  return [
    'id = "testcli"',
    headerExtra,
    '',
    '[[rules]]',
    'id = "working"',
    'state = "working"',
    'contains = ["working"]',
    ruleExtra,
  ].join('\n');
}

describe('parseManifest schema', () => {
  it('parses a minimal manifest with defaults', () => {
    const manifest = parseManifest(minimalManifest());
    expect(manifest.id).toBe('testcli');
    expect(manifest.aliases).toEqual([]);
    expect(manifest.rules).toHaveLength(1);
    expect(manifest.rules[0].priority).toBe(0);
    expect(manifest.rules[0].region).toBe('whole_recent');
    expect(manifest.rules[0].skip_state_update).toBe(false);
  });

  it('rejects unknown fields (deny_unknown_fields parity)', () => {
    expect(() =>
      parseManifest(minimalManifest('bogus_field = true')),
    ).toThrow();
    expect(() =>
      parseManifest('id = "x"\nbogus = 1\n[[rules]]\nid="r"\ncontains=["a"]'),
    ).toThrow();
  });

  it('rejects a manifest without rules', () => {
    expect(() => parseManifest('id = "x"')).toThrow(/at least one rule/);
  });

  it('rejects more than 128 rules', () => {
    const rules = Array.from(
      { length: 129 },
      (_, i) => `[[rules]]\nid = "r${i}"\ncontains = ["x"]`,
    ).join('\n');
    expect(() => parseManifest(`id = "x"\n${rules}`)).toThrow(/max is 128/);
  });

  it('rejects skip_state_update without state = "unknown"', () => {
    expect(() =>
      parseManifest(
        minimalManifest('', '').replace(
          'state = "working"',
          'state = "working"\nskip_state_update = true',
        ),
      ),
    ).toThrow(/skip_state_update without state = "unknown"/);
  });

  it('rejects skip_state_update with visible evidence flags', () => {
    const doc = [
      'id = "x"',
      '[[rules]]',
      'id = "r"',
      'state = "unknown"',
      'skip_state_update = true',
      'visible_idle = true',
      'contains = ["a"]',
    ].join('\n');
    expect(() => parseManifest(doc)).toThrow(/visible state evidence/);
  });

  it('rejects gates without a positive matcher', () => {
    const doc = [
      'id = "x"',
      '[[rules]]',
      'id = "r"',
      'not = [{ contains = ["a"] }]',
    ].join('\n');
    expect(() => parseManifest(doc)).toThrow(/positive matcher/);
  });

  it('rejects empty not gates', () => {
    const doc = [
      'id = "x"',
      '[[rules]]',
      'id = "r"',
      'contains = ["a"]',
      'not = [{ }]',
    ].join('\n');
    expect(() => parseManifest(doc)).toThrow();
  });

  it('rejects matchers longer than 512 chars', () => {
    const long = 'a'.repeat(513);
    expect(() =>
      parseManifest(`id = "x"\n[[rules]]\nid = "r"\ncontains = ["${long}"]`),
    ).toThrow(/max length 512/);
  });

  it('rejects gate nesting deeper than 8', () => {
    let gate = '{ contains = ["x"] }';
    for (let i = 0; i < 9; i++) gate = `{ all = [${gate}] }`;
    const doc = `id = "x"\n[[rules]]\nid = "r"\ncontains = ["y"]\nall = [${gate}]`;
    expect(() => parseManifest(doc)).toThrow(/max gate depth/);
  });

  it('rejects min_engine_version above the current engine', () => {
    expect(() =>
      parseManifest(minimalManifest('', 'min_engine_version = 99')),
    ).toThrow(/requires engine 99/);
  });

  it('gates top_non_empty_lines behind min_engine_version 3', () => {
    const doc = [
      'id = "x"',
      'min_engine_version = 2',
      '[[rules]]',
      'id = "r"',
      'region = "top_non_empty_lines(5)"',
      'contains = ["a"]',
    ].join('\n');
    expect(() => parseManifest(doc)).toThrow(/top_non_empty_lines/);
  });
});

describe('region names', () => {
  it('accepts all upstream named and counted regions', () => {
    for (const name of [
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
      'bottom_lines(3)',
      'bottom_non_empty_lines(20)',
      'top_non_empty_lines(1)',
    ]) {
      expect(isValidRegionName(name), name).toBe(true);
    }
  });

  it('rejects malformed counts like Rust usize parsing', () => {
    expect(isValidRegionName('bottom_lines(12x)')).toBe(false);
    expect(isValidRegionName('bottom_lines(-1)')).toBe(false);
    expect(isValidRegionName('top_non_empty_lines(01)')).toBe(false);
    expect(isValidRegionName('bogus_region')).toBe(false);
  });
});

describe('bundled manifest contract (20 Herdr manifests + minimax-code do Nexus)', () => {
  const files = fs
    .readdirSync(BUNDLED_DIR)
    .filter((name) => name.endsWith('.toml'));

  it('ships exactly the 20 upstream manifests plus the Nexus-authored minimax-code (F-699)', () => {
    expect(files).toHaveLength(21);
    expect(files).toContain('minimax-code.toml');
  });

  it('resolves the bundled directory via the default candidate chain', () => {
    expect(resolveManifestDir()).toBe(BUNDLED_DIR);
  });

  it('every bundled manifest parses and compiles (regex translation check)', () => {
    const loaded = loadManifestDir(BUNDLED_DIR);
    expect(loaded).toHaveLength(21);
    for (const { manifest, file } of loaded) {
      const compiled = compileManifest(manifest);
      expect(compiled.rules.length, file).toBeGreaterThan(0);
      expect(compiled.rules.length, file).toBe(compiled.manifest.rules.length);
    }
  });

  it('manifest ids are unique and carry the expected shape', () => {
    const loaded = loadManifestDir(BUNDLED_DIR);
    const ids = loaded.map(({ manifest }) => manifest.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('claude');
    expect(ids).toContain('codex');
    const claude = loaded.find(({ manifest }) => manifest.id === 'claude');
    expect(claude?.manifest.aliases).toContain('claude-code');
  });
});
