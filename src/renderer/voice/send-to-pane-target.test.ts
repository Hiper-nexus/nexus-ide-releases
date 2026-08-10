import { describe, expect, it } from 'vitest';
import {
  isAgentTargetPane,
  isOrchestratorPane,
  resolveSendToPaneTarget,
  resolveSyncRepoViaPaneTarget,
} from './send-to-pane-target';

const shell = { id: 'p-shell', title: 'zsh', kind: 'shell' };
const browser = { id: 'p-web', title: 'docs', kind: 'browser' };
const agent = { id: 'p-agent', title: 'claude · worker', kind: 'cli-agent' };
const orch = { id: 'p-orq', title: 'orq · squad', kind: 'shell', orchRequestId: 'squad-1' };
const panes = [shell, browser, agent, orch];

describe('isOrchestratorPane / isAgentTargetPane', () => {
  it('orquestrador por orchRequestId squad- ou título orq', () => {
    expect(isOrchestratorPane(orch)).toBe(true);
    expect(isOrchestratorPane({ id: 'x', title: 'orq · missão', kind: 'shell' })).toBe(true);
    expect(isOrchestratorPane(shell)).toBe(false);
  });

  it('alvo de agente = cli-agent OU orquestrador; shell/browser NUNCA', () => {
    expect(isAgentTargetPane(agent)).toBe(true);
    expect(isAgentTargetPane(orch)).toBe(true);
    expect(isAgentTargetPane(shell)).toBe(false);
    expect(isAgentTargetPane(browser)).toBe(false);
  });
});

describe('resolveSendToPaneTarget por NÚMERO de pane', () => {
  // Números atribuídos como o operador os vê no header.
  const numbered = [
    { ...shell, paneNumber: 1 },
    { ...browser, paneNumber: 2 },
    { ...agent, paneNumber: 7 },
    { ...orch, paneNumber: 4 },
  ];

  it('"pane 7" entrega exatamente o pane 7', () => {
    for (const forma of ['7', '#7', 'pane 7', 'pane-7', 'no pane 7', 'pane sete']) {
      expect(resolveSendToPaneTarget(forma, numbered)).toEqual({
        kind: 'asking-pane',
        paneId: 'p-agent',
      });
    }
  });

  it('número desconhecido RECUSA nomeando os válidos — nunca o pane focado', () => {
    // Mandar trabalho para o terminal errado é pior que recusar. Note o
    // focusedPaneId passado: mesmo assim não há fallback para ele.
    expect(resolveSendToPaneTarget('pane 9', numbered, 'p-agent')).toEqual({
      kind: 'asking-pane-gone',
      requestedNumber: 9,
      validNumbers: [1, 2, 4, 7],
    });
  });

  it('número não cai para busca por título — "7" não vira "claude-7"', () => {
    // Sem a precedência do número, normalizePaneName("pane 7") = "7" casaria
    // por substring com o título "claude-7" e o trabalho iria para o pane errado.
    const armadilha = [
      { id: 'p-outro', title: 'claude-7', kind: 'cli-agent', paneNumber: 3 },
    ];
    expect(resolveSendToPaneTarget('pane 7', armadilha)).toEqual({
      kind: 'asking-pane-gone',
      requestedNumber: 7,
      validNumbers: [3],
    });
  });

  it('número de pane que não é de agente recusa como não-agente', () => {
    expect(resolveSendToPaneTarget('pane 1', numbered)).toEqual({
      kind: 'asking-pane-not-agent',
      title: 'zsh',
    });
  });

  it('número duplicado (duas janelas) é ambiguidade, não chute', () => {
    const colidindo = [
      { id: 'p-a', title: 'claude a', kind: 'cli-agent', paneNumber: 1 },
      { id: 'p-b', title: 'claude b', kind: 'cli-agent', paneNumber: 1 },
    ];
    expect(resolveSendToPaneTarget('pane 1', colidindo)).toMatchObject({
      kind: 'asking-pane-ambiguous',
      titles: ['claude a', 'claude b'],
    });
  });

  it('o paneId cru continua vencendo o número — identidade primeiro', () => {
    // Um id só de dígitos (~2% deles) não pode ser lido como número.
    const armadilha = [
      { id: '7', title: 'claude id-numerico', kind: 'cli-agent', paneNumber: 5 },
      { id: 'p-agent', title: 'claude · worker', kind: 'cli-agent', paneNumber: 7 },
    ];
    expect(resolveSendToPaneTarget('7', armadilha)).toEqual({
      kind: 'asking-pane',
      paneId: '7',
    });
  });

  it('sem número citado, o comportamento antigo não muda', () => {
    expect(resolveSendToPaneTarget('pane claude worker', numbered)).toEqual({
      kind: 'asking-pane',
      paneId: 'p-agent',
    });
  });
});

