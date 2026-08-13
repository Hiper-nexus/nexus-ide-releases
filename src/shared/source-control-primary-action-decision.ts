// Adapted from stablyai/orca @ 93334dc53fccdb7348d09fc28067ba6d3dec36ea
// (src/shared/source-control-primary-action-decision.ts).
// Copyright (c) 2026 Lovecast Inc. — MIT License
// See third_party/licenses/orca-MIT.txt.
// Nexus changes: núcleo honesto do que o painel Git JÁ faz (commit / stage /
// publish / push / create PR / enqueue). Sem i18n Tailwind, force-push-with-lease,
// sync/rebase, create_pr_intent ou pull. Labels e titles em português.

import { canEnableGitHubPRAutoMerge } from './github-pr-auto-merge-availability';

export type SourceControlPrimaryActionKind =
  | 'commit'
  | 'stage'
  | 'publish'
  | 'push'
  | 'create_pr'
  | 'enqueue';

export type SourceControlPrState = 'open' | 'closed' | 'merged' | 'draft' | null;

export type SourceControlPrimaryActionDecision = {
  kind: SourceControlPrimaryActionKind;
  label: string;
  title: string;
  disabled: boolean;
};

export type SourceControlPrimaryActionDecisionInputs = {
  stagedCount: number;
  hasStageableChanges: boolean;
  hasMessage: boolean;
  hasUnresolvedConflicts: boolean;
  isCommitting: boolean;
  isRemoteBusy: boolean;
  hasCurrentBranch: boolean;
  hasUpstream: boolean;
  ahead: number;
  behind: number;
  isDefaultBranch: boolean;
  prState: SourceControlPrState;
  autoMergeEnabled: boolean;
  autoMergeAllowed: boolean | null;
  mergeQueueRequired: boolean | null;
  mergeable?: string;
  mergeStateStatus?: string | null;
  reviewDecision?: string | null;
};

function disabled(
  kind: SourceControlPrimaryActionKind,
  label: string,
  title: string,
): SourceControlPrimaryActionDecision {
  return { kind, label, title, disabled: true };
}

function enabled(
  kind: SourceControlPrimaryActionKind,
  label: string,
  title: string,
): SourceControlPrimaryActionDecision {
  return { kind, label, title, disabled: false };
}

function canEnqueueOpenPr(
  inputs: SourceControlPrimaryActionDecisionInputs,
): boolean {
  if (inputs.prState !== 'open') return false;
  if (inputs.autoMergeEnabled) return false;
  if (inputs.mergeQueueRequired === true) return true;
  return canEnableGitHubPRAutoMerge({
    state: 'open',
    mergeable: inputs.mergeable,
    mergeStateStatus: inputs.mergeStateStatus,
    reviewDecision: inputs.reviewDecision,
    autoMergeEnabled: inputs.autoMergeEnabled,
    autoMergeAllowed: inputs.autoMergeAllowed,
    mergeQueueRequired: inputs.mergeQueueRequired,
  });
}

/**
 * Próximo passo óbvio do painel Git: um botão que muda de verbo.
 * Ordem: conflitos/busy → commit/stage → publish/push → PR → enqueue.
 */
export function resolveSourceControlPrimaryActionDecision(
  inputs: SourceControlPrimaryActionDecisionInputs,
): SourceControlPrimaryActionDecision {
  if (inputs.isCommitting) {
    return disabled('commit', 'Commit', 'Commit em andamento');
  }
  if (inputs.isRemoteBusy) {
    return disabled('push', 'Enviar', 'Operação remota em andamento');
  }
  if (inputs.hasUnresolvedConflicts) {
    return disabled(
      'commit',
      'Commit',
      'Resolva os conflitos antes de continuar',
    );
  }

  if (inputs.stagedCount > 0 && inputs.hasMessage) {
    return enabled('commit', 'Commit', 'Gravar as mudanças no histórico');
  }
  if (inputs.stagedCount > 0 && !inputs.hasMessage) {
    return disabled(
      'commit',
      'Commit',
      'Escreva uma mensagem de commit',
    );
  }
  if (inputs.stagedCount === 0 && inputs.hasStageableChanges) {
    return enabled(
      'stage',
      'Adicionar tudo',
      'Preparar todas as mudanças para o commit',
    );
  }

  if (!inputs.hasCurrentBranch) {
    return disabled(
      'commit',
      'Commit',
      'Não há branch atual (HEAD destacado)',
    );
  }

  if (!inputs.hasUpstream) {
    return enabled(
      'publish',
      'Publicar',
      'Enviar esta branch para o remoto pela primeira vez',
    );
  }

  if (inputs.ahead > 0 && inputs.behind > 0) {
    return disabled(
      'push',
      'Enviar',
      'A branch divergiu do remoto — resolva no terminal',
    );
  }
  if (inputs.behind > 0) {
    return disabled(
      'push',
      'Enviar',
      'A branch está atrasada em relação ao remoto',
    );
  }
  if (inputs.ahead > 0) {
    return enabled(
      'push',
      'Enviar',
      inputs.ahead === 1
        ? 'Enviar 1 commit para o remoto'
        : `Enviar ${inputs.ahead} commits para o remoto`,
    );
  }

  if (inputs.prState === 'open' && inputs.autoMergeEnabled) {
    return disabled(
      'enqueue',
      'Enfileirar',
      'O auto-merge já está ligado neste PR',
    );
  }
  if (canEnqueueOpenPr(inputs)) {
    return enabled(
      'enqueue',
      'Enfileirar',
      inputs.mergeQueueRequired === true
        ? 'Colocar este PR na fila de merge'
        : 'Ligar auto-merge quando os requisitos passarem',
    );
  }
  if (inputs.prState === 'open' || inputs.prState === 'draft') {
    return disabled(
      'create_pr',
      'Abrir PR',
      inputs.prState === 'draft'
        ? 'Já existe um PR rascunho nesta branch'
        : 'Já existe um PR aberto nesta branch',
    );
  }

  if (inputs.prState === 'merged') {
    return disabled(
      'create_pr',
      'Abrir PR',
      'PR já mergeado nesta branch',
    );
  }

  if (inputs.isDefaultBranch) {
    return disabled(
      'commit',
      'Commit',
      'Nada para commitar — working tree limpa',
    );
  }

  if (inputs.prState === 'closed') {
    return enabled(
      'create_pr',
      'Abrir PR',
      'Abrir um novo PR — o anterior foi fechado',
    );
  }

  return enabled(
    'create_pr',
    'Abrir PR',
    'Abrir um pull request com título e descrição gerados',
  );
}
