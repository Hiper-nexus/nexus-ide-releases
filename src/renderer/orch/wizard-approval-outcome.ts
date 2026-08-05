/**
 * Veredito pós-aprovação do wizard (fix do loop infinito de aprovação, 05/08).
 *
 * O approve main-owned SELA o squad da missão e esse selo bumpa intentVersion
 * (renderer-mission-authority: sealMissionSquadForApproval, +1). O guard
 * antigo do wizard comparava a versão retornada com a versão pré-selo e
 * jogava "O objetivo mudou durante o preflight" DEPOIS de a aprovação já ter
 * consumado e o bootstrap já estar rodando — cada re-clique reabria o diálogo
 * nativo e falhava de novo: loop por construção, com a missão viva em fundo.
 *
 * Regra: mutação CAUSADA PELO SISTEMA (selo/bootstrap derivados do intent
 * aprovado) dobra no escopo aprovado — aprovar o intent aprova o selo que ele
 * produz deterministicamente. Só mudança MATERIAL do usuário re-prompta: aqui,
 * o goal do contrato divergir do goal que o wizard exibiu.
 */

export interface WizardApprovedMission {
  readonly intentVersion?: number;
  readonly intentContract?: {
    readonly goal?: string;
    readonly approvedAt?: number;
  };
}

export type WizardApprovalOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'goal-changed' | 'not-approved' };

export function wizardApprovalOutcome(input: {
  readonly plannedGoal: string;
  readonly plannedIntentVersion?: number;
  readonly approved: WizardApprovedMission;
}): WizardApprovalOutcome {
  const contract = input.approved.intentContract;
  if (!contract || typeof contract.approvedAt !== 'number') {
    return { ok: false, reason: 'not-approved' };
  }
  if (contract.goal !== input.plannedGoal) {
    return { ok: false, reason: 'goal-changed' };
  }
  return { ok: true };
}
