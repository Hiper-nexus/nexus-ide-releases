import type { McpToolDef } from './mcp-protocol';
import { requireStr, str } from './tool-util';
import { resolveCwdForScope } from './workspace-path';
import type { ProjectExecutionScope } from '../../shared/types';
import { executionScopeFor } from './gate';
import {
  assertSafeLocalGitConfig,
  ProcessGitRunner,
} from '../runtime/git-command';

/**
 * Git operations MCP tools for Jarvis agent.
 * All commands run in the workspace directory.
 */

const gitRunner = new ProcessGitRunner();

function gitExec(
  args: readonly string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  assertSafeLocalGitConfig(gitRunner, cwd);
  const result = gitRunner.run(cwd, args);
  return Promise.resolve({
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  });
}

function resolveCwd(
  scope: ProjectExecutionScope,
  cwdOverride?: string,
): string {
  return resolveCwdForScope(scope, cwdOverride);
}

const DANGEROUS_PUSH_FLAGS = [
  '--force',
  '--delete',
  '--mirror',
  '-f',
  '-d',
  '--force-with-lease',
];

function assertNoControlChars(value: string, label: string): void {
  if (/[\0\r\n]/.test(value)) {
    throw new Error(`${label} contains control characters`);
  }
}

function assertNoLeadingDash(value: string, label: string): void {
  if (value.startsWith('-')) {
    throw new Error(`${label} cannot start with '-'`);
  }
}

function assertSafeGitName(value: string, label: string): void {
  assertNoControlChars(value, label);
  assertNoLeadingDash(value, label);
}

function assertSafeGitPathspec(value: string): void {
  assertNoControlChars(value, 'pathspec');
  assertNoLeadingDash(value, 'pathspec');
}

function assertSafePushArg(value: string, label: string): void {
  assertSafeGitName(value, label);
  const lowered = value.toLowerCase();
  if (
    DANGEROUS_PUSH_FLAGS.some(
      (flag) => lowered === flag || lowered.startsWith(`${flag}=`),
    )
  ) {
    throw new Error(`${label} uses blocked push flag: ${value}`);
  }
}

function assertSafePushBranch(value: string): void {
  assertSafePushArg(value, 'branch');
  if (value.startsWith(':')) {
    throw new Error('branch uses delete refspec syntax');
  }
  if (value.startsWith('+')) {
    throw new Error('branch uses force refspec syntax');
  }
  if (value.includes(':')) {
    throw new Error('branch refspec syntax is not allowed');
  }
}

function assertSafeRemoteUrl(value: string): void {
  assertNoControlChars(value, 'remote URL');
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):[^\s]+$/.exec(value);
  if (scp) {
    if (scp[1].startsWith('-')) throw new Error('remote URL has an unsafe host');
    return;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('remote URL must use HTTPS or SSH');
  }
  if (!['https:', 'ssh:'].includes(url.protocol)) {
    throw new Error('remote URL must use HTTPS or SSH');
  }
  if (!url.hostname || url.hostname.startsWith('-') || url.password) {
    throw new Error('remote URL contains unsafe credentials or host');
  }
}

async function assertSafeConfiguredRemote(
  cwd: string,
  remote: string,
): Promise<void> {
  const { stdout } = await gitExec(['remote', 'get-url', remote], cwd);
  assertSafeRemoteUrl(stdout);
}

const gitStatus: McpToolDef = {
  name: 'nexus_git_status',
  description:
    'Show the working tree status: modified, staged, untracked files, and ' +
    'current branch. Equivalent to `git status --short`.',
  inputSchema: {
    type: 'object',
    properties: {
      cwd: {
        type: 'string',
        description: 'Working directory (defaults to workspace root)',
      },
    },
  },
  handler: async (args, ctx) => {
    const cwd = resolveCwd(executionScopeFor(ctx), str(args, 'cwd'));
    const { stdout } = await gitExec(['status', '--short', '--branch'], cwd);
    return { cwd, output: stdout };
  },
};

