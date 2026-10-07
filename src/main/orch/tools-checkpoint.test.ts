import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';

const h = vi.hoisted(() => ({
  executionRoot: '',
  records: [] as Array<{ worktreePath: string }>,
}));
vi.mock('./project-domain-store-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./project-domain-store-registry')>()),
  getProjectDomainStores: () => ({ missions: { get: () => ({ id: 'mission-a' }) } }),
}));
vi.mock('./mission-execution-scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./mission-execution-scope')>()),
  missionExecutionScope: (scope: ProjectExecutionScope) => ({ ...scope, rootRealPath: h.executionRoot }),
}));
vi.mock('../runtime/worktree-runtime-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../runtime/worktree-runtime-registry')>()),
  requireWorktreeRuntimeRegistry: () => ({ listMission: () => h.records }),
}));

import { buildCheckpointTools } from './tools-checkpoint';
import { buildToolset } from './tools';
import { captureWriterHandoffCheckpoint, missionCheckpointScopeId } from './handoff-checkpoint';
import { checkpointRefForScopeOrdinal, hiddenCheckpointIdle } from '../git/hidden-checkpoint';
import {
  effectPolicyForTool,
  isToolAllowedForReadOnlyContext,
  requiresHumanConfirmationForTool,
} from './mcp-effect-policy';
import { validateToolArgs } from './mcp-args-validation';
import type { AgentGateContext } from './gate';
import type { McpToolInvocation } from './mcp-protocol';
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
    token: 'token',
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

