import { describe, expect, it } from 'vitest';

import { compileManifest, compiledGateMatches } from './compiler';
import { parseManifest } from './manifest';
import { cpuTimeMs } from '../../test/cpu-time';

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

describe('prefixo `.*` redundante (F-764 C.3)', () => {
  const OPENCODE_DOC = [
    'id = "x"',
    '[[rules]]',
    'id = "r"',
    "line_regex = ['(?i).*opencode.*esc (again to )?interrupt']",
  ].join('\n');

  it('casa exatamente as mesmas linhas que o padrão original', () => {
    const original = /.*opencode.*esc (again to )?interrupt/iu;
    const pieces = ['opencode', 'OpenCode', ' esc ', 'esc ', 'again to ', 'interrupt', 'x', ' '];
    let seed = 34;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let round = 0; round < 10_000; round += 1) {
      let line = '';
      const length = Math.floor(random() * 8);
      for (let i = 0; i < length; i += 1) line += pieces[Math.floor(random() * pieces.length)];
      expect(matches(OPENCODE_DOC, line), JSON.stringify(line)).toBe(original.test(line));
    }
  });

  it('linha de 16 KB sem o termo: tempo linear', () => {
    const line = 'abc def ghi '.repeat(1_366);
    expect(matches(OPENCODE_DOC, line)).toBe(false);
    // Com o `.*` inicial a mesma linha custava ~120 ms (714 ms com moldura).
    expect(cpuTimeMs(() => matches(OPENCODE_DOC, line))).toBeLessThan(20);
  });

  it('o `.*` do meio também é linear: muitas ocorrências do termo, sem o resto', () => {
    // Medido: 16 KB custavam 13 ms e 64 KB 186 ms (cada "opencode" levava o
    // `.*` ao fim e de volta); o runner do CI passava do teto de 50 ms.
    const line = (size: number) => 'opencode '.repeat(Math.floor(size / 9));
    expect(matches(OPENCODE_DOC, line(16_384))).toBe(false);
    expect(cpuTimeMs(() => matches(OPENCODE_DOC, line(16_384)))).toBeLessThan(5);
    expect(cpuTimeMs(() => matches(OPENCODE_DOC, line(65_536)))).toBeLessThan(20);
  });

  it('trechos separados por CR ou separador Unicode casam como no original', () => {
    const original = /.*opencode.*esc (again to )?interrupt/iu;
    const pieces = ['opencode', 'esc ', 'interrupt', 'again to ', '\r', '\u2028', '\u2029', 'x'];
    let seed = 91;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let round = 0; round < 10_000; round += 1) {
      let line = '';
      const length = Math.floor(random() * 9);
      for (let i = 0; i < length; i += 1) line += pieces[Math.floor(random() * pieces.length)];
      expect(matches(OPENCODE_DOC, line), JSON.stringify(line)).toBe(original.test(line));
    }
  });

  it('`regex` roda na região inteira: casa depois de um LF como o original', () => {
    const doc = (pattern: string) => ['id = "x"', '[[rules]]', 'id = "r"', `regex = ['${pattern}']`].join('\n');
    expect(matches(doc('foo.*bar'), 'prefix\nfoo---bar')).toBe(true);
    expect(matches(doc('foo.*bar'), 'foo\nbar')).toBe(false);
    // Com `(?s)` o `.` cruza a linha: nada de reescrita, o original decide.
    expect(matches(doc('(?s)foo.*bar'), 'foo\nbar')).toBe(true);
    const pieces = ['foo', 'bar', '\n', '\r', '-', ' '];
    for (const flags of ['', '(?s)', '(?m)']) {
      const original = new RegExp(`foo.*bar`, `u${flags.replace(/[()?]/g, '')}`);
      let seed = 7;
      const random = () => {
        seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };
      for (let round = 0; round < 5_000; round += 1) {
        let text = '';
        const length = Math.floor(random() * 9);
        for (let i = 0; i < length; i += 1) text += pieces[Math.floor(random() * pieces.length)];
        expect(matches(doc(`${flags}foo.*bar`), text), `${flags} ${JSON.stringify(text)}`).toBe(original.test(text));
      }
    }
  });

  it('padrão que é só `.*` continua casando qualquer texto', () => {
    const doc = ['id = "x"', '[[rules]]', 'id = "r"', "regex = ['.*']"].join('\n');
    expect(matches(doc, '')).toBe(true);
    expect(matches(doc, 'qualquer coisa')).toBe(true);
  });
});


describe('F-764 optional prompt glyph ambiguity', () => {
  it('preserves literal optional-glyph matching without quadratic whitespace repartitioning', () => {
    const manifest = parseManifest([
      'id = "test-prefix"',
      '[[rules]]',
      'id = "accept"', 'state = "blocked"', 'region = "whole_recent"',
      "line_regex = ['^\\s*❯?\\s*Accept\\b']",
    ].join('\n'));
    const regex = compileManifest(manifest).rules[0].gate.lineRegex[0];
    const original = /^\s*❯?\s*Accept\b/u;
    for (const spaces of ['', ' ', '\t', '\n', ' '.repeat(64)]) {
      for (const text of ['Accept', '❯Accept', '❯ Accept', 'Decline', 'xAccept']) {
        expect(regex.test(spaces + text)).toBe(original.test(spaces + text));
      }
    }
    const before = performance.now();
    expect(regex.test(' '.repeat(32_767) + 'x')).toBe(false);
    expect(performance.now() - before).toBeLessThan(50);
  });
});

it('normalizes an optional explicit non-space glyph class with the same language', () => {
  const doc = ['id = "class-prefix"', '[[rules]]', 'id = "allow"', "line_regex = ['^\\s*[▸>]?\\s*1\\.\\s*allow']"].join('\n');
  const regex = compileDoc(doc).rules[0].gate.lineRegex[0]; const original = /^\s*[▸>]?\s*1\.\s*allow/u;
  for (const text of ['1. allow', ' > 1. allow', '\t▸\t1. allow', '2. deny', ' '.repeat(64) + 'x']) expect(regex.test(text)).toBe(original.test(text));
  const before = performance.now(); expect(regex.test(' '.repeat(32_767) + 'x')).toBe(false); expect(performance.now() - before).toBeLessThan(50);
});
