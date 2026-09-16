import { describe, expect, it, vi } from 'vitest';
import type { AgentGateContext } from './gate';
import { testProjectScope } from './__tests__/scope-fixture';
const h = vi.hoisted(() => ({ spawn: vi.fn(), git: vi.fn(), sandbox: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: h.spawn, execFile: vi.fn(), execFileSync: vi.fn(), exec: vi.fn(), execSync: vi.fn(), spawnSync: vi.fn() }));
vi.mock('./workspace-path', () => ({ resolveCwdForScope: vi.fn(), isInsidePath: vi.fn() }));
vi.mock('../persistence/settings-store', () => ({ getOrchSettings: vi.fn() }));
vi.mock('../runtime/process-sandbox', () => ({ createScopedSandboxHome: h.sandbox, buildScopedShellPlan: vi.fn() }));
vi.mock('./tools-git', () => ({ buildGitTools: () => ['status', 'add', 'commit', 'diff', 'log'].map((name) => ({ name: `nexus_git_${name}`, handler: h.git })) }));
import { buildTerminalTools } from './tools-terminal';
import { buildBgTools } from './tools-bg';
import { parseIsolatedWriterGitCommand, assertIsolatedWriterGitTool } from './isolated-writer-policy';
const scope = testProjectScope({ rootRealPath: '/coordinator' });
const ctx: AgentGateContext = { token: 't', label: 'writer', role: 'worker', missionId: 'm', scope,
  executionScope: { ...scope, rootRealPath: '/writer' }, allowedTools: null, allowedSkills: null, stopAttempts: 0, handoffSubmitted: false };

describe('isolated writer terminal execution policy', () => {
  it('also denies the background shell sibling for isolated writers of every provider', async () => {
    for (const governedNativeProvider of [undefined, 'codex'] as const) {
      await expect(buildBgTools()[0].handler({ command: 'git push' }, { ...ctx, governedNativeProvider }))
        .rejects.toThrow(/isolated_worktree/);
    }
    expect(h.spawn).not.toHaveBeenCalled();
  });
  it.each(['push', 'pull', 'stash', 'checkout', 'reset', 'clean'])('rejects %s through shell spellings before spawning anything', async (command) => {
    for (const shell of [
      `git ${command}`, `git -C /writer ${command}`, `git status && git ${command}`,
      `echo ready; git ${command}`, `sh -c 'git ${command}'`, `/usr/bin/git ${command}`,
      `env git ${command}`, `git -c alias.x=${command} x`,
    ]) {
      await expect(buildTerminalTools()[0].handler({ command: shell }, ctx)).rejects.toThrow(/isolated_worktree/);
    }
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.sandbox).not.toHaveBeenCalled();
    expect(h.git).not.toHaveBeenCalled();
    expect(() => assertIsolatedWriterGitTool(ctx, `nexus_git_${command}`)).toThrow(/isolated_worktree/);
  });
  it.each(['sh -c "git status"', 'node -e "exec(\'git push\')"', 'npm run opaque-script', 'git $(echo push)', 'git status > file', 'git status\ngit push'])('refuses opaque shell execution: %s', (command) => {
    expect(() => parseIsolatedWriterGitCommand(command, '/writer')).toThrow(/nexus_git_/);
  });
  it('parses literal safe Git argv without ever evaluating shell syntax', () => {
    expect(parseIsolatedWriterGitCommand('git -C "src dir" add -- "file name.ts"', '/writer')).toEqual({ tool: 'nexus_git_add', args: { cwd: '/writer/src dir', paths: ['file name.ts'] } });
    expect(parseIsolatedWriterGitCommand('git commit -m "fix; git push is text"', '/writer')).toEqual({ tool: 'nexus_git_commit', args: { cwd: '/writer', message: 'fix; git push is text' } });
    expect(parseIsolatedWriterGitCommand('git diff --cached', '/writer').args).toMatchObject({ staged: true });
    expect(parseIsolatedWriterGitCommand('git log -n 5', '/writer').args).toMatchObject({ count: 5 });
  });
  it('routes a permitted terminal Git operation through the protected MCP handler', async () => {
    h.git.mockResolvedValueOnce({ output: '## own-branch' });
    await expect(buildTerminalTools()[0].handler({ command: 'git status' }, ctx)).resolves.toMatchObject({ exitCode: 0, stdout: '## own-branch' });
    expect(h.git).toHaveBeenCalledWith({ cwd: '/writer' }, ctx, undefined);
    expect(h.spawn).not.toHaveBeenCalled();
  });
});
