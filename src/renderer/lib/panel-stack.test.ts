import { afterEach, describe, expect, it } from 'vitest';
import {
  panelZFor,
  raisePanel,
  releasePanel,
  resetPanelStackForTest,
} from './panel-stack';

afterEach(() => {
  resetPanelStackForTest();
});

describe('panel-stack', () => {
  it('último painel aberto fica no topo da pilha', () => {
    // Um painel aberto pelo menu precisa nascer acima do painel já visível.
    raisePanel('ops-board');
    raisePanel('memory');
    expect(panelZFor('memory')!).toBeGreaterThan(panelZFor('ops-board')!);
  });

  it('clicar num painel de trás o traz para a frente', () => {
    raisePanel('ops-board');
    raisePanel('memory');
    raisePanel('ops-board');
    expect(panelZFor('ops-board')!).toBeGreaterThan(panelZFor('memory')!);
  });

  it('fechar remove da pilha e compacta os índices', () => {
    raisePanel('a');
    raisePanel('b');
    raisePanel('c');
    const topBefore = panelZFor('c')!;
    releasePanel('b');
    expect(panelZFor('b')).toBeUndefined();
    expect(panelZFor('c')).toBe(topBefore - 1);
    expect(panelZFor('a')!).toBeLessThan(panelZFor('c')!);
  });

  it('a faixa fica acima dos tiers estáticos (34) e abaixo do soft-overlay (45)', () => {
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) raisePanel(id);
    expect(panelZFor('a')!).toBeGreaterThan(34);
    expect(panelZFor('g')!).toBeLessThan(45);
  });

  it('raise de quem já está no topo é no-op', () => {
    raisePanel('a');
    raisePanel('b');
    const z = panelZFor('b')!;
    raisePanel('b');
    expect(panelZFor('b')).toBe(z);
    expect(panelZFor('a')).toBe(z - 1);
  });
});
