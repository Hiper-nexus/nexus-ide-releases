import { describe, expect, it } from 'vitest';
import {
  TAB_ORDER_CAP,
  applyTabOrder,
  dropIndex,
  dropSideFromPointer,
  mergeTabOrder,
  moveTabKey,
} from './tab-drag';

const tabs = (...keys: string[]) => keys.map((key) => ({ key }));
const keysOf = (items: readonly { key: string }[]) => items.map((item) => item.key);

describe('tab-drag', () => {
  it('aplica a ordem escolhida; aba fora dela fica no fim, na ordem natural', () => {
    expect(keysOf(applyTabOrder(tabs('a', 'b', 'c', 'd'), ['c', 'a']))).toEqual(['c', 'a', 'b', 'd']);
    expect(keysOf(applyTabOrder(tabs('a', 'b'), []))).toEqual(['a', 'b']);
    // Chave guardada de aba que não existe mais não ocupa lugar.
    expect(keysOf(applyTabOrder(tabs('a', 'b'), ['x', 'b']))).toEqual(['b', 'a']);
  });

  it('move para a posição final pedida, limitada às pontas', () => {
    expect(moveTabKey(['a', 'b', 'c'], 'a', 2)).toEqual(['b', 'c', 'a']);
    expect(moveTabKey(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b']);
    expect(moveTabKey(['a', 'b', 'c'], 'b', 99)).toEqual(['a', 'c', 'b']);
    expect(moveTabKey(['a', 'b', 'c'], 'b', -4)).toEqual(['b', 'a', 'c']);
    expect(moveTabKey(['a', 'b'], 'x', 0)).toEqual(['a', 'b']);
  });

  it('soltar antes/depois de uma aba vira a posição final certa', () => {
    const keys = ['a', 'b', 'c', 'd'];
    expect(dropIndex(keys, 'a', 'c', 'after')).toBe(2);
    expect(moveTabKey(keys, 'a', dropIndex(keys, 'a', 'c', 'after')!)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveTabKey(keys, 'd', dropIndex(keys, 'd', 'a', 'before')!)).toEqual(['d', 'a', 'b', 'c']);
    expect(dropIndex(keys, 'a', 'a', 'after')).toBeNull();
    expect(dropIndex(keys, 'a', 'zz', 'after')).toBeNull();
  });

  it('metade esquerda é antes, direita é depois', () => {
    expect(dropSideFromPointer({ left: 100, width: 120 }, 150)).toBe('before');
    expect(dropSideFromPointer({ left: 100, width: 120 }, 161)).toBe('after');
  });

  it('a ordem guardada mantém chaves de outros projetos, até o teto', () => {
    expect(mergeTabOrder(['x', 'a', 'y'], ['b', 'a'])).toEqual(['b', 'a', 'x', 'y']);
    const many = Array.from({ length: TAB_ORDER_CAP + 10 }, (_, index) => `k${index}`);
    expect(mergeTabOrder(many, ['novo'])).toHaveLength(TAB_ORDER_CAP);
    expect(mergeTabOrder(many, ['novo'])[0]).toBe('novo');
  });
});
