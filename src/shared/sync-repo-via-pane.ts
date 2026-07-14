/**
 * Product path for user-facing repository updates: never ProcessGitRunner /
 * nexus_git_* for vibe-coder sync. Jarvis submits a fixed English prompt to an
 * AI CLI pane; the agent runs git in the user's normal multi-OS environment.
 */

export const SYNC_REPO_VIA_PANE_MODES = ['pull', 'status', 'push'] as const;

export type SyncRepoViaPaneMode = (typeof SYNC_REPO_VIA_PANE_MODES)[number];

export function isSyncRepoViaPaneMode(value: unknown): value is SyncRepoViaPaneMode {
  return (
    typeof value === 'string' &&
    (SYNC_REPO_VIA_PANE_MODES as readonly string[]).includes(value)
  );
}

export function normalizeSyncRepoViaPaneMode(
  value: unknown,
): SyncRepoViaPaneMode {
  return isSyncRepoViaPaneMode(value) ? value : 'pull';
}

/** Fixed product templates — not model-authored free text. */
export function buildSyncRepoViaPanePrompt(mode: SyncRepoViaPaneMode): string {
  const common = [
    'Work only in the current workspace repository root.',
    'Do not change .git/config.',
    'Do not run force push, hard reset, clean -fd, or rewrite history.',
    'If authentication fails, stop and report the error clearly.',
    'When finished, reply in Brazilian Portuguese with: branch name, what you ran, result, and any blockers.',
  ].join(' ');

  if (mode === 'status') {
    return [
      'Repository status only (read-only).',
      '1) Run: git status -sb',
      '2) Run: git remote -v (if useful) and summarize tracking branch.',
      '3) Optionally: git log --oneline -5',
      'Do not pull, push, commit, stash, or change files.',
      common,
    ].join(' ');
  }

  if (mode === 'push') {
    return [
      'Push the current branch to its remote (user requested push).',
      '1) Run: git status -sb',
      '2) If there is nothing to push, say so and stop.',
      '3) Run only: git push (plain push). Never use --force, --force-with-lease, or any force flag.',
      '4) If push is rejected (non-fast-forward), do NOT force; explain that pull/rebase is needed first.',
      common,
    ].join(' ');
  }

  // pull (default)
  return [
    'Update this repository from the remote (user asked to sync/pull).',
    '1) Run: git status -sb',
    '2) Run: git fetch (default remote)',
    '3) If the current branch tracks a remote, run: git pull --ff-only',
    '4) If ff-only is not possible, do NOT merge or rebase destructively; stop and explain the blocker in Brazilian Portuguese.',
    '5) Summarize new commits / whether the working tree stayed clean.',
    common,
  ].join(' ');
}

export function syncRepoViaPaneSay(
  mode: SyncRepoViaPaneMode,
  paneTitle?: string,
): string {
  const where = paneTitle ? ` no pane ${paneTitle}` : ' no agente';
  if (mode === 'status') {
    return `Mandei o agente checar o status do repositório${where}.`;
  }
  if (mode === 'push') {
    return `Mandei o agente enviar o repositório${where}.`;
  }
  return `Mandei o agente atualizar o repositório${where}.`;
}

export function syncRepoViaPaneNoAgentSay(mode: SyncRepoViaPaneMode): string {
  if (mode === 'status') {
    return 'Não tinha agente livre — abri um agente único pra checar o status do repositório.';
  }
  if (mode === 'push') {
    return 'Não tinha agente livre — abri um agente único pra enviar o repositório.';
  }
  return 'Não tinha agente livre — abri um agente único pra atualizar o repositório.';
}

/** Pane runtime states that must not receive a sync prompt mid-turn. */
export const SYNC_REPO_BUSY_PANE_STATES = ['busy', 'spawning'] as const;

export function isSyncRepoPaneFree(state: string | undefined | null): boolean {
  if (!state) return true; // unknown: allow; confirm path still validates session
  return !(SYNC_REPO_BUSY_PANE_STATES as readonly string[]).includes(state);
}

export function syncRepoViaPaneBusySay(paneTitle?: string): string {
  const where = paneTitle ? ` (${paneTitle})` : '';
  return `O agente${where} ainda está ocupado. Espera ele terminar e pede o sync de novo.`;
}

export function syncRepoViaPaneDeliveryFailedSay(): string {
  return 'Não confirmei a entrega do prompt no pane. Abre o agente e tenta de novo.';
}