describe('resolveSendToPaneTarget (C3 follow-ups 2 + 4b)', () => {
  it('paneId de pane de agente vivo → asking-pane (relay direto, sem Confirmo?)', () => {
    expect(resolveSendToPaneTarget('p-agent', panes)).toEqual({
      kind: 'asking-pane',
      paneId: 'p-agent',
    });
  });

  it('paneId que sumiu → asking-pane-gone (avisa; NUNCA cai no gate de delegação)', () => {
    expect(resolveSendToPaneTarget('p-morto', panes)).toEqual({ kind: 'asking-pane-gone' });
  });

  it('paneId apontando pra shell → asking-pane-not-agent (injeção bloqueada)', () => {
    expect(resolveSendToPaneTarget('p-shell', panes)).toEqual({
      kind: 'asking-pane-not-agent',
      title: 'zsh',
    });
  });

  it('aceita nome falado normalizado somente quando o alvo é único', () => {
    expect(resolveSendToPaneTarget('pane claude worker', panes)).toEqual({
      kind: 'asking-pane',
      paneId: 'p-agent',
    });
  });

  it('não escolhe silenciosamente nomes ambíguos', () => {
    const duplicated = [...panes, { id: 'p-agent-2', title: 'claude · worker', kind: 'cli-agent' }];
    expect(resolveSendToPaneTarget('claude worker', duplicated)).toMatchObject({
      kind: 'asking-pane-ambiguous',
    });
  });

  it('sem paneId → delegação pro orquestrador (gate de voz), ou no-agent-pane', () => {
    expect(resolveSendToPaneTarget(undefined, panes)).toEqual({
      kind: 'delegation',
      orchestratorPaneId: 'p-orq',
    });
    expect(resolveSendToPaneTarget(undefined, [shell, browser])).toEqual({
      kind: 'no-agent-pane',
    });
  });

  it('usa o agente focado como delegação confirmável quando não há ORQ', () => {
    expect(resolveSendToPaneTarget(undefined, [shell, agent], 'p-agent')).toEqual({
      kind: 'delegation',
      orchestratorPaneId: 'p-agent',
    });
  });
});

describe('resolveSyncRepoViaPaneTarget', () => {
  it('prefers focused cli-agent over orchestrator', () => {
    expect(resolveSyncRepoViaPaneTarget(undefined, panes, 'p-agent')).toEqual({
      kind: 'asking-pane',
      paneId: 'p-agent',
    });
  });

  it('uses the sole cli-agent when focus is not an agent', () => {
    expect(resolveSyncRepoViaPaneTarget(undefined, panes, 'p-shell')).toEqual({
      kind: 'asking-pane',
      paneId: 'p-agent',
    });
  });

  it('asks which cli-agent when multiple exist and none is focused', () => {
    const second = { id: 'p-agent-2', title: 'codex · worker', kind: 'cli-agent' };
    expect(
      resolveSyncRepoViaPaneTarget(undefined, [...panes, second], 'p-shell'),
    ).toEqual({
      kind: 'asking-pane-ambiguous',
      titles: ['claude · worker', 'codex · worker'],
    });
  });

  it('falls back to orchestrator only when no cli-agent exists', () => {
    expect(resolveSyncRepoViaPaneTarget(undefined, [shell, orch], null)).toEqual({
      kind: 'delegation',
      orchestratorPaneId: 'p-orq',
    });
  });
});
