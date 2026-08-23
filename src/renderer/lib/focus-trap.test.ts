/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from 'vitest';
import { focusableWithin, nextTrapFocus } from './focus-trap';

function dialog(html: string): HTMLElement {
  document.body.innerHTML = `<div id="d">${html}</div>`;
  return document.getElementById('d')!;
}

describe('focusableWithin — só o que pode receber foco AGORA', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('ignora desabilitado, inert e aria-hidden', () => {
    const root = dialog(`
      <button id="a">a</button>
      <button id="b" disabled>b</button>
      <button id="c" inert>c</button>
      <button id="d" aria-hidden="true">d</button>
      <input id="e" />
      <input id="f" type="hidden" />
      <div id="g" tabindex="-1">g</div>
      <div id="h" tabindex="0">h</div>
    `);
    expect(focusableWithin(root).map((el) => el.id)).toEqual([
      'a',
      'e',
      'h',
    ]);
  });
});

describe('nextTrapFocus — o Tab não sai do diálogo', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('circula do último para o primeiro', () => {
    const root = dialog('<button id="a"></button><button id="b"></button>');
    const last = document.getElementById('b')!;
    expect(nextTrapFocus(root, last, false).next?.id).toBe('a');
  });

  it('Shift+Tab circula do primeiro para o último', () => {
    const root = dialog('<button id="a"></button><button id="b"></button>');
    const first = document.getElementById('a')!;
    expect(nextTrapFocus(root, first, true).next?.id).toBe('b');
  });

  it('foco fora do diálogo é trazido para dentro', () => {
    const root = dialog('<button id="a"></button><button id="b"></button>');
    expect(nextTrapFocus(root, null, false).next?.id).toBe('a');
    expect(nextTrapFocus(root, null, true).next?.id).toBe('b');
  });

  it('diálogo sem foco possível não sequestra o Tab', () => {
    const root = dialog('<p>só texto</p>');
    expect(nextTrapFocus(root, null, false)).toEqual({
      handled: false,
      next: null,
    });
  });
});
