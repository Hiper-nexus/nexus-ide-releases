import { describe, expect, it } from 'vitest';
import type { PaneSessionState } from '../../shared/types';
import {
  findPaneOwningAgentSession,
  findReusableAgentPane,
  paneRevealToastCopy,
  planPaneReveal,
  type PaneRevealSubject,
} from './reveal-pane-terminal';

const maestro: PaneRevealSubject = {
  id: 'pane-orch',
  kind: 'cli-agent',
  role: 'orchestrator',
  adapterId: 'claude',
  title: 'Maestro',
};
const worker: PaneRevealSubject = {
  id: 'pane-worker',
  kind: 'cli-agent',
  role: 'worker',
  adapterId: 'codex',
  title: 'Worker',
};
const helperIdle: PaneRevealSubject = {
  id: 'pane-helper-idle',
  kind: 'cli-agent',
  adapterId: 'claude',
  title: 'Helper ocioso',
};
const helperBusy: PaneRevealSubject = {
  id: 'pane-helper-busy',
  kind: 'cli-agent',
  adapterId: 'claude',
  accountId: 'acct-a',
  title: 'Helper ocupado',
};
const otherAccount: PaneRevealSubject = {
  id: 'pane-other-acct',
  kind: 'cli-agent',
  adapterId: 'claude',
  accountId: 'acct-b',
  title: 'Outra conta',
};
const shell: PaneRevealSubject = { id: 'pane-shell', kind: 'shell', title: 'shell' };

const sessions: Record<string, string | null> = {
  'pane-orch': 'sess-orch',
  'pane-worker': 'sess-worker',
  'pane-helper-idle': 'sess-idle',
  'pane-helper-busy': 'sess-busy',
  'pane-other-acct': 'sess-other',
  'pane-shell': null,
};
const sessionIdOf = (paneId: string) => sessions[paneId] ?? null;
const allLive = () => true;

describe('findPaneOwningAgentSession (F-572)', () => {
  it('acha o pane que já possui a sessão', () => {
    expect(
      findPaneOwningAgentSession(
        [maestro, worker, shell],
        sessionIdOf,
        'sess-worker',
        allLive,
      ),
    ).toEqual(worker);
  });

  it('sessão sem pane vivo devolve null (aí sim pode nascer outro)', () => {
    expect(
      findPaneOwningAgentSession(
        [maestro, worker],
        sessionIdOf,
        'sess-desconhecida',
        allLive,
      ),
    ).toBeNull();
  });

  it('pane com sessão morta não é dono', () => {
    expect(
      findPaneOwningAgentSession(
        [worker],
        sessionIdOf,
        'sess-worker',
        () => false,
      ),
    ).toBeNull();
  });

  it('duas panes com a mesma sessão é ambiguidade — fail-closed', () => {
    const ghost: PaneRevealSubject = { ...worker, id: 'pane-ghost' };
    const map: Record<string, string | null> = {
      ...sessions,
      'pane-ghost': 'sess-worker',
    };
    expect(
      findPaneOwningAgentSession(
        [worker, ghost],
        (id) => map[id] ?? null,
        'sess-worker',
        allLive,
      ),
    ).toBeNull();
  });
});

