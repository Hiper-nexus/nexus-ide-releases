/**
 * F-1480: a troca de conta não solta o writer isolado. Quando o failover
 * aposenta a sessão exausta com o pane novo vivo na MESMA worktree, o registro
 * segue pronto e é a saída do pane NOVO que libera e ganha o commit de
 * salvaguarda em `refs/nexus-salvage` — Git e registry reais.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneSnapshot } from '../../shared/orch-types';
import type { OwnedAgentSessionInfo, SessionExitTap, SessionTerminationTap } from '../pty/pty-manager';

vi.mock('../license-access', async () => (await import('../__tests__/licensed-access')).licensedAccessMock);
const h = vi.hoisted(() => ({
  exits: new Set<SessionExitTap>(),
  terminations: new Set<SessionTerminationTap>(),
  origins: new Map<string, string>(),
  panes: [] as PaneSnapshot[],
}));
vi.mock('../pty/pty-manager', async (original) => ({
  ...(await original<typeof import('../pty/pty-manager')>()),
  tapSessionExit: (tap: SessionExitTap) => { h.exits.add(tap); return () => h.exits.delete(tap); },
  tapSessionTermination: (tap: SessionTerminationTap) => {
    h.terminations.add(tap);
    return () => h.terminations.delete(tap);
  },
  getRequestedTerminationOrigin: (sessionId: string) => h.origins.get(sessionId) ?? null,
}));
vi.mock('./pane-registry', async (original) => ({
  ...(await original<typeof import('./pane-registry')>()),
  listPaneSnapshots: () => h.panes,
  isPaneSpawnPending: () => false,
  getPaneRuntimeAuthorityBySession: () => null,
}));
vi.mock('../runtime/worktree-pty-sweep', async (original) => ({
  ...(await original<typeof import('../runtime/worktree-pty-sweep')>()),
  worktreeHasLiveSession: (worktreePath: string) => h.panes.some((pane) =>
    pane.state !== 'exited' && pane.executionScope?.rootRealPath === worktreePath),
}));
vi.mock('../observability/main-trace', () => ({ trace: () => undefined }));

import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { configureWorktreeRuntimeRegistry, disposeWorktreeRuntimeRegistry } from '../runtime/worktree-runtime-registry';
import { testProjectScope } from './__tests__/scope-fixture';
import {
  OPERATOR_HAND_WORKTREE_KEY,
  allocateIsolatedWriterWorktree,
  operatorHandGcIdle,
  type IsolatedWriterAllocation,
} from './isolated-writer-worktree';
import { worktreeSalvageIdle } from './isolated-writer-salvage';
import { FAILOVER_RESPAWN_TERMINATION_ORIGIN, settleFailoverRetirement } from './failover-retirement';

let temp: string;
let manager: ProjectRuntimeManager;
let registry: ReturnType<typeof configureWorktreeRuntimeRegistry>;
let scope: ReturnType<typeof testProjectScope>;
let allocation: IsolatedWriterAllocation;

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}
function agent(sessionId: string): OwnedAgentSessionInfo {
  return { sessionId, adapterId: 'claude', cwd: allocation.worktreePath,
    scope: { ...scope, rootRealPath: allocation.worktreePath }, source: 'pending', role: 'worker',
    readOnly: false, allowedTools: [], allowedSkills: null } as OwnedAgentSessionInfo;
}
function terminate(sessionId: string, origin: string): void {
  h.origins.set(sessionId, origin);
  for (const tap of [...h.terminations]) tap(sessionId, agent(sessionId), null);
}
function exit(sessionId: string): void {
  for (const tap of [...h.exits]) tap(sessionId, agent(sessionId));
}
function writer() {
  return registry.listMission(scope, OPERATOR_HAND_WORKTREE_KEY)[0]!;
}
function salvageRefs(): string[] {
  return git(scope.rootRealPath, 'for-each-ref', '--format=%(refname)', 'refs/nexus-salvage')
    .split('\n').filter(Boolean);
}

beforeEach(async () => {
  h.exits.clear();
  h.terminations.clear();
  h.origins.clear();
  temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-f1480-writer-')));
  const root = path.join(temp, 'repo');
  fs.mkdirSync(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Nexus Test');
  git(root, 'config', 'user.email', 'nexus@example.test');
  fs.writeFileSync(path.join(root, 'base.txt'), 'committed\n');
  git(root, 'add', 'base.txt');
  git(root, 'commit', '-qm', 'base');
  scope = testProjectScope({ rootRealPath: root });
  manager = new ProjectRuntimeManager({ baseDir: path.join(temp, 'runtime'), appVersion: 'test' });
  registry = configureWorktreeRuntimeRegistry(manager);
  allocation = await allocateIsolatedWriterWorktree(scope, undefined);
  allocation.link('old-pane', 'old-session');
  const executionScope = { ...scope, rootRealPath: allocation.worktreePath };
  h.panes = [
    { paneId: 'new-pane', sessionId: 'new-session', kind: 'cli-agent', title: 'writer', state: 'busy',
      role: 'worker', scope, executionScope } as PaneSnapshot,
  ];
  // Trabalho não commitado do writer, no meio da troca de conta.
  fs.writeFileSync(path.join(allocation.worktreePath, 'base.txt'), 'worker change\n');
});

afterEach(async () => {
  h.panes = [];
  await operatorHandGcIdle();
  await worktreeSalvageIdle();
  disposeWorktreeRuntimeRegistry();
  manager.closeAll();
  fs.rmSync(temp, { recursive: true, force: true });
});

describe('F-1480: troca de conta não solta o writer isolado', () => {
  it('pane novo vivo: a saída da velha não marca failed; a saída do pane novo libera e salva', async () => {
    terminate('old-session', FAILOVER_RESPAWN_TERMINATION_ORIGIN);
    exit('old-session');
    settleFailoverRetirement('old-session', true);
    await worktreeSalvageIdle();
    expect(writer().status).toBe('ready');
    expect(salvageRefs()).toEqual([]);

    exit('new-session');
    await worktreeSalvageIdle();
    expect(writer().status).toBe('failed');
    const refs = salvageRefs();
    expect(refs).toHaveLength(1);
    expect(git(scope.rootRealPath, 'show', `${refs[0]}:base.txt`)).toBe('worker change');
    expect(writer().sessionIds).toContain('new-session');
  });

  it('veredito antes da saída (terminação sem prova) também mantém o writer com o pane novo', async () => {
    terminate('old-session', FAILOVER_RESPAWN_TERMINATION_ORIGIN);
    settleFailoverRetirement('old-session', true);
    exit('old-session');
    await worktreeSalvageIdle();
    expect(writer().status).toBe('ready');
    exit('new-session');
    await worktreeSalvageIdle();
    expect(writer().status).toBe('failed');
    expect(salvageRefs()).toHaveLength(1);
  });

  it('sem pane novo (respawn falhou), a saída da velha libera e salva como sempre', async () => {
    terminate('old-session', FAILOVER_RESPAWN_TERMINATION_ORIGIN);
    exit('old-session');
    expect(writer().status).toBe('ready');
    settleFailoverRetirement('old-session', false);
    await worktreeSalvageIdle();
    expect(writer().status).toBe('failed');
    expect(salvageRefs()).toHaveLength(1);
  });

  it('fechamento comum (outra origem) segue liberando na saída', async () => {
    terminate('old-session', 'pane-close');
    exit('old-session');
    await worktreeSalvageIdle();
    expect(writer().status).toBe('failed');
    expect(salvageRefs()).toHaveLength(1);
  });
});
