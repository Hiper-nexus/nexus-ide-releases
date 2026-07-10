import { describe, expect, it } from 'vitest';
import { parse } from '@babel/parser';
import {
  applyClassNameEdit,
  applyDelete,
  applyDuplicate,
  applyInlineStyleEdit,
  applyReorder,
  applyRestore,
  applyTextEdit,
} from './design-code-edit';

const BUTTON_FILE = `import React from 'react';

// comentário que NUNCA deve mudar    (espaçamento estranho preservado)
export function SaveButton({ label }) {
  return (
    <button
      id="save-cta"
      data-nexus-id="nx1"
      className="btn btn-primary"
      onClick={() => console.log('salvar')}
    >
      Salvar
    </button>
  );
}
`;

const CARDS_FILE = `export function Cards() {
  return (
    <section data-nexus-id="parent1" className="grid">
      <article data-nexus-id="c1">Um</article>
      <article data-nexus-id="c2" key="two">Dois</article>
      <article data-nexus-id="c3">Três</article>
    </section>
  );
}
`;

/** Every line except the touched ones must survive byte-for-byte. */
function unchangedLines(before: string, after: string): number {
  const beforeLines = new Set(before.split('\n'));
  return after.split('\n').filter((line) => beforeLines.has(line)).length;
}

function expectParsable(code: string): void {
  expect(() =>
    parse(code, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript'],
    }),
  ).not.toThrow();
}

describe('applyClassNameEdit', () => {
  it('adds classes to an existing string className with minimal diff', () => {
    const result = applyClassNameEdit(BUTTON_FILE, 'nx1', {
      add: ['bg-[#16a34a]', 'pt-[24px]'],
      remove: [],
    });
    expect(result.code).toContain('className="btn btn-primary bg-[#16a34a] pt-[24px]"');
    expect(result.code).toContain('// comentário que NUNCA deve mudar    (espaçamento estranho preservado)');
    // Only the className line changed.
    expect(result.code.split('\n').length).toBe(BUTTON_FILE.split('\n').length);
    expect(unchangedLines(BUTTON_FILE, result.code)).toBe(
      BUTTON_FILE.split('\n').length - 1,
    );
    // Inverse undoes exactly.
    expect(result.inverse).toEqual({ add: [], remove: ['bg-[#16a34a]', 'pt-[24px]'] });
    const undone = applyClassNameEdit(result.code, 'nx1', result.inverse);
    expect(undone.code).toBe(BUTTON_FILE);
  });

  it('creates the className attribute when missing and removes it when emptied', () => {
    const added = applyClassNameEdit(CARDS_FILE, 'c1', { add: ['p-4'], remove: [] });
    expect(added.code).toContain('<article data-nexus-id="c1" className="p-4">Um</article>');
    const removed = applyClassNameEdit(added.code, 'c1', added.inverse);
    expect(removed.code).toBe(CARDS_FILE);
  });

  it('replaces an existing class (remove + add) idempotently', () => {
    const result = applyClassNameEdit(BUTTON_FILE, 'nx1', {
      add: ['btn-secondary'],
      remove: ['btn-primary'],
    });
    expect(result.code).toContain('className="btn btn-secondary"');
    const undone = applyClassNameEdit(result.code, 'nx1', result.inverse);
    expect(undone.code).toBe(BUTTON_FILE);
  });

  it('fails clearly for an unknown id or a dynamic className', () => {
    expect(() =>
      applyClassNameEdit(BUTTON_FILE, 'ghost', { add: ['x'], remove: [] }),
    ).toThrow(/data-nexus-id/);
    const dynamic = `export const A = () => <div data-nexus-id="d1" className={cn('a')} />;\n`;
    expect(() =>
      applyClassNameEdit(dynamic, 'd1', { add: ['x'], remove: [] }),
    ).toThrow(/dynamic|expression/i);
  });

  it('keeps renderer-controlled quotes and JSX syntax inside className data', () => {
    const injected = 'x"onClick={()=>globalThis.pwned()}foo="bar';
    const result = applyClassNameEdit(CARDS_FILE, 'c1', {
      add: [injected],
      remove: [],
    });

    expectParsable(result.code);
    expect(result.code).not.toContain('"onClick=');
    expect(applyClassNameEdit(result.code, 'c1', result.inverse).code).toBe(
      CARDS_FILE,
    );
  });
});

describe('applyInlineStyleEdit', () => {
  it('updates and adds properties in a style object literal', () => {
    const source = `export const B = () => (
  <button data-nexus-id="s1" style={{ background: '#2f6ae0', color: '#fff' }}>x</button>
);
`;
    const result = applyInlineStyleEdit(source, 's1', {
      background: '#16a34a',
      paddingTop: '24px',
    });
    expect(result.code).toContain("background: '#16a34a'");
    expect(result.code).toContain("paddingTop: '24px'");
    expect(result.code).toContain("color: '#fff'");
    // Inverse restores the original value and removes the added prop.
    const undone = applyInlineStyleEdit(result.code, 's1', result.inverse);
    expect(undone.code).toBe(source);
  });

  it('creates the style attribute when missing; null removes a property', () => {
    const source = `export const C = () => <em data-nexus-id="s2">x</em>;\n`;
    const withStyle = applyInlineStyleEdit(source, 's2', { color: 'red' });
    expect(withStyle.code).toContain("style={{ color: 'red' }}");
    const cleared = applyInlineStyleEdit(withStyle.code, 's2', { color: null });
    expect(cleared.code).toBe(source);
  });

  it('keeps quotes, backticks, interpolation and braces as a literal style value', () => {
    const source = `export const C = () => <em data-nexus-id="s2">x</em>;\n`;
    const value = `red'; globalThis.pwned(); // \`${'${danger}'}\` { value }`;
    const result = applyInlineStyleEdit(source, 's2', { color: value });

    expectParsable(result.code);
    const inverse = applyInlineStyleEdit(result.code, 's2', { color: 'blue' });
    expect(inverse.inverse.color).toBe(value);
  });

  it('rejects renderer-controlled style property syntax', () => {
    const source = `export const C = () => <em data-nexus-id="s2">x</em>;\n`;
    expect(() =>
      applyInlineStyleEdit(source, 's2', {
        "color: 'red' }, onClick: globalThis.pwned, x": 'blue',
      }),
    ).toThrow(/style property/i);
  });
});

