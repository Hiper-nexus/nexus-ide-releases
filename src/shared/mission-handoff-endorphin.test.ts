import { describe, expect, it } from 'vitest';
import {
  handoffEndorphin,
  milestoneEndorphin,
} from './mission-endorphin';

describe('handoffEndorphin', () => {
  it('celebra um handoff bem-sucedido com o resumo', () => {
    const hit = handoffEndorphin({ status: 'success', agentName: 'Executor', summary: 'PR aberto' });
    expect(hit).not.toBeNull();
    expect(hit?.kind).toBe('handoff');
    expect(hit?.label).toContain('Executor');
  });

  it('handoff blocked não celebra (não é dopamina)', () => {
    expect(handoffEndorphin({ status: 'blocked', agentName: 'X', summary: '' })).toBeNull();
  });
});

describe('milestoneEndorphin', () => {
  it('bate quando um milestone passa a done', () => {
    const hit = milestoneEndorphin('in_progress', { label: 'Testes verdes', status: 'done' });
    expect(hit?.kind).toBe('milestone');
    expect(hit?.label).toContain('Testes verdes');
  });

  it('não bate se já estava done', () => {
    expect(milestoneEndorphin('done', { label: 'x', status: 'done' })).toBeNull();
  });

  it('não bate em transição para in_progress', () => {
    expect(milestoneEndorphin('pending', { label: 'x', status: 'in_progress' })).toBeNull();
  });
});