function tool(name: string) {
  const found = buildCheckpointTools().find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing ${name}`);
  return found;
}

const orchestrator = (): AgentGateContext => ctx({ role: 'orchestrator', label: 'maestro', executionScope: undefined });

beforeEach(async () => {
  temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-tools-checkpoint-')));
  repo = path.join(temp, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  git(repo, 'add', 'base.txt');
  git(repo, 'commit', '-qm', 'base');
  worktree = path.join(temp, 'writer');
  git(repo, 'worktree', 'add', '-q', '-b', 'nexus/writer-a', worktree);
  fs.writeFileSync(path.join(worktree, 'feito.txt'), 'turno 1\n');
  h.executionRoot = repo;
  h.records = [{ worktreePath: worktree }];
  await captureWriterHandoffCheckpoint(ctx());
  fs.writeFileSync(path.join(worktree, 'feito.txt'), 'quebrado\n');
});

afterEach(async () => {
  await hiddenCheckpointIdle();
  fs.rmSync(temp, { recursive: true, force: true });
});

const firstRef = () => checkpointRefForScopeOrdinal(missionCheckpointScopeId('mission-a', worktree), 1);

describe('nexus_checkpoint_list / nexus_checkpoint_restore', () => {
  it('worker lista, vê a prévia e só então restaura explicitamente a própria árvore', async () => {
    const listed = await tool('nexus_checkpoint_list').handler({}, ctx()) as {
      scopes: Array<{ root: string; checkpoints: Array<{ ref: string }> }>;
    };
    expect(listed.scopes).toEqual([
      expect.objectContaining({ root: worktree, checkpoints: [expect.objectContaining({ ref: firstRef() })] }),
    ]);

    const preview = await tool('nexus_checkpoint_list').handler({ ref: firstRef() }, ctx());
    expect(preview).toMatchObject({ root: worktree, wouldOverwrite: { files: ['feito.txt'], total: 1 } });
    expect(fs.readFileSync(path.join(worktree, 'feito.txt'), 'utf8')).toBe('quebrado\n');

    const assertCurrentAuthority = vi.fn();
    const restored = await tool('nexus_checkpoint_restore').handler(
      { ref: firstRef() }, ctx(), { assertCurrentAuthority } as McpToolInvocation,
    ) as { backupRef: string };
    expect(restored).toMatchObject({ applied: true, overwritten: { files: ['feito.txt'] } });
    expect(assertCurrentAuthority).toHaveBeenCalled();
    expect(fs.readFileSync(path.join(worktree, 'feito.txt'), 'utf8')).toBe('turno 1\n');
    expect(git(repo, 'show', `${restored.backupRef}:feito.txt`)).toBe('quebrado');
  });

  it('autoridade revogada antes da escrita não escreve nem guarda nada', async () => {
    const revoked = { assertCurrentAuthority: () => { throw new Error('session_authority_revoked'); } } as McpToolInvocation;

    await expect(tool('nexus_checkpoint_restore').handler({ ref: firstRef() }, ctx(), revoked))
      .rejects.toThrow(/session_authority_revoked/);
    expect(fs.readFileSync(path.join(worktree, 'feito.txt'), 'utf8')).toBe('quebrado\n');
    expect(git(repo, 'for-each-ref', '--format=%(refname)', 'refs/nexus-checkpoint')).toBe(firstRef());
  });

  it('orquestrador vê as raízes de execução da missão, nunca a de coordenação', async () => {
    const listed = await tool('nexus_checkpoint_list').handler({}, orchestrator()) as { scopes: Array<{ root: string }> };
    expect(listed.scopes.map((scope) => scope.root)).toEqual([worktree]);

    const restored = await tool('nexus_checkpoint_restore').handler({ ref: firstRef() }, orchestrator());
    expect(restored).toMatchObject({ root: worktree, applied: true });
    expect(fs.readFileSync(path.join(worktree, 'feito.txt'), 'utf8')).toBe('turno 1\n');
  });

  it('recusa ref de outra missão, sessão read-only, operador e chamada fora de missão', async () => {
    const foreign = checkpointRefForScopeOrdinal(missionCheckpointScopeId('mission-b', worktree), 1);
    const restore = tool('nexus_checkpoint_restore');
    await expect(restore.handler({ ref: foreign }, ctx())).rejects.toThrow(/não pertence/);
    await expect(restore.handler({ ref: 'refs/heads/main' }, ctx())).rejects.toThrow(/ref inválida/);
    await expect(restore.handler({ ref: firstRef() }, ctx({ readOnly: true }))).rejects.toThrow(/read-only/);
    await expect(restore.handler({ ref: firstRef() }, ctx({ role: 'user' }))).rejects.toThrow(/orquestrador ou um worker/);
    await expect(restore.handler({ ref: firstRef() }, ctx({ missionId: undefined }))).rejects.toThrow(/missão/);
    h.records = [];
    await expect(restore.handler({ ref: firstRef() }, orchestrator())).rejects.toThrow(/não pertence/);
    expect(fs.readFileSync(path.join(worktree, 'feito.txt'), 'utf8')).toBe('quebrado\n');
  });

  it('lista é leitura; restauração é efeito de missão com confirmação e fora de read-only', () => {
    expect(buildToolset().map((candidate) => candidate.name)).toEqual(
      expect.arrayContaining(['nexus_checkpoint_list', 'nexus_checkpoint_restore']),
    );
    expect(effectPolicyForTool('nexus_checkpoint_list')).toBe('read-only');
    expect(effectPolicyForTool('nexus_checkpoint_restore')).toBe('mission-effect');
    expect(requiresHumanConfirmationForTool('nexus_checkpoint_restore')).toBe(true);
    expect(isToolAllowedForReadOnlyContext('nexus_checkpoint_list')).toBe(true);
    expect(isToolAllowedForReadOnlyContext('nexus_checkpoint_restore')).toBe(false);
    expect(() => validateToolArgs('nexus_checkpoint_restore', { ref: 'refs/heads/main' })).toThrow();
    expect(() => validateToolArgs('nexus_checkpoint_restore', { ref: firstRef(), cwd: '/tmp' })).toThrow();
    expect(validateToolArgs('nexus_checkpoint_list', {})).toEqual({});
  });
});