describe('applyTextEdit', () => {
  it('replaces a single text child and reports the previous text', () => {
    const result = applyTextEdit(BUTTON_FILE, 'nx1', 'Enviar agora');
    expect(result.code).toContain('Enviar agora');
    expect(result.code).not.toContain('Salvar\n');
    expect(result.previousText).toBe('Salvar');
    const undone = applyTextEdit(result.code, 'nx1', result.previousText);
    expect(undone.code).toBe(BUTTON_FILE);
  });

  it('refuses elements whose children are not plain text (agent territory)', () => {
    expect(() => applyTextEdit(CARDS_FILE, 'parent1', 'x')).toThrow(/text/i);
  });

  it('keeps JSX, braces, backticks and interpolation as inert text', () => {
    const text = `</button><script>{globalThis.pwned()}</script><button> \`${'${danger}'}\``;
    const result = applyTextEdit(BUTTON_FILE, 'nx1', text);

    expectParsable(result.code);
    expect(result.code).not.toContain('<script>');
    expect(result.code).not.toContain('{globalThis.pwned()}');
    expect(applyTextEdit(result.code, 'nx1', 'safe').previousText).toBe(text);
  });
});

describe('applyReorder', () => {
  it('moves a child without persisting synthetic React keys', () => {
    const result = applyReorder(CARDS_FILE, 'parent1', 2, 0);
    const first = result.code.indexOf('Três');
    expect(first).toBeGreaterThan(-1);
    expect(first).toBeLessThan(result.code.indexOf('Um'));
    // Existing source semantics stay intact: authored keys remain, unkeyed
    // children remain unkeyed.
    expect(result.code).toContain('key="two"');
    expect(result.code).not.toMatch(/key="nx-/);
    expect(result.inverse).toEqual({ fromIndex: 0, toIndex: 2 });
  });

  it('round-trips byte-identically through its inverse', () => {
    const moved = applyReorder(CARDS_FILE, 'parent1', 0, 2);
    const back = applyReorder(
      moved.code,
      'parent1',
      moved.inverse.fromIndex,
      moved.inverse.toIndex,
    );
    expect(back.code).toBe(CARDS_FILE);
  });

  it('is deterministic across PCs with different ephemeral ids', () => {
    const onPcA = CARDS_FILE.replaceAll('parent1', 'a-parent')
      .replaceAll('c1', 'a-one')
      .replaceAll('c2', 'a-two')
      .replaceAll('c3', 'a-three');
    const onPcB = CARDS_FILE.replaceAll('parent1', 'b-parent')
      .replaceAll('c1', 'b-one')
      .replaceAll('c2', 'b-two')
      .replaceAll('c3', 'b-three');
    const stripEphemeralIds = (code: string) =>
      code.replaceAll(/ data-nexus-id="[^"]+"/g, '');

    const resultA = applyReorder(onPcA, 'a-parent', 2, 0);
    const resultB = applyReorder(onPcB, 'b-parent', 2, 0);

    expect(stripEphemeralIds(resultA.code)).toBe(stripEphemeralIds(resultB.code));
    expect(resultA.inverse).toEqual(resultB.inverse);
  });

  it('rejects out-of-range indexes', () => {
    expect(() => applyReorder(CARDS_FILE, 'parent1', 0, 9)).toThrow(/index/i);
  });
});

describe('findSiblingPosition', () => {
  it('reports parent id, index and sibling count for a tagged element', async () => {
    const { findSiblingPosition } = await import('./design-code-edit');
    expect(findSiblingPosition(CARDS_FILE, 'c2')).toEqual({
      parentNexusId: 'parent1',
      index: 1,
      count: 3,
    });
    expect(() => findSiblingPosition(CARDS_FILE, 'ghost')).toThrow(/data-nexus-id/);
  });
});

describe('applyDelete / applyRestore / applyDuplicate', () => {
  it('delete removes the element and restore brings it back verbatim', () => {
    const deleted = applyDelete(CARDS_FILE, 'c2');
    expect(deleted.code).not.toContain('Dois');
    const restored = applyRestore(
      deleted.code,
      deleted.restore.parentNexusId,
      deleted.restore.index,
      deleted.restore.snippet,
    );
    expect(restored.code).toContain('Dois');
    const reordered = restored.code.indexOf('Um') < restored.code.indexOf('Dois') &&
      restored.code.indexOf('Dois') < restored.code.indexOf('Três');
    expect(reordered).toBe(true);
  });

  it('duplicate inserts a sibling copy WITHOUT the ephemeral id', () => {
    const result = applyDuplicate(CARDS_FILE, 'c1');
    const occurrences = result.code.split('data-nexus-id="c1"').length - 1;
    expect(occurrences).toBe(1);
    expect(result.code.split('>Um<').length - 1).toBe(2);
    expect(result.duplicatedFromIndex).toBe(0);
  });
});
