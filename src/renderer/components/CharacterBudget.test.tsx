/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CharacterBudget,
  characterBudgetMessage,
  characterBudgetTone,
  formatCharacterBudget,
} from './CharacterBudget';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function mount(value: string, limit: number) {
  act(() => {
    root.render(<CharacterBudget value={value} limit={limit} id="b" label="Produto" />);
  });
}

describe('orçamento de caracteres', () => {
  it('fica calmo com folga, avisa perto do teto e acusa o excesso', () => {
    expect(characterBudgetTone(10, 100)).toBe('calm');
    expect(characterBudgetTone(89, 100)).toBe('calm');
    expect(characterBudgetTone(90, 100)).toBe('near');
    expect(characterBudgetTone(100, 100)).toBe('near');
    expect(characterBudgetTone(101, 100)).toBe('over');
  });

  it('o número sai no formato do pt-BR', () => {
    expect(formatCharacterBudget(1_234, 6_000)).toBe('1.234 / 6.000');
  });

  it('diz quantos caracteres tirar, e que nada foi cortado', () => {
    expect(characterBudgetMessage(50, 100)).toBeNull();
    expect(characterBudgetMessage(100, 100)).toBeNull();
    expect(characterBudgetMessage(101, 100)).toContain('Passou 1 caractere');
    const muito = characterBudgetMessage(1_300, 100);
    expect(muito).toContain('Passou 1.200 caracteres');
    expect(muito).toContain('nada é cortado sem você ver');
  });

  it('some no campo vazio e aparece assim que há texto', () => {
    mount('', 100);
    expect(host.textContent).toBe('');
    mount('abc', 100);
    expect(host.textContent).toContain('3 / 100');
  });

  it('o excesso é anunciado como alerta, com o campo nomeado', () => {
    mount('x'.repeat(105), 100);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Passou 5 caracteres');
    expect(host.textContent).toContain('Produto:');
    expect(host.querySelector('.char-budget__count--over')).toBeTruthy();
  });
});