const gitAdd: McpToolDef = {
  name: 'nexus_git_add',
  description:
    'Stage files for commit. Pass paths (relative to workspace) or "." ' +
    'to stage everything. Equivalent to `git add <paths...>`.',
  inputSchema: {
    type: 'object',
    properties: {
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'File paths to stage (default: ["."])',
      },
      cwd: {
        type: 'string',
        description: 'Working directory (defaults to workspace root)',
      },
    },
  },
  handler: async (args, ctx) => {
    const cwd = resolveCwd(executionScopeFor(ctx), str(args, 'cwd'));
    const paths = Array.isArray(args.paths) && args.paths.length > 0
      ? args.paths.filter((p): p is string => typeof p === 'string')
      : ['.'];
    paths.forEach(assertSafeGitPathspec);
    const { stdout } = await gitExec(['add', '--', ...paths], cwd);
    return { cwd, staged: paths, output: stdout || 'ok' };
  },
};

const gitCommit: McpToolDef = {
  name: 'nexus_git_commit',
  description:
    'Record changes to the repository with a message. ' +
    'Equivalent to `git commit -m "<message>"`.',
  inputSchema: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'Commit message',
      },
      cwd: {
        type: 'string',
        description: 'Working directory (defaults to workspace root)',
      },
    },
    required: ['message'],
  },
  handler: async (args, ctx) => {
    const cwd = resolveCwd(executionScopeFor(ctx), str(args, 'cwd'));
    const message = requireStr(args, 'message');
    const { stdout } = await gitExec(['commit', '-m', message], cwd);
    return { cwd, output: stdout };
  },
};

const gitPush: McpToolDef = {
  name: 'nexus_git_push',
  requiresConfirm: true,
  description:
    'Update remote refs along with associated objects. ' +
    'Equivalent to `git push`. Force push (--force) is BLOCKED by guardrails.',
  inputSchema: {
    type: 'object',
    properties: {
      remote: {
        type: 'string',
        description: 'Remote name (default: origin)',
      },
      branch: {
        type: 'string',
        description: 'Branch name (default: current branch)',
      },
      cwd: {
        type: 'string',
        description: 'Working directory (defaults to workspace root)',
      },
    },
  },
  handler: async (args, ctx) => {
    const cwd = resolveCwd(executionScopeFor(ctx), str(args, 'cwd'));
    const remote = str(args, 'remote') ?? 'origin';
    const branch = str(args, 'branch');
    assertSafePushArg(remote, 'remote');
    if (branch) assertSafePushBranch(branch);
    await assertSafeConfiguredRemote(cwd, remote);
    const cmdArgs = ['push', remote];
    if (branch) cmdArgs.push(branch);
    const { stdout } = await gitExec(cmdArgs, cwd);
    return { cwd, remote, branch: branch || 'current', output: stdout };
  },
};

const gitPull: McpToolDef = {
  name: 'nexus_git_pull',
  description:
    'Fetch from and integrate with another repository or a local branch. ' +
    'Equivalent to `git pull`.',
  inputSchema: {
    type: 'object',
    properties: {
      remote: {
        type: 'string',
        description: 'Remote name (default: origin)',
      },
      branch: {
        type: 'string',
        description: 'Branch name (default: current tracking branch)',
      },
      rebase: {
        type: 'boolean',
        description: 'Use rebase instead of merge (default: false)',
      },
      cwd: {
        type: 'string',
        description: 'Working directory (defaults to workspace root)',
      },
    },
  },
  handler: async (args, ctx) => {
    const cwd = resolveCwd(executionScopeFor(ctx), str(args, 'cwd'));
    const remote = str(args, 'remote') ?? 'origin';
    const branch = str(args, 'branch');
    assertSafeGitName(remote, 'remote');
    if (branch) assertSafeGitName(branch, 'branch');
    await assertSafeConfiguredRemote(cwd, remote);
    const cmdArgs = ['pull'];
    if (args.rebase === true) cmdArgs.push('--rebase');
    cmdArgs.push(remote);
    if (branch) cmdArgs.push(branch);
    const { stdout } = await gitExec(cmdArgs, cwd);
    return { cwd, output: stdout };
  },
};

