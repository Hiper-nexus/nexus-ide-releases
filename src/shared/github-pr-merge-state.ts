// Adapted from stablyai/orca @ 93334dc53fccdb7348d09fc28067ba6d3dec36ea
// (src/renderer/src/components/github-pr-merge-state.ts).
// Copyright (c) 2026 Lovecast Inc. — MIT License
// See third_party/licenses/orca-MIT.txt.
// Nexus changes: Portuguese labels, no i18n/Tailwind — tone tokens for git-scm.css.

import { canEnableGitHubPRAutoMerge } from './github-pr-auto-merge-availability';

export type GitHubPRMergeStateInput = {
  state: 'open' | 'closed' | 'merged' | 'draft';
  mergeable?: string;
  mergeStateStatus?: string | null;
  reviewDecision?: string | null;
  autoMergeEnabled?: boolean;
  autoMergeAllowed?: boolean | null;
  mergeQueueRequired?: boolean | null;
};

export type GitHubPRAutoMergeAction = {
  kind: 'enable' | 'disable';
  label: string;
  tooltip: string;
};

export type GitHubPRMergeStatePresentation = {
  label: string;
  tone: 'muted' | 'success' | 'warning' | 'danger';
  tooltip: string;
  directMergeAvailable: boolean;
  autoMergeAction: GitHubPRAutoMergeAction | null;
};

function autoMergeActionWhenDirectMergeAvailable(
  autoMergeAction: GitHubPRAutoMergeAction | null,
): GitHubPRAutoMergeAction | null {
  return autoMergeAction?.kind === 'disable' ? autoMergeAction : null;
}

export function presentGitHubPRMergeState(
  item: GitHubPRMergeStateInput,
): GitHubPRMergeStatePresentation {
  const autoMergeAction =
    item.state !== 'open'
      ? null
      : item.autoMergeEnabled === true
        ? {
            kind: 'disable' as const,
            label: 'Desligar auto-merge',
            tooltip: 'O auto-merge do GitHub está ligado neste PR',
          }
        : item.mergeQueueRequired === true
          ? {
              kind: 'enable' as const,
              label: 'Enfileirar',
              tooltip: 'Coloca este PR na merge queue do GitHub (Merge when ready)',
            }
          : canEnableGitHubPRAutoMerge(item)
            ? {
                kind: 'enable' as const,
                label: 'Ligar auto-merge',
                tooltip: 'Merge automático quando os requisitos da branch passarem',
              }
            : null;

  if (item.state === 'merged') {
    return {
      label: 'Merged',
      tone: 'muted',
      tooltip: 'Este pull request já foi mergeado',
      directMergeAvailable: false,
      autoMergeAction,
    };
  }
  if (item.state === 'closed') {
    return {
      label: 'Closed',
      tone: 'danger',
      tooltip: 'Este pull request está fechado',
      directMergeAvailable: false,
      autoMergeAction,
    };
  }
  if (item.state === 'draft') {
    return {
      label: 'Draft',
      tone: 'muted',
      tooltip: 'Este pull request ainda é rascunho',
      directMergeAvailable: false,
      autoMergeAction,
    };
  }
  if (item.reviewDecision === 'REVIEW_REQUIRED') {
    return {
      label: 'Approval required',
      tone: 'warning',
      tooltip: 'O GitHub exige aprovação antes do merge',
      directMergeAvailable: false,
      autoMergeAction,
    };
  }
  if (item.reviewDecision === 'CHANGES_REQUESTED') {
    return {
      label: 'Changes requested',
      tone: 'danger',
      tooltip: 'Há mudanças pedidas neste PR',
      directMergeAvailable: false,
      autoMergeAction,
    };
  }
  if (item.mergeQueueRequired === true) {
    return {
      label: item.autoMergeEnabled ? 'Na fila' : 'Merge queue',
      tone: 'warning',
      tooltip: 'A branch-alvo usa a merge queue do GitHub',
      directMergeAvailable: false,
      autoMergeAction,
    };
  }
  if (item.mergeable === 'CONFLICTING' || item.mergeStateStatus === 'DIRTY') {
    return {
      label: 'Conflicts',
      tone: 'danger',
      tooltip: 'O GitHub reporta conflitos de merge',
      directMergeAvailable: false,
      autoMergeAction,
    };
  }
  if (item.mergeStateStatus === 'BEHIND') {
    return {
      label: 'Behind',
      tone: 'warning',
      tooltip: 'Atualize a branch antes de mergear',
      directMergeAvailable: false,
      autoMergeAction,
    };
  }
  if (item.mergeStateStatus === 'BLOCKED') {
    return {
      label: 'Blocked',
      tone: 'danger',
      tooltip: 'O GitHub bloqueou este pull request',
      directMergeAvailable: false,
      autoMergeAction,
    };
  }
  if (item.mergeable === 'MERGEABLE' || item.mergeStateStatus === 'CLEAN') {
    return {
      label: 'Able to merge',
      tone: 'success',
      tooltip: 'O GitHub diz que este PR pode mergear',
      directMergeAvailable: true,
      autoMergeAction: autoMergeActionWhenDirectMergeAvailable(autoMergeAction),
    };
  }
  return {
    label: 'Checking',
    tone: 'muted',
    tooltip: 'O GitHub ainda está calculando o estado de merge',
    directMergeAvailable: false,
    autoMergeAction,
  };
}
