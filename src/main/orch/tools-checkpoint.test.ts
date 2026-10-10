import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';

const h = vi.hoisted(() => ({
  executionRoot: '',
  records: [] as Array<{ worktreePath: string }>,
  sessions: [] as Array<Record<string, unknown>>,
  idle: (_sessionId: string): boolean => true,
}));
vi.mock('../pty/pty-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../pty/pty-manager')>()),
  listAgentSessions: () => h.sessions,
}));
vi.mock('./agent-status', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agent-status')>()),
  isSessionInjectableIdle: (sessionId: string) => h.idle(sessionId),
}));
vi.mock('../context/context-workflow-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../context/context-workflow-registry')>()),
  getContextWorkflowService: () => ({ getMissionWorkflow: () => ({ contract: null, workflow: null }) }),
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
  h.sessions = [];
  h.idle = () => true;
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

  it('recusa ref de outra missão, lane read-only confinada pelo Hardened, operador e chamada fora de missão', async () => {
    const foreign = checkpointRefForScopeOrdinal(missionCheckpointScopeId('mission-b', worktree), 1);
    const restore = tool('nexus_checkpoint_restore');
    await expect(restore.handler({ ref: foreign }, ctx())).rejects.toThrow(/não pertence/);
    await expect(restore.handler({ ref: 'refs/heads/main' }, ctx())).rejects.toThrow(/ref inválida/);
    // F-1157: só a lane que o Hardened confina à leitura é recusada.
    await expect(restore.handler({ ref: firstRef() }, ctx({ readOnly: true, readOnlyEnforced: true }))).rejects.toThrow(/read-only/);
    await expect(restore.handler({ ref: firstRef() }, ctx({ role: 'user' }))).rejects.toThrow(/orquestrador ou um worker/);
    await expect(restore.handler({ ref: firstRef() }, ctx({ missionId: undefined }))).rejects.toThrow(/missão/);
    h.records = [];
    await expect(restore.handler({ ref: firstRef() }, orchestrator())).rejects.toThrow(/não pertence/);
    expect(fs.readFileSync(path.join(worktree, 'feito.txt'), 'utf8')).toBe('quebrado\n');
  });

  it('F-1157: lane só rotulada read-only escreve no Autopilot, então pode restaurar', async () => {
    await expect(tool('nexus_checkpoint_restore').handler({ ref: firstRef() }, ctx({ readOnly: true })))
      .resolves.toMatchObject({ applied: true });
    expect(fs.readFileSync(path.join(worktree, 'feito.txt'), 'utf8')).toBe('turno 1\n');
  });

  it('lista é leitura; restauração é execution-effect com confirmação e fora da leitura confinada pelo Hardened', () => {
    expect(buildToolset().map((candidate) => candidate.name)).toEqual(
      expect.arrayContaining(['nexus_checkpoint_list', 'nexus_checkpoint_restore']),
    );
    expect(effectPolicyForTool('nexus_checkpoint_list')).toBe('read-only');
    expect(effectPolicyForTool('nexus_checkpoint_restore')).toBe('execution-effect');
    expect(requiresHumanConfirmationForTool('nexus_checkpoint_restore')).toBe(true);
    expect(isToolAllowedForReadOnlyContext('nexus_checkpoint_list')).toBe(true);
    // F-1157: o predicado só vale para a lane que o Hardened confina.
    expect(isToolAllowedForReadOnlyContext('nexus_checkpoint_restore')).toBe(false);
    expect(() => validateToolArgs('nexus_checkpoint_restore', { ref: 'refs/heads/main' })).toThrow();
    expect(() => validateToolArgs('nexus_checkpoint_restore', { ref: firstRef(), cwd: '/tmp' })).toThrow();
    expect(validateToolArgs('nexus_checkpoint_list', {})).toEqual({});
  });

  it('raiz do writer trocada por symlink para a coordenação: recusa e não escreve na coordenação', async () => {
    fs.renameSync(worktree, `${worktree}-movido`);
    fs.symlinkSync(repo, worktree);

    await expect(tool('nexus_checkpoint_restore').handler({ ref: firstRef() }, ctx()))
      .rejects.toThrow(/identity changed|selad|coordenação/);
    await expect(tool('nexus_checkpoint_restore').handler({ ref: firstRef() }, orchestrator()))
      .rejects.toThrow(/identity changed|selad|coordenação/);
    expect(fs.existsSync(path.join(repo, 'feito.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(`${worktree}-movido`, 'feito.txt'), 'utf8')).toBe('quebrado\n');
  });

  async function checkpointWith(file: string): Promise<string> {
    fs.mkdirSync(path.dirname(path.join(worktree, file)), { recursive: true });
    fs.writeFileSync(path.join(worktree, file), 'v1\n');
    const artifact = await captureWriterHandoffCheckpoint(ctx());
    fs.writeFileSync(path.join(worktree, file), 'v2\n');
    return String(artifact?.payload.ref);
  }

  it('destinos em .context passam pela guarda de contexto versionado e nada é escrito', async () => {
    const ref = await checkpointWith('.context/notas.md');

    await expect(tool('nexus_checkpoint_restore').handler({ ref }, ctx()))
      .rejects.toThrow('versioned context authority is read-only to executors');
    expect(fs.readFileSync(path.join(worktree, '.context/notas.md'), 'utf8')).toBe('v2\n');
    expect(fs.readFileSync(path.join(worktree, 'feito.txt'), 'utf8')).toBe('quebrado\n');
  });

  it('destinos em .agents/.codex são namespace protegido e nada é escrito', async () => {
    const ref = await checkpointWith('.agents/skills/x/SKILL.md');

    await expect(tool('nexus_checkpoint_restore').handler({ ref }, orchestrator()))
      .rejects.toThrow(/namespace protegido/);
    expect(fs.readFileSync(path.join(worktree, '.agents/skills/x/SKILL.md'), 'utf8')).toBe('v2\n');
  });

  it('revoga entre o backup e a escrita: a autoridade é conferida de novo e nada é escrito', async () => {
    let calls = 0;
    const invocation = {
      assertCurrentAuthority: () => {
        calls += 1;
        if (calls === 2) throw new Error('session_authority_revoked');
      },
    } as McpToolInvocation;

    await expect(tool('nexus_checkpoint_restore').handler({ ref: firstRef() }, ctx(), invocation))
      .rejects.toThrow('session_authority_revoked');
    expect(fs.readFileSync(path.join(worktree, 'feito.txt'), 'utf8')).toBe('quebrado\n');
  });

  it('writer ocupado na árvore recusa a restauração com mensagem clara', async () => {
    h.sessions = [{ sessionId: 'session-b', cwd: worktree, scope: testProjectScope({ rootRealPath: worktree }),
      role: 'worker', readOnly: false, agentName: 'writer-b' }];
    h.idle = () => false;

    await expect(tool('nexus_checkpoint_restore').handler({ ref: firstRef() }, orchestrator()))
      .rejects.toThrow(/writer ocupado.*writer-b/);
    expect(fs.readFileSync(path.join(worktree, 'feito.txt'), 'utf8')).toBe('quebrado\n');
  });

  it('writer que volta a trabalhar depois da checagem inicial também recusa, antes de qualquer escrita', async () => {
    h.sessions = [{ sessionId: 'session-b', cwd: worktree, scope: testProjectScope({ rootRealPath: worktree }),
      role: 'worker', readOnly: false, agentName: 'writer-b' }];
    let checks = 0;
    h.idle = () => {
      checks += 1;
      return checks === 1;
    };

    await expect(tool('nexus_checkpoint_restore').handler({ ref: firstRef() }, orchestrator()))
      .rejects.toThrow(/writer ocupado/);
    expect(fs.readFileSync(path.join(worktree, 'feito.txt'), 'utf8')).toBe('quebrado\n');
    expect(git(repo, 'for-each-ref', '--format=%(refname)', 'refs/nexus-checkpoint')).toBe(firstRef());
  });

  it('o próprio writer chamando (em tool call) não conta como ocupado; lane só rotulada read-only conta (F-1157)', async () => {
    h.sessions = [
      { sessionId: 'session-a', cwd: worktree, scope: testProjectScope({ rootRealPath: worktree }), role: 'worker', readOnly: false },
      { sessionId: 'session-r', cwd: worktree, scope: testProjectScope({ rootRealPath: worktree }), role: 'worker', readOnly: true },
    ];
    h.idle = () => false;

    // Sem o Hardened, o rótulo read-only não impede escrever: a sessão ocupada
    // pode estar escrevendo e o restore recusa.
    await expect(tool('nexus_checkpoint_restore').handler({ ref: firstRef() }, ctx()))
      .rejects.toThrow(/ocupado/);

    // Lane confinada pelo Hardened nunca escreve: não conta como ocupada.
    const gate = await import('./gate');
    gate.resetGateForTests();
    gate.registerHardenedSpawnPolicy(() => true);
    try {
      const confined = gate.mintToken({ label: 'revisor', role: 'worker', missionId: 'mission-a', readOnly: true,
        scope: testProjectScope({ rootRealPath: repo }) });
      gate.bindTokenToSession(confined.token, 'session-r');
      await expect(tool('nexus_checkpoint_restore').handler({ ref: firstRef() }, ctx()))
        .resolves.toMatchObject({ applied: true });
      expect(fs.readFileSync(path.join(worktree, 'feito.txt'), 'utf8')).toBe('turno 1\n');
    } finally {
      gate.registerHardenedSpawnPolicy(() => false);
      gate.resetGateForTests();
    }
  });
});