const gitDiff: McpToolDef = {
  name: 'nexus_git_diff',
  description:
    'Show changes between commits, commit and working tree, etc. ' +
    'Equivalent to `git diff`. Pass "staged" or "cached" to show staged changes.',
  inputSchema: {
    type: 'object',
    properties: {
      staged: {
        type: 'boolean',
        description: 'Show staged changes (equivalent to --cached)',
      },
      cwd: {
        type: 'string',
        description: 'Working directory (defaults to workspace root)',
      },
    },
  },
  handler: async (args, ctx) => {
    const cwd = resolveCwd(executionScopeFor(ctx), str(args, 'cwd'));
    const cmdArgs = ['diff'];
    if (args.staged === true) cmdArgs.push('--cached');
    const { stdout } = await gitExec(cmdArgs, cwd);
    return { cwd, diff: stdout };
  },
};

const gitLog: McpToolDef = {
  name: 'nexus_git_log',
  description:
    'Show commit logs. Returns the last N commits (default 10) in ' +
    'one-line format. Equivalent to `git log --oneline -n <count>`.',
  inputSchema: {
    type: 'object',
    properties: {
      count: {
        type: 'number',
        description: 'Number of commits to show (default: 10, max: 100)',
      },
      cwd: {
        type: 'string',
        description: 'Working directory (defaults to workspace root)',
      },
    },
  },
  handler: async (args, ctx) => {
    const cwd = resolveCwd(executionScopeFor(ctx), str(args, 'cwd'));
    const rawCount = typeof args.count === 'number' ? args.count : 10;
    const count = Number.isInteger(rawCount) && rawCount > 0
      ? Math.min(rawCount, 100)
      : 10;
    const { stdout } = await gitExec(
      ['log', '--oneline', '-n', String(count)],
      cwd,
    );
    return { cwd, count, commits: stdout.split('\n').filter(Boolean) };
  },
};

const gitBranchList: McpToolDef = {
  name: 'nexus_git_branch_list',
  description:
    'List local branches. The current branch is marked with "*". ' +
    'Equivalent to `git branch`.',
  inputSchema: {
    type: 'object',
    properties: {
      cwd: {
        type: 'string',
        description: 'Working directory (defaults to workspace root)',
      },
    },
  },
  handler: async (args, ctx) => {
    const cwd = resolveCwd(executionScopeFor(ctx), str(args, 'cwd'));
    const { stdout } = await gitExec(['branch'], cwd);
    const branches = stdout.split('\n').map((b) => b.trim()).filter(Boolean);
    const current = branches.find((b) => b.startsWith('*'))?.replace('* ', '') ?? null;
    return { cwd, current, branches: branches.map((b) => b.replace('* ', '')) };
  },
};

const gitBranchCreate: McpToolDef = {
  name: 'nexus_git_branch_create',
  description:
    'Create a new branch. Equivalent to `git branch <name>`.',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Name for the new branch',
      },
      cwd: {
        type: 'string',
        description: 'Working directory (defaults to workspace root)',
      },
    },
    required: ['name'],
  },
  handler: async (args, ctx) => {
    const cwd = resolveCwd(executionScopeFor(ctx), str(args, 'cwd'));
    const name = requireStr(args, 'name');
    assertSafeGitName(name, 'branch');
    const { stdout } = await gitExec(['branch', name], cwd);
    return { cwd, branch: name, output: stdout || 'created' };
  },
};

const gitBranchSwitch: McpToolDef = {
  name: 'nexus_git_branch_switch',
  description:
    'Switch to an existing branch. Equivalent to `git checkout <name>` ' +
    '(or `git switch <name>`).',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Branch name to switch to',
      },
      cwd: {
        type: 'string',
        description: 'Working directory (defaults to workspace root)',
      },
    },
    required: ['name'],
  },
  handler: async (args, ctx) => {
    const cwd = resolveCwd(executionScopeFor(ctx), str(args, 'cwd'));
    const name = requireStr(args, 'name');
    assertSafeGitName(name, 'branch');
    const { stdout } = await gitExec(['checkout', name], cwd);
    return { cwd, branch: name, output: stdout };
  },
};

export function buildGitTools(): McpToolDef[] {
  return [
    gitStatus,
    gitAdd,
    gitCommit,
    gitPush,
    gitPull,
    gitDiff,
    gitLog,
    gitBranchList,
    gitBranchCreate,
    gitBranchSwitch,
  ];
}
