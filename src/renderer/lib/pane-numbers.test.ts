import { beforeEach, describe, expect, it } from 'vitest';
import {
  claimPaneNumber,
  paneNumberOf,
  releasePaneNumber,
  resolvePaneRef,
} from './pane-numbers';

/**
 * O registro do renderer é um singleton de módulo — de propósito: dois
 * numeradores dariam dois panes com o mesmo nome. Os testes usam ids próprios e
 * afirmam RELAÇÕES (distinto, não reusado), nunca valores absolutos, para não
 * depender de quantos panes outro teste criou.
 */
describe('registro de nomes de pane do renderer', () => {
  let a: string;
  let b: string;

  beforeEach(() => {
    a = `pane-a-${Math.random()}`;
    b = `pane-b-${Math.random()}`;
  });

  it('atribui nomes distintos e é idempotente', () => {
    const first = claimPaneNumber(a);
    expect(claimPaneNumber(a)).toBe(first);
    expect(claimPaneNumber(b)).not.toBe(first);
  });

  it('resolve a referência como o humano a dita', () => {
    const n = claimPaneNumber(a);
    expect(resolvePaneRef(`${n}`)).toBe(a);
    expect(resolvePaneRef(`#${n}`)).toBe(a);
    expect(resolvePaneRef(`pane ${n}`)).toBe(a);
    expect(resolvePaneRef(`pane-${n}`)).toBe(a);
  });

  it('o id interno cru continua válido — o número é adição, não troca', () => {
    claimPaneNumber(a);
    expect(resolvePaneRef(a)).toBe(a);
  });

  it('nome liberado nunca é reusado: "pane 5" não vira outro pane', () => {
    const fechado = claimPaneNumber(a);
    releasePaneNumber(a);
    expect(paneNumberOf(a)).toBeNull();
    expect(resolvePaneRef(`${fechado}`)).toBeNull();
    expect(claimPaneNumber(b)).toBeGreaterThan(fechado);
  });
});
