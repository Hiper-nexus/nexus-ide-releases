/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';
import { TAB_ORDER_STORAGE_KEY, readStoredTabOrder, useTabOrderStore } from './tab-order-store';

afterEach(() => {
  window.localStorage.clear();
  useTabOrderStore.setState({ order: [] });
});

describe('tab-order-store', () => {
  it('grava a ordem no localStorage e lê de volta', () => {
    useTabOrderStore.getState().setOrder(['space:b', 'mission:a']);
    expect(useTabOrderStore.getState().order).toEqual(['space:b', 'mission:a']);
    expect(window.localStorage.getItem(TAB_ORDER_STORAGE_KEY)).toBe('["space:b","mission:a"]');
    expect(readStoredTabOrder()).toEqual(['space:b', 'mission:a']);
  });

  it('valor adulterado vira ordem natural, sem lançar', () => {
    window.localStorage.setItem(TAB_ORDER_STORAGE_KEY, '{nao é json');
    expect(readStoredTabOrder()).toEqual([]);
    window.localStorage.setItem(TAB_ORDER_STORAGE_KEY, JSON.stringify({ a: 1 }));
    expect(readStoredTabOrder()).toEqual([]);
    window.localStorage.setItem(TAB_ORDER_STORAGE_KEY, JSON.stringify(['a', 3, '', 'a', 'b']));
    expect(readStoredTabOrder()).toEqual(['a', 'b']);
  });
});
