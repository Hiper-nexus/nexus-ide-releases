import { beforeEach, describe, expect, it } from 'vitest';
import {
  claimPaneNumber,
  hydratePaneNumbers,
  livePaneNumbers,
  paneNumberOf,
  releasePaneNumber,
  resolvePaneRef,
  validPaneNumbersLabel,
} from './pane-numbers';
import type { PaneModel } from '../../shared/types';

function pane(id: string, paneNumber?: number): PaneModel {
  return { id, kind: 'shell', title: id, ...(paneNumber ? { paneNumber } : {}) };
}

/**
 * O registro do renderer é um singleton de módulo — de propósito: dois
 * numeradores dariam dois panes com o mesmo número. Cada teste começa
 * re-semeando o registro (que é o que a hidratação de workspace faz), então
 * não há dependência de ordem entre testes.
 */
describe('registro de números de pane do renderer', () => {
  beforeEach(() => {
    hydratePaneNumbers([]);
  });

  it('numera a partir de 1 e é idempotente', () => {
    expect(claimPaneNumber('pane-a')).toBe(1);
    expect(claimPaneNumber('pane-a')).toBe(1);
    expect(claimPaneNumber('pane-b')).toBe(2);
  });

  it('resolve a referência como o humano a dita', () => {
    claimPaneNumber('pane-a');
    const n = claimPaneNumber('pane-b');
    for (const forma of [`${n}`, `#${n}`, `pane ${n}`, `pane-${n}`, 'pane dois']) {
      expect(resolvePaneRef(forma)).toBe('pane-b');
    }
  });

  it('o id interno cru continua válido — o número é adição, não troca', () => {
    claimPaneNumber('pane-a');
    expect(resolvePaneRef('pane-a')).toBe('pane-a');
  });

  it('reusa o menor número livre depois de fechar', () => {
    claimPaneNumber('pane-a'); // 1
    claimPaneNumber('pane-b'); // 2
    claimPaneNumber('pane-c'); // 3
    releasePaneNumber('pane-b');
    expect(paneNumberOf('pane-b')).toBeNull();
    expect(claimPaneNumber('pane-d')).toBe(2);
    expect(paneNumberOf('pane-c')).toBe(3);
  });

  it('número de pane fechado recusa em vez de apontar para outro pane', () => {
    claimPaneNumber('pane-a');
    releasePaneNumber('pane-a');
    claimPaneNumber('pane-b'); // reusa o 1
    // Nada de "quase certo": o 1 agora é do pane-b, e o pane-a não resolve.
    expect(resolvePaneRef('pane-a')).toBeNull();
    expect(resolvePaneRef('pane 1')).toBe('pane-b');
  });

  it('hidratação devolve o número persistido a cada pane (sobrevive ao restart)', () => {
    const restored = hydratePaneNumbers([
      pane('pane-a', 3),
      pane('pane-b', 1),
      pane('pane-legado'),
    ]);
    expect(restored.get('pane-a')).toBe(3);
    expect(restored.get('pane-b')).toBe(1);
    expect(restored.get('pane-legado')).toBe(2);
    expect(resolvePaneRef('pane 3')).toBe('pane-a');
  });

  it('hidratar outro workspace descarta os números do anterior', () => {
    hydratePaneNumbers([pane('pane-antigo', 9)]);
    hydratePaneNumbers([pane('pane-novo')]);
    expect(paneNumberOf('pane-antigo')).toBeNull();
    expect(resolvePaneRef('pane 9')).toBeNull();
    expect(paneNumberOf('pane-novo')).toBe(1);
  });

  it('nomeia os números válidos para a recusa', () => {
    hydratePaneNumbers([pane('pane-a', 1), pane('pane-b', 4)]);
    expect(validPaneNumbersLabel()).toBe('1, 4');
    expect(livePaneNumbers().map((entry) => entry.number)).toEqual([1, 4]);
  });
});
