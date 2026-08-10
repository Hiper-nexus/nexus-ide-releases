import { describe, expect, it } from 'vitest';
import {
  createPaneNumberRegistry,
  describePaneNumbers,
  parsePaneNumberRef,
} from './pane-number';

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

  it('reusa o MENOR número livre depois de um fechamento', () => {
    // O número existe para caber na fala. Sem reuso, um dia de trabalho leva o
    // operador a "pane 312" — que é tão inditável quanto o id. Enquanto o pane
    // vive o número é só dele; depois de fechado ele volta para a fila.
    const r = createPaneNumberRegistry();
    r.assign('pane-a'); // 1
    r.assign('pane-b'); // 2
    r.assign('pane-c'); // 3
    r.release('pane-b'); // devolve o 2
    expect(r.assign('pane-d')).toBe(2);
    expect(r.numberOf('pane-b')).toBeNull();
    // E o pane que ficou não foi renumerado: número é identidade, não posição.
    expect(r.numberOf('pane-c')).toBe(3);
  });

  it('número de pane fechado não resolve para o pane seguinte', () => {
    // A recusa é o ponto: citar um número morto nunca pode entregar OUTRO pane.
    const r = createPaneNumberRegistry();
    r.assign('pane-a');
    r.release('pane-a');
    expect(r.resolve(1)).toBeNull();
    expect(r.resolveRef('pane 1')).toBeNull();
  });

  it('não duplica número numa mistura de criações e fechamentos', () => {
    const r = createPaneNumberRegistry();
    const vivos = new Set<string>();
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      r.assign(id);
      vivos.add(id);
    }
    r.release('b');
    vivos.delete('b');
    r.release('d');
    vivos.delete('d');
    for (const id of ['f', 'g', 'h']) {
      r.assign(id);
      vivos.add(id);
    }
    r.release('a');
    vivos.delete('a');
    r.assign('i');
    vivos.add('i');

    const entries = r.list();
    expect(entries).toHaveLength(vivos.size);
    // Invariante central: um número, um pane.
    expect(new Set(entries.map((e) => e.number)).size).toBe(entries.length);
    expect(new Set(entries.map((e) => e.paneId))).toEqual(vivos);
    // E cada número resolve de volta para o seu próprio pane.
    for (const entry of entries) {
      expect(r.resolve(entry.number)).toBe(entry.paneId);
    }
  });

  it('resolve número → id, que é o que torna "vai no pane 2" endereçável', () => {
    const r = createPaneNumberRegistry();
    r.assign('pane-alpha');
    r.assign('pane-beta');
    expect(r.resolve(2)).toBe('pane-beta');
    expect(r.resolve(99)).toBeNull();
  });

  it('aceita a forma falada "pane 2", "#2", "no pane 2", "pane dois" e o id cru', () => {
    const r = createPaneNumberRegistry();
    r.assign('pane-alpha');
    r.assign('pane-beta');
    for (const forma of [
      '2',
      '#2',
      'pane 2',
      'pane-2',
      'PANE  2',
      'no pane 2',
      'painel 2',
      'pane dois',
      'pane DOIS',
    ]) {
      expect(r.resolveRef(forma)).toBe('pane-beta');
    }
    expect(r.resolveRef('pane-alpha')).toBe('pane-alpha');
    expect(r.resolveRef('nao-existe')).toBeNull();
  });

  it('id cru só de dígitos vence a leitura numérica — identidade primeiro', () => {
    // ~2% dos ids saem só com dígitos (randomUUID().slice(0,8)). Lê-los como
    // número entregaria trabalho a OUTRO pane: o pior modo de falha possível.
    const r = createPaneNumberRegistry();
    r.assign('pane-12345678'); // vira o número 1
    r.assign('pane-outro'); // vira o número 2
    expect(r.resolveRef('pane-12345678')).toBe('pane-12345678');
    // E o número 1 continua endereçando o mesmo pane pela via numérica.
    expect(r.resolveRef('pane 1')).toBe('pane-12345678');
  });

  it('escopos separados não colidem — o mesmo número nunca aponta para dois panes', () => {
    const a = createPaneNumberRegistry();
    const b = createPaneNumberRegistry();
    a.assign('pane-workspace-a');
    b.assign('pane-workspace-b');
    expect(a.resolve(1)).toBe('pane-workspace-a');
    expect(b.resolve(1)).toBe('pane-workspace-b');
  });

  it('lista os panes vivos em ordem de número', () => {
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

  describe('reset — o número sobrevive ao restart e não vaza entre workspaces', () => {
    it('devolve a CADA pane o número que estava persistido', () => {
      const r = createPaneNumberRegistry();
      // Layout gravado no restart anterior: os números não são 1..N em ordem.
      const restored = r.reset([
        { id: 'pane-a', paneNumber: 3 },
        { id: 'pane-b', paneNumber: 1 },
        { id: 'pane-c', paneNumber: 7 },
      ]);
      expect(restored.get('pane-a')).toBe(3);
      expect(restored.get('pane-b')).toBe(1);
      expect(restored.get('pane-c')).toBe(7);
      // E continuam endereçáveis pelos MESMOS números que o operador decorou.
      expect(r.resolveRef('pane 7')).toBe('pane-c');
      expect(r.numberOf('pane-a')).toBe(3);
    });

    it('pane sem número (layout de versão anterior) recebe o menor livre', () => {
      const r = createPaneNumberRegistry();
      const restored = r.reset([
        { id: 'pane-a', paneNumber: 2 },
        { id: 'pane-legado' }, // gravado antes da numeração existir
        { id: 'pane-outro-legado' },
      ]);
      expect(restored.get('pane-a')).toBe(2);
      expect(restored.get('pane-legado')).toBe(1);
      expect(restored.get('pane-outro-legado')).toBe(3);
      expect(r.list()).toHaveLength(3);
    });

    it('workspace novo recomeça em 1 — os números do anterior não sobram', () => {
      const r = createPaneNumberRegistry();
      r.reset([{ id: 'pane-antigo', paneNumber: 9 }]);
      const restored = r.reset([{ id: 'pane-novo' }]);
      expect(restored.get('pane-novo')).toBe(1);
      expect(r.numberOf('pane-antigo')).toBeNull();
      expect(r.resolveRef('pane 9')).toBeNull();
    });

    it('número persistido duplicado não gera dois panes com o mesmo número', () => {
      // Defesa contra layout corrompido: o invariante é mais forte que o disco.
      const r = createPaneNumberRegistry();
      const restored = r.reset([
        { id: 'pane-a', paneNumber: 2 },
        { id: 'pane-b', paneNumber: 2 },
      ]);
      expect(restored.get('pane-a')).toBe(2);
      expect(restored.get('pane-b')).toBe(1);
      expect(new Set(restored.values()).size).toBe(2);
    });

    it('ciclo completo hidrata → cria → fecha → hidrata mantém os números', () => {
      const r = createPaneNumberRegistry();
      r.reset([{ id: 'pane-a' }, { id: 'pane-b' }]);
      r.assign('pane-c');
      r.release('pane-b');
      // O que seria persistido agora:
      const persisted = r.list().map((e) => ({ id: e.paneId, paneNumber: e.number }));
      expect(persisted).toEqual([
        { id: 'pane-a', paneNumber: 1 },
        { id: 'pane-c', paneNumber: 3 },
      ]);
      // Restart: outro registro, mesmo disco.
      const afterRestart = createPaneNumberRegistry();
      afterRestart.reset(persisted);
      // Cada pane volta com o SEU número — o operador continua dizendo "pane 3"
      // para o mesmo pane de ontem. Renumerar para 1..N no restart quebraria
      // exatamente a memória que o número existe para criar.
      expect(afterRestart.numberOf('pane-a')).toBe(1);
      expect(afterRestart.numberOf('pane-c')).toBe(3);
      expect(afterRestart.resolveRef('pane 3')).toBe('pane-c');
      // O 2, vago desde o fechamento, é o próximo a ser oferecido.
      expect(afterRestart.assign('pane-novo')).toBe(2);
    });
  });
});

