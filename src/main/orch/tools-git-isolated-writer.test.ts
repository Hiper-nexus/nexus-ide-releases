import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentGateContext } from './gate';
import { testProjectScope } from './__tests__/scope-fixture';

// Never execute git, including setup and authority probes.
const h = vi.hoisted(() => ({ run: vi.fn(), records: [] as Array<Record<string, unknown>> }));
vi.mock('../runtime/git-command', () => ({
  ProcessGitRunner: class { run = h.run; },
  assertSafeLocalGitConfig: vi.fn(),
}));
vi.mock('../runtime/worktree-runtime-registry', () => ({
  requireWorktreeRuntimeRegistry: () => ({ listMission: () => h.records }),
}));
import { buildGitTools } from './tools-git';

let temp: string;
let root: string;
let ctx: AgentGateContext;
beforeEach(() => {
  temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'isolated-git-policy-')));
  root = path.join(temp, 'writer');
  fs.mkdirSync(root);
  ctx = { token: 'test', label: 'writer', role: 'worker', missionId: 'm',
    scope: testProjectScope({ rootRealPath: temp }), executionScope: testProjectScope({ rootRealPath: root }),
    allowedTools: null, allowedSkills: null, stopAttempts: 0, handoffSubmitted: false };
  h.records = [{ missionId: 'm', worktreePath: root, branchRef: 'refs/heads/nexus/writer', status: 'ready' }];
  h.run.mockReset().mockImplementation((_cwd: string, args: string[]) => ({
    status: 0, stderr: '', stdout: args[0] === 'symbolic-ref' ? 'refs/heads/nexus/writer\n'
      : args[0] === 'rev-parse' ? root : 'ok',
  }));
});
afterEach(() => fs.rmSync(temp, { recursive: true, force: true }));
function tool(name: string) { return buildGitTools().find((t) => t.name === `nexus_git_${name}`)!; }

describe('isolated writer MCP Git policy', () => {
  it.each(['push', 'pull', 'sync', 'branch_create', 'branch_switch', 'branch_list'])('denies %s before any git execution', async (name) => {
    await expect(tool(name).handler({ name: 'other', remote: 'origin' }, ctx)).rejects.toThrow(/isolated_worktree/);
    expect(h.run).not.toHaveBeenCalled();
  });
  it.each(['status', 'diff', 'log', 'add', 'commit'])('allows %s only on the allocated worktree branch', async (name) => {
    await tool(name).handler({ message: 'Worker change', paths: ['.'] }, ctx);
    expect(h.run).toHaveBeenCalledWith(root, ['symbolic-ref', '--quiet', 'HEAD']);
    expect(h.run.mock.calls.every(([cwd]) => cwd === root)).toBe(true);
    expect(h.run.mock.calls.at(-1)?.[1][0]).toBe(name);
  });
  it('refuses detached/changed HEAD, nested repositories and missing allocations', async () => {
    for (const probe of ['symbolic-ref', 'rev-parse']) {
      h.run.mockImplementation((_cwd: string, args: string[]) => ({ status: 0, stderr: '',
        stdout: args[0] === probe ? 'foreign' : args[0] === 'symbolic-ref' ? 'refs/heads/nexus/writer' : root }));
      await expect(tool('commit').handler({ message: 'No' }, ctx)).rejects.toThrow(/isolated_worktree/);
      expect(h.run.mock.calls.some(([, args]) => args[0] === 'commit')).toBe(false);
    }
    h.run.mockClear(); h.records = [];
    await expect(tool('status').handler({}, ctx)).rejects.toThrow(/isolated_worktree/);
    expect(h.run).not.toHaveBeenCalled();
  });
  it('rejects cwd escape and absolute/traversal/magic/symlink pathspec escape', async () => {
    await expect(tool('status').handler({ cwd: temp }, ctx)).rejects.toThrow(/escapes workspace/);
    fs.symlinkSync(temp, path.join(root, 'escape'));
    for (const file of ['../outside', path.join(temp, 'outside'), ':(top)../outside', 'escape/outside']) {
      await expect(tool('add').handler({ paths: [file] }, ctx)).rejects.toThrow();
    }
    expect(h.run.mock.calls.some(([, args]) => args[0] === 'add')).toBe(false);
  });
  it('retains the existing user policy', async () => {
    await tool('branch_create').handler({ name: 'feature' }, { ...ctx, role: 'user' });
    expect(h.run.mock.calls.at(-1)?.[1]).toEqual(['branch', 'feature']);
  });
});
