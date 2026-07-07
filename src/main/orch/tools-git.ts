import type { McpToolDef } from './mcp-protocol';
import { requireStr, str } from './tool-util';
import { exec } from 'node:child_process';
import { activeWorkspaceOrNull } from '../persistence/workspace-store';

/**
 * Git operations MCP tools for Jarvis agent.
 * All commands run in the workspace directory.
 */

function gitExec(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    exec(
      `git ${args.join(' ')}`,
      { cwd, timeout: 30000, maxBuffer: 5 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr || err.message));
        } else {
          resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
        }
      },
    );
  });
}

function resolveCwd(cwdOverride?: string): string {
  return cwdOverride ?? activeWorkspaceOrNull() ?? process.cwd();
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
  handler: async (args) => {
    const cwd = resolveCwd(str(args, 'cwd'));
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
  handler: async (args) => {
    const cwd = resolveCwd(str(args, 'cwd'));
    const paths = Array.isArray(args.paths) && args.paths.length > 0
      ? args.paths.filter((p): p is string => typeof p === 'string')
      : ['.'];
    const { stdout } = await gitExec(['add', ...paths], cwd);
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
  handler: async (args) => {
    const cwd = resolveCwd(str(args, 'cwd'));
    const message = requireStr(args, 'message');
    const { stdout } = await gitExec(['commit', '-m', JSON.stringify(message)], cwd);
    return { cwd, output: stdout };
  },
};

const gitPush: McpToolDef = {
  name: 'nexus_git_push',
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
  handler: async (args) => {
    const cwd = resolveCwd(str(args, 'cwd'));
    const remote = str(args, 'remote') ?? 'origin';
    const branch = str(args, 'branch');
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
  handler: async (args) => {
    const cwd = resolveCwd(str(args, 'cwd'));
    const remote = str(args, 'remote') ?? 'origin';
    const branch = str(args, 'branch');
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
  handler: async (args) => {
    const cwd = resolveCwd(str(args, 'cwd'));
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
  handler: async (args) => {
    const cwd = resolveCwd(str(args, 'cwd'));
    const count = Math.min(
      typeof args.count === 'number' ? args.count : 10,
      100,
    );
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
  handler: async (args) => {
    const cwd = resolveCwd(str(args, 'cwd'));
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
  handler: async (args) => {
    const cwd = resolveCwd(str(args, 'cwd'));
    const name = requireStr(args, 'name');
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
  handler: async (args) => {
    const cwd = resolveCwd(str(args, 'cwd'));
    const name = requireStr(args, 'name');
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