describe('parsePaneNumberRef', () => {
  it('lê dígito, palavra e as formas com preposição', () => {
    expect(parsePaneNumberRef('7')).toBe(7);
    expect(parsePaneNumberRef('#7')).toBe(7);
    expect(parsePaneNumberRef('pane 7')).toBe(7);
    expect(parsePaneNumberRef('pane-7')).toBe(7);
    expect(parsePaneNumberRef('no pane 7')).toBe(7);
    expect(parsePaneNumberRef('pane sete')).toBe(7);
    expect(parsePaneNumberRef('sete')).toBe(7);
    expect(parsePaneNumberRef('pane três')).toBe(3);
    expect(parsePaneNumberRef('PANE  Dez')).toBe(10);
  });

  it('não lê como número o que não é endereço', () => {
    expect(parsePaneNumberRef('claude worker')).toBeNull();
    expect(parsePaneNumberRef('terminal')).toBeNull();
    expect(parsePaneNumberRef('')).toBeNull();
    expect(parsePaneNumberRef('0')).toBeNull();
    // Título com número dentro NÃO é uma referência numérica.
    expect(parsePaneNumberRef('claude-7')).toBeNull();
  });
});

describe('describePaneNumbers', () => {
  it('nomeia os números válidos para a recusa', () => {
    expect(describePaneNumbers([])).toBe('nenhum pane aberto');
    expect(
      describePaneNumbers([
        { number: 1, paneId: 'a' },
        { number: 4, paneId: 'b' },
      ]),
    ).toBe('1, 4');
  });
});
