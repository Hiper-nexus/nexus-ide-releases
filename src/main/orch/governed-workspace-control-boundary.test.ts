import { describe, expect, it } from 'vitest';
import {
  assertGovernedWorkspaceControlBoundary,
  pathTargetsCodexControlRoot,
} from './governed-workspace-control-boundary';

const governedWorker = {
  role: 'worker' as const,
  missionId: 'mission-a',
  readOnly: false,
  governedNativeProvider: 'codex' as const,
};

describe('governed workspace control boundary', () => {
  it.each([
    '.agents/skills/new/SKILL.md',
    'packages/app/.codex/skills/new/SKILL.md',
    String.raw`packages\app\.AGENTS\skills\new\SKILL.md`,
    'safe/../.CoDeX/config.toml',
  ])('recognizes a Codex discovery control segment in %s', (candidate) => {
    expect(pathTargetsCodexControlRoot(candidate)).toBe(true);
    expect(() =>
      assertGovernedWorkspaceControlBoundary(
        governedWorker,
        'nexus_file_write',
        [candidate],
      ),
    ).toThrow(/Codex control path/i);
  });

  it('does not confuse similarly named ordinary source paths', () => {
    expect(pathTargetsCodexControlRoot('src/codex/client.ts')).toBe(false);
    expect(pathTargetsCodexControlRoot('.agents-notes/readme.md')).toBe(false);
    expect(() =>
      assertGovernedWorkspaceControlBoundary(
        governedWorker,
        'nexus_file_write',
        ['src/codex/client.ts'],
      ),
    ).not.toThrow();
  });

  it.each([
    'nexus_terminal_run',
    'nexus_bg_run',
    'nexus_git_add',
    'nexus_git_commit',
    'nexus_git_pull',
    'nexus_git_branch_switch',
  ])('denies main-owned %s outside the inherited Codex sandbox', (tool) => {
    expect(() =>
      assertGovernedWorkspaceControlBoundary(governedWorker, tool),
    ).toThrow(/outside the inherited Codex process sandbox/i);
  });

  it('preserves direct-user and read-only observation flows', () => {
    expect(() =>
      assertGovernedWorkspaceControlBoundary(
        { role: 'user', readOnly: false },
        'nexus_terminal_run',
        ['.agents/skills/new/SKILL.md'],
      ),
    ).not.toThrow();
    expect(() =>
      assertGovernedWorkspaceControlBoundary(
        { ...governedWorker, readOnly: true },
        'nexus_file_read',
        ['.agents/skills/existing/SKILL.md'],
      ),
    ).not.toThrow();
  });

  it('does not apply the Codex-only boundary to another provider worker', () => {
    expect(() =>
      assertGovernedWorkspaceControlBoundary(
        {
          role: 'worker',
          missionId: 'mission-standard',
          readOnly: false,
        },
        'nexus_terminal_run',
        ['.agents/skills/provider-owned/SKILL.md'],
      ),
    ).not.toThrow();
  });
});
