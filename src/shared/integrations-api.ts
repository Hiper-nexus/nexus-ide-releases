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
import type {
  BranchReviewResult,
  CreatePrResult,
  EnqueuePrResult,
  GitHubAuthErrorPayload,
  GitHubDeviceCodePayload,
  GitHubDeviceFlowIpcResult,
  GitHubDeviceFlowStatus,
  InspectPrResult,
  ListIssuesResult,
  ListPrsResult,
} from './integrations-types';

/** Structured status plus legacy LF `status` string for older callers. */
export type IntegrationsGitStatus =
  | (Extract<GitStatusResult, { ok: true }> & { status: string })
  | Extract<GitStatusResult, { ok: false }>;

export interface IntegrationsApi {
  hasGithubToken(): Promise<boolean>;
  hasLinearKey(): Promise<boolean>;
  setGithubToken(token: string): Promise<{ ok: boolean; error?: string }>;
  setLinearKey(token: string): Promise<{ ok: boolean; error?: string }>;
  /** Device Flow availability — without a clientId the UI keeps the option hidden. */
  githubDeviceFlowStatus(): Promise<GitHubDeviceFlowStatus>;
  startGithubDeviceFlow(): Promise<GitHubDeviceFlowIpcResult>;
  cancelGithubDeviceFlow(): Promise<{ ok: boolean }>;
  /** Main pushes the device code here once GitHub issues it. */
  onGithubDeviceCode(cb: (payload: GitHubDeviceCodePayload) => void): () => void;
  /** Async auth failures (e.g. mid-flow errors) surface here. */
  onGithubAuthError(cb: (payload: GitHubAuthErrorPayload) => void): () => void;
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
  gitPush(): Promise<GitMutateResult>;
  createPr(req: {
    title: string;
    body?: string;
    sourceBranch?: string;
    targetBranch?: string;
    draft?: boolean;
  }): Promise<CreatePrResult>;
  listPrs(): Promise<ListPrsResult>;
  /** PR/MR aberto para a branch atual (null quando não existe). */
  branchReview(): Promise<BranchReviewResult>;
  inspectPr(): Promise<InspectPrResult>;
  enqueuePr(req?: {
    number?: number;
    mode?: 'when-ready' | 'now';
    mergeMethod?: 'squash' | 'merge' | 'rebase';
  }): Promise<EnqueuePrResult>;
  setAutoMerge(req: {
    number?: number;
    enabled: boolean;
    mergeMethod?: 'squash' | 'merge' | 'rebase';
  }): Promise<EnqueuePrResult>;
  listGithubIssues(opts?: {
    limit?: number;
    state?: 'open' | 'closed' | 'all';
  }): Promise<ListIssuesResult>;
  listLinearIssues(opts?: {
    limit?: number;
  }): Promise<ListIssuesResult>;
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