describe('planPaneReveal', () => {
  it('revela o dono da sessão quando o foco está noutro pane comum', () => {
    const plan = planPaneReveal({
      panes: [maestro, worker, shell],
      target: { kind: 'agentSession', agentSessionId: 'sess-worker' },
      sessionIdOf,
      focusedPaneId: 'pane-shell',
      isPaneSessionLive: allLive,
    });
    expect(plan).toEqual({ action: 'reveal', paneId: 'pane-worker' });
  });

  it('aceita alvo por pane id direto', () => {
    const plan = planPaneReveal({
      panes: [maestro, worker],
      target: { kind: 'pane', paneId: 'pane-worker' },
      sessionIdOf,
      focusedPaneId: null,
      isPaneSessionLive: allLive,
    });
    expect(plan).toEqual({ action: 'reveal', paneId: 'pane-worker' });
  });

  it('não rouba o foco de um orquestrador vivo (mão do operador)', () => {
    const plan = planPaneReveal({
      panes: [maestro, worker],
      target: { kind: 'agentSession', agentSessionId: 'sess-worker' },
      sessionIdOf,
      focusedPaneId: 'pane-orch',
      isPaneSessionLive: allLive,
    });
    expect(plan).toEqual({
      action: 'highlight',
      paneId: 'pane-worker',
      keptFocusPaneId: 'pane-orch',
    });
  });

  it('orquestrador morto não protege o foco — reveal normal', () => {
    const plan = planPaneReveal({
      panes: [maestro, worker],
      target: { kind: 'agentSession', agentSessionId: 'sess-worker' },
      sessionIdOf,
      focusedPaneId: 'pane-orch',
      isPaneSessionLive: (id) => id !== 'pane-orch',
    });
    expect(plan).toEqual({ action: 'reveal', paneId: 'pane-worker' });
  });

  it('o dono da sessão É o orquestrador focado — reveal confirma, sem highlight', () => {
    const plan = planPaneReveal({
      panes: [maestro, worker],
      target: { kind: 'agentSession', agentSessionId: 'sess-orch' },
      sessionIdOf,
      focusedPaneId: 'pane-orch',
      isPaneSessionLive: allLive,
    });
    expect(plan).toEqual({ action: 'reveal', paneId: 'pane-orch' });
  });

  it('sessão sem pane → missing (chamador pode spawnar)', () => {
    const plan = planPaneReveal({
      panes: [maestro],
      target: { kind: 'agentSession', agentSessionId: 'sess-nova' },
      sessionIdOf,
      focusedPaneId: null,
      isPaneSessionLive: allLive,
    });
    expect(plan).toEqual({ action: 'missing' });
  });
});

describe('findReusableAgentPane (+ Pane / open_agent)', () => {
  const states = (entries: Record<string, PaneSessionState>) =>
    new Map(Object.entries(entries));

  it('reusa o helper ocioso da mesma CLI', () => {
    const found = findReusableAgentPane(
      [helperBusy, helperIdle, shell],
      sessionIdOf,
      allLive,
      {
        adapterId: 'claude',
        accountId: undefined,
        paneStates: states({
          'pane-helper-busy': 'busy',
          'pane-helper-idle': 'idle',
        }),
      },
    );
    expect(found?.id).toBe('pane-helper-idle');
  });

  it('conta distinta não reusa (multi-conta é trabalho diferente)', () => {
    const found = findReusableAgentPane(
      [helperBusy, otherAccount],
      sessionIdOf,
      allLive,
      {
        adapterId: 'claude',
        accountId: 'acct-b',
        paneStates: states({
          'pane-helper-busy': 'idle',
          'pane-other-acct': 'idle',
        }),
      },
    );
    expect(found?.id).toBe('pane-other-acct');
  });

  it('sem pane vivo com sessão → null (pode spawnar)', () => {
    expect(
      findReusableAgentPane([shell], sessionIdOf, allLive, {
        adapterId: 'claude',
        paneStates: states({}),
      }),
    ).toBeNull();
  });
});

describe('paneRevealToastCopy', () => {
  it('reveal explica o custo de um pane novo (F-572)', () => {
    const copy = paneRevealToastCopy({ action: 'reveal', paneId: 'p' });
    expect(copy.title).toBe('Terminal já aberto');
    expect(copy.detail).toMatch(/F-572/);
  });

  it('highlight diz que o foco fica no orquestrador', () => {
    const copy = paneRevealToastCopy({
      action: 'highlight',
      paneId: 'p',
      keptFocusPaneId: 'orch',
    });
    expect(copy.detail).toMatch(/orquestrador/);
    expect(copy.detail).toMatch(/mão do operador/);
  });
});
