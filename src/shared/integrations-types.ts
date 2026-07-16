/**
 * External integrations surface (GitHub / Linear / diff annotations / SSH ops).
 * Secret-free types only — tokens never cross to the renderer.
 */
import { z } from 'zod';
import { assertSafeGitPathspec } from './git-scm';

export type {
  GitCommitResult,
  GitFileChange,
  GitFileDiffResult,
  GitLogEntry,
  GitLogResult,
  GitMutateResult,
  GitScmSnapshot,
  GitStatusResult,
} from './git-scm';

function safePathspec(value: string, ctx: z.RefinementCtx): void {
  try {
    assertSafeGitPathspec(value);
  } catch (err) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: err instanceof Error ? err.message : 'invalid pathspec',
    });
  }
}

export const INTEGRATIONS_CHANNELS = {
  forgeCreatePr: 'integrations:forge.createPr',
  forgeListPrs: 'integrations:forge.listPrs',
  /** PR/MR aberto para a branch atual (read-side da camada forge). */
  forgeBranchReview: 'integrations:forge.branchReview',
  githubListIssues: 'integrations:github.listIssues',
  linearListIssues: 'integrations:linear.listIssues',
  linearSetKey: 'integrations:linear.setKey',
  gitDiff: 'integrations:git.diff',
  gitStatus: 'integrations:git.status',
  gitStage: 'integrations:git.stage',
  gitUnstage: 'integrations:git.unstage',
  gitCommit: 'integrations:git.commit',
  gitLog: 'integrations:git.log',
  gitFileDiff: 'integrations:git.fileDiff',
  setGithubToken: 'integrations:github.setToken',
  hasGithubToken: 'integrations:github.hasToken',
  hasLinearKey: 'integrations:linear.hasKey',
  sshPortForward: 'integrations:ssh.portForward',
  sshPortForwardList: 'integrations:ssh.portForwardList',
  sshPortForwardClose: 'integrations:ssh.portForwardClose',
  remoteWorktreeCreate: 'integrations:remote.worktreeCreate',
} as const;

export type ForgePrSummary = {
  number: number;
  title: string;
  url: string;
  state: string;
  sourceBranch: string;
  targetBranch: string;
};

export type ExternalIssue = {
  id: string;
  provider: 'github' | 'linear';
  number?: number;
  title: string;
  url: string;
  state: string;
  labels: string[];
};

export type DiffAnnotation = {
  path: string;
  line: number;
  body: string;
};

export type GitDiffResult =
  | { ok: true; diff: string; branch: string | null; remote: string | null }
  | { ok: false; error: string };

export type CreatePrRequest = {
  title: string;
  body?: string;
  sourceBranch?: string;
  targetBranch?: string;
  draft?: boolean;
};

export type CreatePrResult =
  | { ok: true; url: string; number: number }
  | { ok: false; error: string };

export type PortForwardRequest = {
  localPort: number;
  remoteHost: string;
  remotePort: number;
  /** Optional label for UI */
  label?: string;
};

export type PortForwardInfo = {
  id: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  label?: string;
  localUrl: string;
};

export type RemoteWorktreeRequest = {
  host: string;
  username: string;
  remotePath: string;
  branch?: string;
};

export const createPrSchema = z.object({
  title: z.string().min(1).max(256),
  body: z.string().max(65_536).optional(),
  sourceBranch: z.string().max(256).optional(),
  targetBranch: z.string().max(256).optional(),
  draft: z.boolean().optional(),
});

export const setTokenSchema = z.object({
  token: z.string().min(1).max(4096),
});

export const listIssuesSchema = z.object({
  limit: z.number().int().min(1).max(50).default(20),
  state: z.enum(['open', 'closed', 'all']).default('open'),
});

export const portForwardSchema = z.object({
  localPort: z.number().int().min(1024).max(65535),
  remoteHost: z.string().min(1).max(256).default('127.0.0.1'),
  remotePort: z.number().int().min(1).max(65535),
  label: z.string().max(128).optional(),
});

export const remoteWorktreeSchema = z.object({
  host: z.string().min(1).max(256),
  username: z.string().min(1).max(128),
  remotePath: z.string().min(1).max(4096),
  branch: z.string().max(256).optional(),
});

export const gitPathsSchema = z.object({
  paths: z
    .array(z.string().min(1).max(4096).superRefine(safePathspec))
    .min(1)
    .max(500),
});

export const gitCommitSchema = z.object({
  message: z.string().min(1).max(4096),
});

export const gitLogSchema = z.object({
  count: z.number().int().min(1).max(100).default(20),
});

export const gitFileDiffSchema = z.object({
  path: z.string().min(1).max(4096).superRefine(safePathspec),
  staged: z.boolean().optional(),
  untracked: z.boolean().optional(),
});
