import { afterEach, describe, expect, it, vi } from 'vitest';

// PRV-02/MOB-07: o handler `agentSession.respondToApproval` do host remoto,
// chamado pelo MESMO dispatch autenticado que a bridge WS e o relay usam.
const h = vi.hoisted(() => ({
  orchWriteSession: vi.fn(() => true),
  confirm: vi.fn(async () => false),
}));

// Dois panes: `pane-a` (projeto A) e `pane-b` (projeto B). O escopo só
// escreve/lê pane do próprio projeto.
vi.mock('../orch/pane-registry', () => {
  const panes: Record<string, { paneId: string; sessionId: string; projectId: string; checkoutId: string }> = {
    'sess-a': { paneId: 'pane-a', sessionId: 'sess-a', projectId: 'project-a', checkoutId: 'checkout-a' },
    'sess-b': { paneId: 'pane-b', sessionId: 'sess-b', projectId: 'project-b', checkoutId: 'checkout-b' },
  };
  return {
    getPaneAuthzInfo: (ref: string) =>
      panes[ref] ?? Object.values(panes).find((pane) => pane.paneId === ref) ?? null,
    listVisiblePaneSnapshots: () => [],
    readSessionOutput: () => '',
    requestPaneClose: () => true,
  };
});
vi.mock('../orch/pane-authz', () => ({
  authorizePaneAccess: (
    caller: { scope: { projectId: string } },
    pane: { projectId: string },
  ) => (caller.scope.projectId === pane.projectId ? { allow: true } : { allow: false, reason: 'scope' }),
}));
vi.mock('../orch/project-domain-store-registry', () => ({
  getProjectDomainStores: () => ({ missions: { list: () => [] } }),
}));
vi.mock('../pty/pty-manager', () => ({
  orchWriteSession: h.orchWriteSession,
  orchResizeSession: () => true,
  tapSessionData: () => () => undefined,
}));
vi.mock('./remote-desktop-confirmation', () => ({
  requestRemoteDesktopConfirmation: h.confirm,
}));

import { approvalBroker, approvalFingerprint, hasApprovalResponder } from '../agent-hooks/approval-broker';
import { handleAuthedMessage } from './remote-bridge';

const scopeA = {
  version: 1 as const,
  installationId: 'install',
  projectId: 'project-a',
  checkoutId: 'checkout-a',
  rootRealPath: '/workspace/a',
  identitySource: 'manifest' as const,
};

function open(sessionId: string, command = 'ls', highImpact = false) {
  return approvalBroker.open({
    sessionId,
    provider: 'claude',
    tool: 'Bash',
    summary: command,
    options: [{ optionId: 'accept' }, { optionId: 'acceptForSession', degradesTo: 'accept' }, { optionId: 'decline' }],
    waitMs: 60_000,
    fingerprint: approvalFingerprint('Bash', { command }),
    highImpact,
  })!;
}

function respond(requestId: string, optionId: string, expectedRevision = 1) {
  return handleAuthedMessage(
    { type: 'agentSession.respondToApproval', id: 'rpc-1', itemId: requestId, expectedRevision, optionId, token: 'ignored' },
    scopeA,
  );
}

afterEach(() => {
  for (const request of approvalBroker.list()) approvalBroker.cancelForSession(request.sessionId);
  h.orchWriteSession.mockClear();
  h.confirm.mockReset();
  h.confirm.mockResolvedValue(false);
});

describe('remote agentSession.respondToApproval', () => {
  it('a device without write grant on the pane is rejected — no keystroke, request stays open', async () => {
    const other = open('sess-b');
    await expect(respond(other.request.requestId, 'accept')).resolves.toEqual({
      status: 'rejected',
      reason: 'approval-grant-required',
    });
    expect(h.orchWriteSession).not.toHaveBeenCalled();
    expect(approvalBroker.list().map((r) => r.requestId)).toEqual([other.request.requestId]);
  });

  it('an unknown requestId gets the same refusal (no existence oracle)', async () => {
    await expect(respond('nope', 'accept')).resolves.toEqual({ status: 'rejected', reason: 'approval-grant-required' });
  });

  it('with grant the decision reaches the waiting hook, never the PTY', async () => {
    const mine = open('sess-a');
    const result = await respond(mine.request.requestId, 'decline');
    expect(result).toMatchObject({ status: 'accepted', receipt: { optionId: 'decline', source: 'mobile', duplicate: false } });
    await expect(mine.decision).resolves.toBe('decline');
    expect(h.orchWriteSession).not.toHaveBeenCalled();
    expect(h.confirm).not.toHaveBeenCalled();
    // Repetição (ack perdido no celular) devolve o recibo, sem decidir de novo.
    await expect(respond(mine.request.requestId, 'decline')).resolves.toMatchObject({
      status: 'accepted',
      receipt: { duplicate: true },
    });
  });

  it('approving a destructive command needs the desktop dialog; denial keeps it pending', async () => {
    const rm = open('sess-a', 'rm -rf build', true);
    await expect(respond(rm.request.requestId, 'accept')).resolves.toEqual({
      status: 'rejected',
      reason: 'desktop-confirmation-denied',
    });
    expect(h.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'remote_approval', args: expect.objectContaining({ command: 'rm -rf build' }) }),
    );
    expect(approvalBroker.list()).toHaveLength(1);
    h.confirm.mockResolvedValueOnce(true);
    await expect(respond(rm.request.requestId, 'accept')).resolves.toMatchObject({ status: 'accepted' });
    await expect(rm.decision).resolves.toBe('accept');
  });

  it('declining a destructive command needs no desktop dialog', async () => {
    const rm = open('sess-a', 'rm -rf build', true);
    await expect(respond(rm.request.requestId, 'decline')).resolves.toMatchObject({ status: 'accepted' });
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it('invalid params are rejected before touching the broker', async () => {
    const mine = open('sess-a');
    await expect(respond(mine.request.requestId, 'acceptAlways')).resolves.toEqual({
      status: 'rejected',
      reason: 'invalid-params',
    });
    await expect(respond(mine.request.requestId, 'accept', 0)).resolves.toEqual({
      status: 'rejected',
      reason: 'invalid-params',
    });
    expect(approvalBroker.list()).toHaveLength(1);
  });

  it('ops.snapshot lists only approvals of panes the device may read, by paneId', async () => {
    const mine = open('sess-a', 'touch a');
    open('sess-b', 'touch b');
    const snapshot = (await handleAuthedMessage({ type: 'ops.snapshot' }, scopeA)) as {
      approvals: Array<Record<string, unknown>>;
    };
    expect(snapshot.approvals).toEqual([
      {
        requestId: mine.request.requestId,
        revision: 1,
        paneId: 'pane-a',
        provider: 'claude',
        tool: 'Bash',
        summary: 'touch a',
        options: mine.request.options,
        responseCapability: 'live',
        expiresAt: mine.request.expiresAt,
      },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('sess-a');
  });

  it('no authenticated device → the bridge is not a responder', () => {
    expect(hasApprovalResponder('sess-a')).toBe(false);
  });
});
