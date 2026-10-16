import { describe, expect, it } from 'vitest';
import { shotDestinationSchema, shotTargetIdSchema, shotTargetBindingSchema } from './shot-bridge';

describe('Shot destination trust boundary', () => {
  it('keeps generic delivery and both client forms, refusing ambiguous selection', () => {
    for (const value of [{}, { targetPaneId: 'pane-1' }, { target: { paneId: 'pane-1' } },
      { targetPaneId: 'pane-1', target: { paneId: 'pane-1' } }]) {
      expect(shotDestinationSchema.safeParse(value).success).toBe(true);
    }
    for (const value of [null, [], { targetPaneId: null }, { target: {} },
      { target: { paneId: 'pane-1', command: 'run' } },
      { targetPaneId: 'pane-1', target: { paneId: 'pane-2' } }]) {
      expect(shotDestinationSchema.safeParse(value).success).toBe(false);
    }
  });
  it('treats `target: null` (no pane chosen in the Shot selector) as no target, not as a malformed one', () => {
    // O Nexus Shot manda `"target": null` quando nenhum pane foi escolhido.
    for (const value of [{ target: null }, { targetPaneId: 'pane-1', target: null }]) {
      expect(shotDestinationSchema.safeParse(value).success).toBe(true);
    }
    // Sem alvo: o servidor lê `target?.paneId`, que fica undefined (entrega padrão).
    const parsed = shotDestinationSchema.parse({ type: 'ingest', target: null });
    expect(parsed.target?.paneId).toBeUndefined();
    expect(parsed.targetPaneId).toBeUndefined();
    // `targetPaneId` continua estrito (ausente ou id válido) e o resto de `target` também.
    for (const value of [{ targetPaneId: null }, { targetPaneId: null, target: null },
      { target: 'pane-1' }, { target: [] }, { target: 0 }]) {
      expect(shotDestinationSchema.safeParse(value).success).toBe(false);
    }
  });
  it('bounds opaque IDs and refuses paths, whitespace and controls', () => {
    expect(shotTargetIdSchema.safeParse('p'.repeat(128)).success).toBe(true);
    for (const value of ['', 'p'.repeat(129), '/tmp/pane', ' pane-1 ', 'pane\n1', 'pane\u0000']) {
      expect(shotTargetIdSchema.safeParse(value).success).toBe(false);
    }
  });
  it('requires the exact internal binding fields without accepting extra capabilities', () => {
    const binding = { paneId: 'pane-a', sessionId: 'session-a', workspacePath: '/workspace' };
    expect(shotTargetBindingSchema.safeParse(binding).success).toBe(true);
    for (const value of [{ ...binding, sessionId: '' }, { ...binding, workspacePath: '' },
      { ...binding, allowedTools: ['anything'] }, { paneId: binding.paneId }]) {
      expect(shotTargetBindingSchema.safeParse(value).success).toBe(false);
    }
  });
});
