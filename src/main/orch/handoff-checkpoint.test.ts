import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  captureWriterHandoffCheckpoint,
  HANDOFF_CHECKPOINT_ARTIFACT_KIND,
  missionCheckpointScopeId,
} from './handoff-checkpoint';
import { checkpointRefForScopeOrdinal, hiddenCheckpointIdle } from '../git/hidden-checkpoint';
import type { AgentGateContext } from './gate';
import { testProjectScope } from './__tests__/scope-fixture';

let temp: string;
let repo: string;
let worktree: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t.test', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t.test' },
  }).trim();
}

function ctx(overrides: Partial<AgentGateContext> = {}): AgentGateContext {
  return {
    token: 'token-writer',
    label: 'writer-a',
    role: 'worker',
    missionId: 'mission-a',
    sessionId: 'session-a',
    scope: testProjectScope({ rootRealPath: repo }),
    executionScope: testProjectScope({ rootRealPath: worktree }),
    allowedTools: null,
    allowedSkills: null,
    stopAttempts: 0,
    handoffSubmitted: false,
    ...overrides,
  };
}

function checkpointRefs(): string[] {
  const out = git(repo, 'for-each-ref', '--format=%(refname)', 'refs/nexus-checkpoint');
  return out ? out.split('\n') : [];
}

beforeEach(() => {
  temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-handoff-checkpoint-')));
  repo = path.join(temp, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  git(repo, 'add', 'base.txt');
  git(repo, 'commit', '-qm', 'base');
  worktree = path.join(temp, 'writer');
  git(repo, 'worktree', 'add', '-q', '-b', 'nexus/writer-a', worktree);
  fs.writeFileSync(path.join(worktree, 'feito.txt'), 'turno 1\n');
});

afterEach(async () => {
  await hiddenCheckpointIdle();
  fs.rmSync(temp, { recursive: true, force: true });
});

describe('captureWriterHandoffCheckpoint', () => {
  it('fim do turno do writer grava a ref da raiz de execução no artifact do handoff', async () => {
    const artifact = await captureWriterHandoffCheckpoint(ctx());

    const ref = checkpointRefForScopeOrdinal(missionCheckpointScopeId('mission-a', worktree), 1);
    expect(artifact).toMatchObject({
      kind: HANDOFF_CHECKPOINT_ARTIFACT_KIND,
      payload: { ok: true, ref, ordinal: 1, baseSha: git(worktree, 'rev-parse', 'HEAD') },
    });
    expect(git(repo, 'show', `${ref}:feito.txt`)).toBe('turno 1');
    // Replay exato do mesmo handoff: o store compara artifacts campo a campo.
    expect(await captureWriterHandoffCheckpoint(ctx())).toEqual(artifact);
    fs.writeFileSync(path.join(worktree, 'feito.txt'), 'turno 2\n');
    expect(await captureWriterHandoffCheckpoint(ctx())).toMatchObject({ payload: { ok: true, ordinal: 2 } });
  });

  it('nunca fotografa a raiz de coordenação nem sessão sem autoridade de escrita', async () => {
    const coordination = { executionScope: testProjectScope({ rootRealPath: repo }) };
    expect(await captureWriterHandoffCheckpoint(ctx(coordination))).toBeNull();
    expect(await captureWriterHandoffCheckpoint(ctx({ executionScope: undefined }))).toBeNull();
    expect(await captureWriterHandoffCheckpoint(ctx({ readOnly: true }))).toBeNull();
    expect(await captureWriterHandoffCheckpoint(ctx({ role: 'orchestrator' }))).toBeNull();
    expect(await captureWriterHandoffCheckpoint(ctx({ missionId: undefined }))).toBeNull();
    expect(checkpointRefs()).toEqual([]);
  });

  it('falha vira artifact visível e não derruba a entrega', async () => {
    git(worktree, 'config', 'core.sparseCheckout', 'true');

    const artifact = await captureWriterHandoffCheckpoint(ctx());

    expect(artifact?.payload).toMatchObject({ ok: false });
    expect(String(artifact?.payload.reason)).toMatch(/^sparse-checkout-unsupported/);
    expect(checkpointRefs()).toEqual([]);
  });
});
