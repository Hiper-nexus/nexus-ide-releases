import { describe, expect, it } from 'vitest';
import {
  buildSyncRepoViaPanePrompt,
  isSyncRepoViaPaneMode,
  normalizeSyncRepoViaPaneMode,
  syncRepoViaPaneMissionIntent,
  syncRepoViaPaneSay,
} from './sync-repo-via-pane';

describe('sync-repo-via-pane', () => {
  it('normalizes unknown modes to pull', () => {
    expect(normalizeSyncRepoViaPaneMode(undefined)).toBe('pull');
    expect(normalizeSyncRepoViaPaneMode('nope')).toBe('pull');
    expect(isSyncRepoViaPaneMode('push')).toBe(true);
    expect(isSyncRepoViaPaneMode('rebase')).toBe(false);
  });

  it('builds product prompts that forbid force and config edits', () => {
    for (const mode of ['pull', 'status', 'push'] as const) {
      const prompt = buildSyncRepoViaPanePrompt(mode);
      expect(prompt).toContain('Do not change .git/config');
      expect(prompt).toMatch(/force|Do not run force/i);
      expect(prompt).toContain('Brazilian Portuguese');
    }
    expect(buildSyncRepoViaPanePrompt('pull')).toContain('git pull --ff-only');
    expect(buildSyncRepoViaPanePrompt('status')).toContain('git status -sb');
    expect(buildSyncRepoViaPanePrompt('status')).not.toContain('git pull');
    expect(buildSyncRepoViaPanePrompt('push')).toContain('git push');
    expect(buildSyncRepoViaPanePrompt('push')).toMatch(/Never use --force/i);
    expect(buildSyncRepoViaPanePrompt('push')).not.toMatch(/unless already/i);
  });

  it('speaks user-facing Portuguese confirmations', () => {
    expect(syncRepoViaPaneSay('pull', 'Claude')).toContain('atualizar o repositório');
    expect(syncRepoViaPaneSay('status')).toContain('status do repositório');
    expect(syncRepoViaPaneSay('push')).toContain('enviar o repositório');
    expect(syncRepoViaPaneMissionIntent('pull')).toMatch(/ff-only/i);
  });
});
