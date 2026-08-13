import { describe, expect, it } from 'vitest';
import {
  applyAgentWaitingUpdate,
  clearAgentWaitingPane,
  createAgentWaitingSnapshot,
  hookStateNeedsHumanInput,
} from './agent-waiting';

function update(
  overrides: Partial<Parameters<typeof applyAgentWaitingUpdate>[1]> = {},
): Parameters<typeof applyAgentWaitingUpdate>[1] {
  return {
    source: 'semantic',
    sessionId: 's1',
    paneId: 'pane-1',
    agentLabel: 'Claude',
    state: 'awaiting-input',
    ...overrides,
  };
}

describe('hookStateNeedsHumanInput', () => {
  it('reconhece os três estados que pedem o operador', () => {
    expect(hookStateNeedsHumanInput('waiting')).toBe(true);
    expect(hookStateNeedsHumanInput('blocked')).toBe(true);
    expect(hookStateNeedsHumanInput('awaiting-input')).toBe(true);
    expect(hookStateNeedsHumanInput('working')).toBe(false);
    expect(hookStateNeedsHumanInput('done')).toBe(false);
    expect(hookStateNeedsHumanInput('idle')).toBe(false);
    expect(hookStateNeedsHumanInput('completed')).toBe(false);
  });
});

describe('applyAgentWaitingUpdate', () => {
  it('entra no primeiro pedido e não reentra no reassert', () => {
    const first = applyAgentWaitingUpdate(createAgentWaitingSnapshot(), update());
    expect(first.entered).toBe(true);
    expect(first.left).toBe(false);
    expect(first.entry).toMatchObject({ paneId: 'pane-1', agentLabel: 'Claude' });

    const again = applyAgentWaitingUpdate(first.next, update());
    expect(again.entered).toBe(false);
    expect(again.next.entries.size).toBe(1);
  });

  it('só some quando as duas fontes largam o pane', () => {
    let snap = createAgentWaitingSnapshot();
    snap = applyAgentWaitingUpdate(snap, update({ source: 'semantic' })).next;
    snap = applyAgentWaitingUpdate(
      snap,
      update({ source: 'orca', state: 'waiting' }),
    ).next;
    expect(snap.entries.size).toBe(1);

    const semanticDone = applyAgentWaitingUpdate(
      snap,
      update({ source: 'semantic', state: 'working' }),
    );
    expect(semanticDone.left).toBe(false);
    expect(semanticDone.next.entries.has('pane-1')).toBe(true);

    const orcaDone = applyAgentWaitingUpdate(
      semanticDone.next,
      update({ source: 'orca', state: 'working' }),
    );
    expect(orcaDone.left).toBe(true);
    expect(orcaDone.next.entries.size).toBe(0);
  });

  it('a fonte orca sozinha já basta para o inbox', () => {
    const result = applyAgentWaitingUpdate(
      createAgentWaitingSnapshot(),
      update({ source: 'orca', state: 'blocked' }),
    );
    expect(result.entered).toBe(true);
    expect(result.next.entries.get('pane-1')?.sessionId).toBe('s1');
  });

  it('clearPane remove as duas fontes de uma vez (PTY saiu)', () => {
    let snap = createAgentWaitingSnapshot();
    snap = applyAgentWaitingUpdate(snap, update({ source: 'semantic' })).next;
    snap = applyAgentWaitingUpdate(
      snap,
      update({ source: 'orca', state: 'waiting' }),
    ).next;
    const cleared = clearAgentWaitingPane(snap, 'pane-1');
    expect(cleared.left).toBe(true);
    expect(cleared.next.entries.size).toBe(0);
    expect(clearAgentWaitingPane(cleared.next, 'pane-1').left).toBe(false);
  });
});
