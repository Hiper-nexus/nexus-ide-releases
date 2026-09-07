import { describe, expect, it } from 'vitest';

import { compileManifest, compiledGateMatches } from './compiler';
import { parseManifest } from './manifest';

function compileDoc(doc: string) {
  return compileManifest(parseManifest(doc));
}

function gateOf(doc: string) {
  return compileDoc(doc).rules[0].gate;
}

function matches(doc: string, text: string): boolean {
  const gate = gateOf(doc);
  return compiledGateMatches(gate, text, text.toLowerCase());
}

describe('regex translation (Rust → JS)', () => {
  it('translates \\x{…} escapes into \\u{…} with the u flag', () => {
    const doc = [
      'id = "x"',
      '[[rules]]',
      'id = "r"',
      "regex = ['^[\\x{2800}-\\x{28FF}] ']",
    ].join('\n');
    expect(matches(doc, '⠋ spinner')).toBe(true);
    expect(matches(doc, 'x spinner')).toBe(false);
  });

  it('lifts leading (?i) into a JS flag', () => {
    const doc = [
      'id = "x"',
      '[[rules]]',
      'id = "r"',
      "line_regex = ['(?i)^\\s*❯?\\s*1\\.\\s*yes\\b']",
    ].join('\n');
    expect(matches(doc, '❯ 1. YES, do it')).toBe(true);
    expect(matches(doc, 'nope')).toBe(false);
  });

  it('lifts (?m) so ^/$ become line anchors in whole-region regexes', () => {
    const doc = [
      'id = "x"',
      '[[rules]]',
      'id = "r"',
      "regex = ['(?m)^\\s*❯\\s*$']",
    ].join('\n');
    expect(matches(doc, 'output\n❯ \nfooter')).toBe(true);
    expect(matches(doc, 'output ❯ footer')).toBe(false);
  });

  it('lifts (?s) so . crosses newlines', () => {
    const doc = [
      'id = "x"',
      '[[rules]]',
      'id = "r"',
      "regex = ['(?s)Do\\s+you\\s+trust.*directory\\?']",
    ].join('\n');
    expect(matches(doc, 'Do you\ntrust the contents of this directory?')).toBe(
      true,
    );
  });

  it('translates \\A and \\z absolute anchors', () => {
    const doc = [
      'id = "x"',
      '[[rules]]',
      'id = "r"',
      "regex = ['\\A> You are in [^\\r\\n]+(?:\\r?\\n|$)']",
    ].join('\n');
    expect(matches(doc, '> You are in /tmp/x\nrest')).toBe(true);
    expect(matches(doc, 'lead\n> You are in /tmp/x\n')).toBe(false);
  });

  it('supports \\p{Alphabetic} via the u flag', () => {
    const doc = [
      'id = "x"',
      '[[rules]]',
      'id = "r"',
      "line_regex = ['^\\s*\\p{Alphabetic}+\\w*ing\\b']",
    ].join('\n');
    expect(matches(doc, '  Thinking')).toBe(true);
    expect(matches(doc, '123')).toBe(false);
  });

  it('rejects scoped inline flags instead of mistranslating them', () => {
    const doc = [
      'id = "x"',
      '[[rules]]',
      'id = "r"',
      "regex = ['(?i:foo)bar']",
    ].join('\n');
    expect(() => compileDoc(doc)).toThrow(/scoped inline flags/);
  });

  it('drops unknown inline flag letters with a warning', () => {
    const doc = [
      'id = "x"',
      '[[rules]]',
      'id = "r"',
      "regex = ['(?z)^foo$']",
    ].join('\n');
    const compiled = compileDoc(doc);
    expect(compiled.warnings.some((w) => w.includes('(?z)'))).toBe(true);
    expect(
      compiledGateMatches(
        compiled.rules[0].gate,
        'foo',
        'foo',
      ),
    ).toBe(true);
  });
});

describe('gate semantics (compiled_gate_matches parity)', () => {
  it('contains is case-insensitive on both sides', () => {
    const doc = [
      'id = "x"',
      '[[rules]]',
      'id = "r"',
      'contains = ["Do You Want To Proceed?"]',
    ].join('\n');
    expect(matches(doc, '… do you want to proceed? …')).toBe(true);
  });

  it('regex matches anywhere in the region; line_regex needs one line', () => {
    const regexDoc = [
      'id = "x"',
      '[[rules]]',
      'id = "r"',
      "regex = ['foo\\s+bar']",
    ].join('\n');
    // \s spans newlines in both engines; a run without whitespace misses.
    expect(matches(regexDoc, 'foo\nbar')).toBe(true);
    expect(matches(regexDoc, 'foobar')).toBe(false);

    const lineDoc = [
      'id = "x"',
      '[[rules]]',
      'id = "r"',
      "line_regex = ['^foo$']",
    ].join('\n');
    expect(matches(lineDoc, 'a\nfoo\nb')).toBe(true);
    expect(matches(lineDoc, 'food')).toBe(false);
  });

  it('any requires one branch; not vetoes the whole gate', () => {
    const doc = [
      'id = "x"',
      '[[rules]]',
      'id = "r"',
      'contains = ["esc to cancel"]',
      'any = [{ contains = ["enter to confirm"] }, { contains = ["enter to select"] }]',
      'not = [{ contains = ["do you want to proceed?"] }]',
    ].join('\n');
    expect(matches(doc, 'enter to confirm · esc to cancel')).toBe(true);
    expect(matches(doc, 'enter to select · esc to cancel')).toBe(true);
    expect(matches(doc, 'esc to cancel')).toBe(false);
    expect(
      matches(doc, 'do you want to proceed?\nenter to confirm · esc to cancel'),
    ).toBe(false);
  });

  it('nested all/any/not compose recursively', () => {
    const doc = [
      'id = "x"',
      '[[rules]]',
      'id = "r"',
      'contains = ["outer"]',
      'all = [',
      '  { any = [',
      '    { contains = ["yes"] },',
      '    { contains = ["no"], not = [{ contains = ["not really"] }] },',
      '  ] },',
      ']',
    ].join('\n');
    expect(matches(doc, 'outer yes')).toBe(true);
    expect(matches(doc, 'outer no')).toBe(true);
    expect(matches(doc, 'outer not really no')).toBe(false);
    expect(matches(doc, 'yes')).toBe(false);
  });
});
