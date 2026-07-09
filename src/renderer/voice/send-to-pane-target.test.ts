import { describe, expect, it } from 'vitest';
import {
  isAgentTargetPane,
  isOrchestratorPane,
  resolveSendToPaneTarget,
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

  it('sem paneId → delegação pro orquestrador (gate de voz), ou no-agent-pane', () => {
    expect(resolveSendToPaneTarget(undefined, panes)).toEqual({
      kind: 'delegation',
      orchestratorPaneId: 'p-orq',
    });
    expect(resolveSendToPaneTarget(undefined, [shell, browser])).toEqual({
      kind: 'no-agent-pane',
    });
  });
});
