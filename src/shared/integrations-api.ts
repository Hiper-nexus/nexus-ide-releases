/**
 * Renderer-facing integrations API (preload → main IPC).
 * Kept out of types.ts so that surface can grow without a monolith edit.
 */
import type {
  GitCommitResult,
  GitFileDiffResult,
  GitLogResult,
  GitMutateResult,
  GitStatusResult,
} from './git-scm';

/** Structured status plus legacy LF `status` string for older callers. */
export type IntegrationsGitStatus =
  | (Extract<GitStatusResult, { ok: true }> & { status: string })
  | Extract<GitStatusResult, { ok: false }>;

export interface IntegrationsApi {
  hasGithubToken(): Promise<boolean>;
  hasLinearKey(): Promise<boolean>;
  setGithubToken(token: string): Promise<{ ok: boolean; error?: string }>;
  setLinearKey(token: string): Promise<{ ok: boolean; error?: string }>;
  gitDiff(): Promise<
    | { ok: true; diff: string; branch: string | null; remote: string | null }
    | { ok: false; error: string }
  >;
  gitStatus(): Promise<IntegrationsGitStatus>;
  gitStage(paths: string[]): Promise<GitMutateResult>;
  gitUnstage(paths: string[]): Promise<GitMutateResult>;
  gitCommit(message: string): Promise<GitCommitResult>;
  gitLog(count?: number): Promise<GitLogResult>;
  gitFileDiff(input: {
    path: string;
    staged?: boolean;
    untracked?: boolean;
  }): Promise<GitFileDiffResult>;
  createPr(req: {
    title: string;
    body?: string;
    sourceBranch?: string;
    targetBranch?: string;
    draft?: boolean;
  }): Promise<{ ok: true; url: string; number: number } | { ok: false; error: string }>;
  listPrs(): Promise<
    | {
        ok: true;
        prs: Array<{
          number: number;
          title: string;
          url: string;
          state: string;
          sourceBranch: string;
          targetBranch: string;
        }>;
      }
    | { ok: false; error: string }
  >;
  listGithubIssues(opts?: {
    limit?: number;
    state?: 'open' | 'closed' | 'all';
  }): Promise<
    | {
        ok: true;
        issues: Array<{
          id: string;
          provider: 'github' | 'linear';
          number?: number;
          title: string;
          url: string;
          state: string;
          labels: string[];
        }>;
      }
    | { ok: false; error: string }
  >;
  listLinearIssues(opts?: {
    limit?: number;
  }): Promise<
    | {
        ok: true;
        issues: Array<{
          id: string;
          provider: 'github' | 'linear';
          number?: number;
          title: string;
          url: string;
          state: string;
          labels: string[];
        }>;
      }
    | { ok: false; error: string }
  >;
  startPortForward(req: {
    localPort: number;
    remoteHost?: string;
    remotePort: number;
    label?: string;
  }): Promise<
    | {
        ok: true;
        info: {
          id: string;
          localPort: number;
          remoteHost: string;
          remotePort: number;
          label?: string;
          localUrl: string;
        };
      }
    | { ok: false; error: string }
  >;
  listPortForwards(): Promise<
    Array<{
      id: string;
      localPort: number;
      remoteHost: string;
      remotePort: number;
      label?: string;
      localUrl: string;
    }>
  >;
  closePortForward(id: string): Promise<{ ok: boolean }>;
  remoteWorktreeCreate(req: {
    host: string;
    username: string;
    remotePath: string;
    branch?: string;
  }): Promise<{ ok: true; path: string } | { ok: false; error: string }>;
}
