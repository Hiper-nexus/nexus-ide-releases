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

export function syncRepoViaPaneMissionIntent(mode: SyncRepoViaPaneMode): string {
  if (mode === 'status') {
    return 'Checar o status do repositório Git (somente leitura) e resumir em português.';
  }
  if (mode === 'push') {
    return 'Fazer git push da branch atual sem force e resumir o resultado em português.';
  }
  return 'Atualizar o repositório com fetch e pull --ff-only, sem merge/rebase destrutivo, e resumir em português.';
}

export function syncRepoViaPaneNoAgentSay(mode: SyncRepoViaPaneMode): string {
  if (mode === 'status') {
    return 'Não tem agente aberto — abri uma missão agêntica pra checar o status do repositório.';
  }
  if (mode === 'push') {
    return 'Não tem agente aberto — abri uma missão agêntica pra enviar o repositório.';
  }
  return 'Não tem agente aberto — abri uma missão agêntica pra atualizar o repositório.';
}
