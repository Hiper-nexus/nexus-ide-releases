import { describe, expect, it } from 'vitest';
import { createPaneNumberRegistry } from './pane-number';

/**
 * "pane-mshi87ry-4" é impronunciável: não dá para ditar, decorar nem informar.
 * O número é o PUNHO HUMANO — o id interno segue sendo a chave durável.
 */
describe('createPaneNumberRegistry', () => {
  it('numera na ordem de criação, começando em 1', () => {
    const r = createPaneNumberRegistry();
    expect(r.assign('pane-mshi87ry-4')).toBe(1);
    expect(r.assign('pane-mshi9abc-7')).toBe(2);
    expect(r.assign('pane-zzz-9')).toBe(3);
  });

  it('o mesmo pane mantém seu número (idempotente)', () => {
    const r = createPaneNumberRegistry();
    expect(r.assign('pane-a')).toBe(1);
    expect(r.assign('pane-a')).toBe(1);
    expect(r.assign('pane-b')).toBe(2);
  });

  it('NÃO reusa número de pane fechado — "pane 5" nunca vira outro pane', () => {
    // O pior modo de falha: você diz "pane 5" e acerta outro. Monotônico e
    // sem reuso é o que impede isso.
    const r = createPaneNumberRegistry();
    r.assign('pane-a');
    r.assign('pane-b');
    r.release('pane-a');
    expect(r.assign('pane-c')).toBe(3);
    expect(r.numberOf('pane-a')).toBeNull();
  });

  it('resolve número → id, que é o que torna "vai no pane 2" endereçável', () => {
    const r = createPaneNumberRegistry();
    r.assign('pane-alpha');
    r.assign('pane-beta');
    expect(r.resolve(2)).toBe('pane-beta');
    expect(r.resolve(99)).toBeNull();
  });

  it('aceita a forma falada "pane 2", "#2" e o id cru', () => {
    const r = createPaneNumberRegistry();
    r.assign('pane-alpha');
    r.assign('pane-beta');
    for (const forma of ['2', '#2', 'pane 2', 'pane-2', 'PANE  2']) {
      expect(r.resolveRef(forma)).toBe('pane-beta');
    }
    expect(r.resolveRef('pane-alpha')).toBe('pane-alpha');
    expect(r.resolveRef('nao-existe')).toBeNull();
  });

  it('escopos separados não colidem — o mesmo número nunca aponta para dois panes', () => {
    const a = createPaneNumberRegistry();
    const b = createPaneNumberRegistry();
    a.assign('pane-workspace-a');
    b.assign('pane-workspace-b');
    expect(a.resolve(1)).toBe('pane-workspace-a');
    expect(b.resolve(1)).toBe('pane-workspace-b');
  });

  it('lista os panes vivos em ordem de número, para a UI e o ⌘1-9', () => {
    const r = createPaneNumberRegistry();
    r.assign('pane-a');
    r.assign('pane-b');
    r.assign('pane-c');
    r.release('pane-b');
    expect(r.list()).toEqual([
      { number: 1, paneId: 'pane-a' },
      { number: 3, paneId: 'pane-c' },
    ]);
  });
});
