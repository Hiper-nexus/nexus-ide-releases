import { describe, expect, it } from 'vitest';
import { wizardApprovalOutcome } from './wizard-approval-outcome';

describe('wizardApprovalOutcome', () => {
  it('aceita drift de intentVersion causado pelo selo (aprovação consumada, mesmo goal)', () => {
    // O caso do loop infinito de 05/08: o selo do squad DENTRO do approve
    // bumpa intentVersion (+1); a versão retornada nunca bate com a do wizard.
    const outcome = wizardApprovalOutcome({
      plannedGoal: 'continua codando nosso sistema — story 2',
      plannedIntentVersion: 3,
      approved: {
        intentVersion: 4,
        intentContract: {
          goal: 'continua codando nosso sistema — story 2',
          approvedAt: 1_785_968_000_000,
        },
      },
    });
    expect(outcome).toEqual({ ok: true });
  });

  it('re-prompt só para mudança MATERIAL do usuário: goal divergente', () => {
    const outcome = wizardApprovalOutcome({
      plannedGoal: 'objetivo original',
      plannedIntentVersion: 3,
      approved: {
        intentVersion: 3,
        intentContract: { goal: 'objetivo trocado', approvedAt: 1 },
      },
    });
    expect(outcome).toEqual({ ok: false, reason: 'goal-changed' });
  });

  it('recusa quando o contrato voltou sem aprovação consumada', () => {
    const outcome = wizardApprovalOutcome({
      plannedGoal: 'objetivo',
      plannedIntentVersion: 3,
      approved: {
        intentVersion: 3,
        intentContract: { goal: 'objetivo', approvedAt: undefined },
      },
    });
    expect(outcome).toEqual({ ok: false, reason: 'not-approved' });
  });

  it('recusa quando o contrato sumiu', () => {
    const outcome = wizardApprovalOutcome({
      plannedGoal: 'objetivo',
      plannedIntentVersion: 3,
      approved: { intentVersion: 3 },
    });
    expect(outcome).toEqual({ ok: false, reason: 'not-approved' });
  });

  it('aceita retomada idempotente: versão regrediu mas o goal aprovado é o mesmo', () => {
    // Re-clique com missão já dispatched → continueMainOwnedBootstrap devolve
    // a missão corrente; qualquer delta de versão é do sistema, não do usuário.
    const outcome = wizardApprovalOutcome({
      plannedGoal: 'objetivo',
      plannedIntentVersion: 5,
      approved: {
        intentVersion: 4,
        intentContract: { goal: 'objetivo', approvedAt: 9 },
      },
    });
    expect(outcome).toEqual({ ok: true });
  });
});
