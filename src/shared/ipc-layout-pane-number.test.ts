import { describe, expect, it } from 'vitest';
import { workspaceLayoutSchema } from './ipc';
import type { WorkspaceLayout } from './types';

/**
 * O NÚMERO do pane atravessa a fronteira de persistência.
 *
 * `paneModelSchema` é um `z.object`, que descarta chave desconhecida EM
 * SILÊNCIO. O layout é gravado com `JSON.stringify` (fidelidade total) mas lido
 * de volta por `workspaceLayoutSchema.parse`, então é a leitura que decide o
 * que sobrevive. Sem `paneNumber` declarado no schema, todo restart devolveria
 * panes sem número e a numeração recomeçaria do zero — o operador perderia
 * exatamente a memória ("o pane 7 é o do build") que o número existe para
 * criar, e nenhum teste de store pegaria isso, porque o store hidrata a partir
 * de um objeto em memória que nunca passou pelo schema.
 */
describe('workspaceLayoutSchema preserva o número do pane', () => {
  const layout: WorkspaceLayout = {
    root: {
      kind: 'split',
      id: 'split-1',
      direction: 'row',
      children: [
        {
          kind: 'leaf',
          id: 'leaf-1',
          pane: { id: 'pane-a', kind: 'shell', title: 'a', paneNumber: 3 },
        },
        {
          kind: 'leaf',
          id: 'leaf-2',
          pane: { id: 'pane-b', kind: 'shell', title: 'b', paneNumber: 1 },
        },
      ],
    },
    focusedPaneId: 'pane-a',
  };

  it('sobrevive ao ciclo real gravar → ler (JSON + parse)', () => {
    const roundTripped = workspaceLayoutSchema.parse(
      JSON.parse(JSON.stringify(layout)) as unknown,
    );
    const root = roundTripped.root;
    if (root.kind !== 'split') throw new Error('esperava split');
    const [left, right] = root.children;
    if (left.kind !== 'leaf' || right.kind !== 'leaf') {
      throw new Error('esperava duas folhas');
    }
    expect(left.pane.paneNumber).toBe(3);
    expect(right.pane.paneNumber).toBe(1);
    // E o id continua sendo a identidade — o número é adição.
    expect(left.pane.id).toBe('pane-a');
    expect(right.pane.id).toBe('pane-b');
  });

  it('layout de versão anterior (sem número) continua carregando', () => {
    const legacy = {
      root: {
        kind: 'leaf',
        id: 'leaf-1',
        pane: { id: 'pane-legado', kind: 'shell', title: 'legado' },
      },
      focusedPaneId: 'pane-legado',
    };
    const parsed = workspaceLayoutSchema.parse(legacy as unknown);
    if (parsed.root.kind !== 'leaf') throw new Error('esperava folha');
    expect(parsed.root.pane.id).toBe('pane-legado');
    expect(parsed.root.pane.paneNumber).toBeUndefined();
  });

  it('recusa um número inválido em vez de persistir lixo', () => {
    const corrupt = {
      root: {
        kind: 'leaf',
        id: 'leaf-1',
        pane: { id: 'pane-a', kind: 'shell', title: 'a', paneNumber: 0 },
      },
      focusedPaneId: 'pane-a',
    };
    expect(() => workspaceLayoutSchema.parse(corrupt as unknown)).toThrow();
  });
});

/**
 * Mesma fronteira, mesmo risco (F-560): o ESPAÇO do pane é o que separa "os
 * painéis que abri agora" da missão que já estava rodando. Se ele não
 * atravessar o parse, o primeiro restart remistura tudo num mosaico só — o
 * bug de volta, sem nenhum teste de store notando.
 */
describe('workspaceLayoutSchema preserva o espaço do pane', () => {
  it('spaceId e spaceTitle sobrevivem a gravar → ler', () => {
    const layout: WorkspaceLayout = {
      root: {
        kind: 'leaf',
        id: 'leaf-1',
        pane: {
          id: 'pane-a',
          kind: 'cli-agent',
          title: 'Codex',
          adapterId: 'codex',
          spaceId: 'space-7',
          isolateSpace: true,
          spaceTitle: 'Meus terminais 2',
        },
      },
      focusedPaneId: 'pane-a',
    };
    const parsed = workspaceLayoutSchema.parse(
      JSON.parse(JSON.stringify(layout)) as unknown,
    );
    if (parsed.root.kind !== 'leaf') throw new Error('esperava folha');
    expect(parsed.root.pane.spaceId).toBe('space-7');
    expect(parsed.root.pane.isolateSpace).toBe(true);
    expect(parsed.root.pane.spaceTitle).toBe('Meus terminais 2');
  });

  it('layout anterior ao conceito de espaço continua carregando', () => {
    const legacy = {
      root: {
        kind: 'leaf',
        id: 'leaf-1',
        pane: { id: 'pane-legado', kind: 'shell', title: 'legado' },
      },
      focusedPaneId: 'pane-legado',
    };
    const parsed = workspaceLayoutSchema.parse(legacy as unknown);
    if (parsed.root.kind !== 'leaf') throw new Error('esperava folha');
    expect(parsed.root.pane.spaceId).toBeUndefined();
    expect(parsed.root.pane.spaceTitle).toBeUndefined();
  });

  it('missão e espaço coexistem no mesmo pane sem se apagarem', () => {
    const layout = {
      root: {
        kind: 'leaf',
        id: 'leaf-1',
        pane: {
          id: 'pane-a',
          kind: 'cli-agent',
          title: 'Codex',
          missionId: 'mission-1',
          spaceId: 'space-7',
          spaceTitle: 'Meus terminais',
        },
      },
      focusedPaneId: 'pane-a',
    };
    const parsed = workspaceLayoutSchema.parse(layout as unknown);
    if (parsed.root.kind !== 'leaf') throw new Error('esperava folha');
    expect(parsed.root.pane.missionId).toBe('mission-1');
    expect(parsed.root.pane.spaceId).toBe('space-7');
  });
});

/** Sem `missionHost` no parse, a missão hospedada voltaria à aba própria no restart. */
describe('workspaceLayoutSchema preserva o anfitrião de missão', () => {
  it('missionHost sobrevive a gravar → ler', () => {
    const layout: WorkspaceLayout = {
      root: {
        kind: 'leaf',
        id: 'leaf-1',
        pane: {
          id: 'pane-a',
          kind: 'cli-agent',
          title: 'claude',
          role: 'orchestrator',
          missionId: 'mission-1',
          missionHost: true,
        },
      },
      focusedPaneId: 'pane-a',
    };
    const parsed = workspaceLayoutSchema.parse(
      JSON.parse(JSON.stringify(layout)) as unknown,
    );
    if (parsed.root.kind !== 'leaf') throw new Error('esperava folha');
    expect(parsed.root.pane.missionHost).toBe(true);
  });
});
