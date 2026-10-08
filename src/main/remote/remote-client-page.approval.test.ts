import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { REMOTE_CLIENT_HTML } from './remote-client-page';

// PRV-02/MOB-07 no Nexus Remote (PWA): as aprovações chegam pelo snapshot e
// pelo push, e a resposta é a RPC estruturada — nunca pane.input.
const script = REMOTE_CLIENT_HTML.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? '';

describe('Nexus Remote approvals', () => {
  it('still compiles with the approval card', () => {
    expect(script).not.toBe('');
    expect(() => new vm.Script(script)).not.toThrow();
  });

  it('answers through agentSession.respondToApproval with requestId/revision', () => {
    expect(script).toContain("send('agentSession.respondToApproval', {");
    expect(script).toContain('itemId: a.requestId, expectedRevision: a.revision, optionId: optionId');
    const respond = script.slice(script.indexOf('function respondApproval'), script.indexOf('function refreshApprovals'));
    expect(respond).not.toContain('pane.input');
  });

  it('refreshes on the approvals.changed push and on the snapshot', () => {
    expect(script).toContain("if (msg.type === 'approvals.changed') refreshApprovals();");
    expect(script).toContain('renderApprovals(result.approvals);');
  });

  it('embeds the pt-BR labels as data, rendered with textContent only', () => {
    expect(script).toContain('"acceptForSession":"Permitir na sessão"');
    const render = script.slice(script.indexOf('function renderApprovals'), script.indexOf('function respondApproval'));
    expect(render).not.toContain('innerHTML');
  });
});
