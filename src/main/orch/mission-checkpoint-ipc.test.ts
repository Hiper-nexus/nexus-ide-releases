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
  missions: new Set<string>(['mission-a']),
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
  getProjectDomainStores: () => ({
    missions: { get: (id: string) => (h.missions.has(id) ? { id } : undefined) },
  }),
}));
vi.mock('./mission-execution-scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./mission-execution-scope')>()),
  missionExecutionScope: (scope: ProjectExecutionScope) => ({ ...scope, rootRealPath: h.executionRoot }),
}));
vi.mock('../runtime/worktree-runtime-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../runtime/worktree-runtime-registry')>()),
  requireWorktreeRuntimeRegistry: () => ({ listMission: () => h.records }),
}));

import { registerMissionCheckpointIpc } from './mission-checkpoint-ipc';
import { captureWriterHandoffCheckpoint, missionCheckpointScopeId } from './handoff-checkpoint';
import { checkpointRefForScopeOrdinal, hiddenCheckpointIdle } from '../git/hidden-checkpoint';
import { ORCH_CHANNELS } from '../../shared/orch-channels';
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

function writerCtx(): AgentGateContext {
  return {
    token: 'token',
    label: 'writer-a',
    agentName: 'Ada',
    role: 'worker',
    missionId: 'mission-a',
    sessionId: 'session-a',
    scope: testProjectScope({ rootRealPath: repo }),
    executionScope: testProjectScope({ rootRealPath: worktree }),
    allowedTools: null,
    allowedSkills: null,
    stopAttempts: 0,
    handoffSubmitted: false,
  };
}

type Handler = (event: { sender: unknown }, raw: unknown) => Promise<any>;

/** IPC falso: guarda os handlers e deixa o teste trocar o escopo vivo do renderer. */
function harness() {
  const handlers = new Map<string, Handler>();
  const live = { scope: testProjectScope({ rootRealPath: repo }) as ProjectExecutionScope | null };
  const rendererScope = vi.fn((_owner: unknown, expected?: ProjectExecutionScope) => {
    if (!live.scope) throw new Error('renderer is unavailable');
    if (expected && expected !== live.scope) throw new Error('renderer workspace authority changed');
    return live.scope;
  });
  registerMissionCheckpointIpc(
    { handle: (channel, listener) => handlers.set(channel, listener as Handler) },
    { rendererScope },
  );
  const sender = { id: 1, isDestroyed: () => false, isCrashed: () => false };
  const call = (channel: string, raw: unknown) => handlers.get(channel)!({ sender }, raw);
  return { call, live, rendererScope };
}

beforeEach(async () => {
  temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-checkpoint-ipc-')));
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
  h.missions = new Set(['mission-a']);
  await captureWriterHandoffCheckpoint(writerCtx());
  fs.writeFileSync(path.join(worktree, 'feito.txt'), 'quebrado\n');
});

afterEach(async () => {
  await hiddenCheckpointIdle();
  fs.rmSync(temp, { recursive: true, force: true });
});

const firstRef = () => checkpointRefForScopeOrdinal(missionCheckpointScopeId('mission-a', worktree), 1);

describe('IPC de checkpoints da missão (F-1173)', () => {
  it('lista por árvore com writer, data, branch e arquivos — nunca a raiz de coordenação', async () => {
    const { call } = harness();
    const listed = await call(ORCH_CHANNELS.missionCheckpointsList, { missionId: 'mission-a' });

    expect(listed).toMatchObject({ ok: true, missionId: 'mission-a' });
    expect(listed.scopes).toHaveLength(1);
    expect(listed.scopes[0]).toMatchObject({ root: worktree, branch: 'nexus/writer-a' });
    expect(listed.scopes[0].checkpoints).toEqual([
      expect.objectContaining({
        ref: firstRef(),
        ordinal: 1,
        kind: 'turn',
        writer: 'Ada',
        changed: { files: ['feito.txt'], total: 1 },
      }),
    ]);
    expect(listed.scopes[0].checkpoints[0].createdAt).toBeGreaterThan(Date.now() - 60_000);
  });

  it('prévia não escreve; restauração escreve, guarda o estado anterior e responde o que fez', async () => {
    const { call } = harness();
    const preview = await call(ORCH_CHANNELS.missionCheckpointPreview, { missionId: 'mission-a', ref: firstRef() });
    expect(preview).toMatchObject({ ok: true, root: worktree, overwrite: { files: ['feito.txt'], total: 1 } });
    expect(fs.readFileSync(path.join(worktree, 'feito.txt'), 'utf8')).toBe('quebrado\n');

    const restored = await call(ORCH_CHANNELS.missionCheckpointRestore, { missionId: 'mission-a', ref: firstRef() });
    expect(restored).toMatchObject({ ok: true, applied: true, overwrite: { files: ['feito.txt'] } });
    expect(fs.readFileSync(path.join(worktree, 'feito.txt'), 'utf8')).toBe('turno 1\n');
    expect(git(repo, 'show', `${restored.backupRef}:feito.txt`)).toBe('quebrado');

    // A cópia de segurança aparece na lista como checkpoint novo, marcado como tal.
    const listed = await call(ORCH_CHANNELS.missionCheckpointsList, { missionId: 'mission-a' });
    expect(listed.scopes[0].checkpoints[0]).toMatchObject({ ref: restored.backupRef, kind: 'backup', writer: null });
  });

  it('recusa caminho, campo extra, ref malformada, ref de outra missão e missão de outro projeto', async () => {
    const { call } = harness();
    const foreign = checkpointRefForScopeOrdinal(missionCheckpointScopeId('mission-b', worktree), 1);

    await expect(call(ORCH_CHANNELS.missionCheckpointRestore, { missionId: 'mission-a', ref: firstRef(), cwd: repo }))
      .resolves.toEqual({ ok: false, error: 'pedido inválido' });
    await expect(call(ORCH_CHANNELS.missionCheckpointRestore, { missionId: 'mission-a', ref: 'refs/heads/main' }))
      .resolves.toEqual({ ok: false, error: 'pedido inválido' });
    await expect(call(ORCH_CHANNELS.missionCheckpointsList, worktree))
      .resolves.toEqual({ ok: false, error: 'pedido inválido' });
    await expect(call(ORCH_CHANNELS.missionCheckpointRestore, { missionId: 'mission-a', ref: foreign }))
      .resolves.toMatchObject({ ok: false, error: expect.stringMatching(/não pertence/) });
    // A ref de mission-a não vale pela mission-b, mesmo se a mission-b existir.
    h.missions.add('mission-b');
    await expect(call(ORCH_CHANNELS.missionCheckpointRestore, { missionId: 'mission-b', ref: firstRef() }))
      .resolves.toMatchObject({ ok: false, error: expect.stringMatching(/não pertence/) });
    h.missions = new Set();
    await expect(call(ORCH_CHANNELS.missionCheckpointsList, { missionId: 'mission-a' }))
      .resolves.toMatchObject({ ok: false, error: expect.stringMatching(/não encontrada/) });
    await expect(call(ORCH_CHANNELS.missionCheckpointRestore, { missionId: 'mission-a', ref: firstRef() }))
      .resolves.toMatchObject({ ok: false, error: expect.stringMatching(/não encontrada/) });
    expect(fs.readFileSync(path.join(worktree, 'feito.txt'), 'utf8')).toBe('quebrado\n');
  });

  it('renderer sem workspace vivo não lista nem restaura', async () => {
    const { call, live } = harness();
    live.scope = null;

    await expect(call(ORCH_CHANNELS.missionCheckpointsList, { missionId: 'mission-a' }))
      .resolves.toMatchObject({ ok: false, error: 'renderer is unavailable' });
    await expect(call(ORCH_CHANNELS.missionCheckpointRestore, { missionId: 'mission-a', ref: firstRef() }))
      .resolves.toMatchObject({ ok: false, error: 'renderer is unavailable' });
    expect(fs.readFileSync(path.join(worktree, 'feito.txt'), 'utf8')).toBe('quebrado\n');
  });

  it('workspace do renderer trocado no meio: autoridade conferida de novo e nada é escrito', async () => {
    const { call, live, rendererScope } = harness();
    rendererScope.mockImplementation((_owner: unknown, expected?: ProjectExecutionScope) => {
      if (expected) {
        // O renderer trocou de projeto depois de pedir a restauração.
        live.scope = testProjectScope({ rootRealPath: temp });
        throw new Error('renderer workspace authority changed');
      }
      return live.scope!;
    });

    await expect(call(ORCH_CHANNELS.missionCheckpointRestore, { missionId: 'mission-a', ref: firstRef() }))
      .resolves.toMatchObject({ ok: false, error: 'renderer workspace authority changed' });
    expect(fs.readFileSync(path.join(worktree, 'feito.txt'), 'utf8')).toBe('quebrado\n');
    expect(git(repo, 'for-each-ref', '--format=%(refname)', 'refs/nexus-checkpoint')).toBe(firstRef());
  });

  it('writer ocupado na árvore recusa (o operador não é sessão: toda sessão ocupada conta)', async () => {
    const { call } = harness();
    h.sessions = [{ sessionId: 'session-a', cwd: worktree, scope: testProjectScope({ rootRealPath: worktree }),
      role: 'worker', readOnly: false, agentName: 'Ada' }];
    h.idle = () => false;

    await expect(call(ORCH_CHANNELS.missionCheckpointRestore, { missionId: 'mission-a', ref: firstRef() }))
      .resolves.toMatchObject({ ok: false, error: expect.stringMatching(/writer ocupado.*Ada/) });
    expect(fs.readFileSync(path.join(worktree, 'feito.txt'), 'utf8')).toBe('quebrado\n');
  });

  it('destinos em .agents/.codex e .context passam pelas mesmas guardas da ferramenta MCP', async () => {
    const { call } = harness();
    fs.mkdirSync(path.join(worktree, '.context'), { recursive: true });
    fs.writeFileSync(path.join(worktree, '.context/notas.md'), 'v1\n');
    const artifact = await captureWriterHandoffCheckpoint(writerCtx());
    fs.writeFileSync(path.join(worktree, '.context/notas.md'), 'v2\n');

    await expect(call(ORCH_CHANNELS.missionCheckpointRestore, { missionId: 'mission-a', ref: String(artifact?.payload.ref) }))
      .resolves.toMatchObject({ ok: false, error: 'versioned context authority is read-only to executors' });
    expect(fs.readFileSync(path.join(worktree, '.context/notas.md'), 'utf8')).toBe('v2\n');

    fs.mkdirSync(path.join(worktree, '.agents/skills/x'), { recursive: true });
    fs.writeFileSync(path.join(worktree, '.agents/skills/x/SKILL.md'), 'v1\n');
    const control = await captureWriterHandoffCheckpoint(writerCtx());
    fs.writeFileSync(path.join(worktree, '.agents/skills/x/SKILL.md'), 'v2\n');
    await expect(call(ORCH_CHANNELS.missionCheckpointRestore, { missionId: 'mission-a', ref: String(control?.payload.ref) }))
      .resolves.toMatchObject({ ok: false, error: expect.stringMatching(/namespace protegido/) });
    expect(fs.readFileSync(path.join(worktree, '.agents/skills/x/SKILL.md'), 'utf8')).toBe('v2\n');
  });

  it('raiz da worktree trocada por symlink para a coordenação: lista marca indisponível e não restaura', async () => {
    const { call } = harness();
    fs.renameSync(worktree, `${worktree}-movido`);
    fs.symlinkSync(repo, worktree);

    const listed = await call(ORCH_CHANNELS.missionCheckpointsList, { missionId: 'mission-a' });
    expect(listed.scopes[0]).toMatchObject({ root: worktree, checkpoints: [], unavailable: expect.any(String) });
    await expect(call(ORCH_CHANNELS.missionCheckpointRestore, { missionId: 'mission-a', ref: firstRef() }))
      .resolves.toMatchObject({ ok: false });
    expect(fs.existsSync(path.join(repo, 'feito.txt'))).toBe(false);
  });
});
