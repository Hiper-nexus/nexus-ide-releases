// Adapted from stablyai/orca @ f352b6b08d9028ba8b577d6ac8a8247c2a6c9c92
// Copyright (c) 2026 Lovecast Inc. — MIT License
// See third_party/licenses/orca-MIT.txt. Nexus changes: GitHub adapter with
// mandatory ForgeAuthorization + audit log; HTTP transport injected; get PR for
// branch; failures classified into the typed GitHubApiError taxonomy (emdash).
// Resync 2026-09-11: src/main/github/client.ts (this file's upstream origin)
// was sliced into ~200 files at this pin; reviewed the 66 commits since 143c36e
// touching src/main/github — fork head-origin tracking, GHES multi-repo
// routing, stacked-PR/merge-queue UI and a GitHub PR-lookup rate-limit
// pre-check (#11532) all live in the hosted-review graph Nexus does not
// import. Nothing in that window changes createReview/getReviewForBranch
// semantics for a non-fork repo+branch pair, which is this adapter's whole
// surface. No port applies; not proactively adding rate-limit tracking here
// since it would be new functionality (and needs github-pr-queue.ts, a
// different worker's file) rather than a resync fix.

import type {
  ForgeAutoMergeInput,
  ForgeCreateReviewResult,
  ForgeEnqueueResult,
  ForgeGetReviewForBranchResult,
  ForgeInspectReviewResult,
  ForgeProvider,
} from './forge-provider';
import {
  enqueueGitHubPullRequest,
  inspectGitHubPullRequest,
  setGitHubPullRequestAutoMerge,
} from './github-pr-queue';
// re-exported types below
import {
  assertForgeWriteAuthorized,
  recordForgeAudit,
} from './forge-provider';
import {
  classifyGitHubApiError,
  githubApiErrorMessage,
} from '../../vendor/emdash/github/github-api-errors';

export type GitHubHttpResponse = {
  status: number;
  body: unknown;
  /** Lowercased response headers — needed to classify SSO/rate-limit. */
  headers?: Record<string, string>;
};

export type GitHubHttp = {
  postJson: (
    url: string,
    body: unknown,
    headers: Record<string, string>,
  ) => Promise<GitHubHttpResponse>;
  getJson: (
    url: string,
    headers: Record<string, string>,
  ) => Promise<GitHubHttpResponse>;
  /** Needed for GitHub stacked-PR merge-async (PUT). Optional for older callers. */
  putJson?: (
    url: string,
    body: unknown,
    headers: Record<string, string>,
  ) => Promise<GitHubHttpResponse>;
};

export type GitHubForgeOptions = {
  readonly token: string;
  readonly http: GitHubHttp;
  readonly apiBase?: string;
};

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  };
}

/** Shape a non-2xx response the way the emdash classifier expects. */
function httpFailure(res: GitHubHttpResponse): {
  status: number;
  headers?: Record<string, string>;
  response: { headers?: Record<string, string>; data: unknown };
} {
  return {
    status: res.status,
    headers: res.headers,
    response: { headers: res.headers, data: res.body },
  };
}

export function createGitHubForgeProvider(options: GitHubForgeOptions): ForgeProvider {
  const apiBase = options.apiBase ?? 'https://api.github.com';
  return {
    id: 'github',
    supportsReviewCreation: true,
    enabled: true,
    async createReview(repo, input, auth): Promise<ForgeCreateReviewResult> {
      const kind = 'create-review' as const;
      if (!assertForgeWriteAuthorized(auth, kind)) {
        recordForgeAudit({
          provider: 'github',
          kind,
          authorized: false,
          actor: auth.grantedBy || 'unknown',
          detail: 'missing or incomplete authorization',
        });
        return { ok: false, reason: 'unauthorized' };
      }
      const url = `${apiBase}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/pulls`;
      const response = await options.http.postJson(
        url,
        {
          title: input.title,
          body: input.body,
          head: input.sourceBranch,
          base: input.targetBranch,
          draft: input.draft ?? false,
        },
        authHeaders(options.token),
      );
      if (response.status >= 200 && response.status < 300) {
        const body = response.body as { html_url?: string; number?: number };
        recordForgeAudit({
          provider: 'github',
          kind,
          authorized: true,
          actor: auth.grantedBy,
          detail: `created PR #${body.number ?? '?'} on ${repo.owner}/${repo.name}`,
        });
        return {
          ok: true,
          url: body.html_url ?? '',
          number: body.number ?? 0,
        };
      }
      recordForgeAudit({
        provider: 'github',
        kind,
        authorized: true,
        actor: auth.grantedBy,
        detail: `API status ${response.status}`,
      });
      const apiError = classifyGitHubApiError(httpFailure(response), {
        host: repo.host,
        nameWithOwner: `${repo.owner}/${repo.name}`,
        fallback: `GitHub create PR HTTP ${response.status}`,
      });
      return {
        ok: false,
        reason: githubApiErrorMessage(apiError),
        apiError,
      };
    },
    async getReviewForBranch(repo, branch): Promise<ForgeGetReviewForBranchResult> {
      // GitHub: GET /repos/{owner}/{repo}/pulls?head={owner}:{branch}&state=open
      const head = `${repo.owner}:${branch}`;
      const url =
        `${apiBase}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/pulls` +
        `?head=${encodeURIComponent(head)}&state=open&per_page=1`;
      const response = await options.http.getJson(url, authHeaders(options.token));
      if (response.status < 200 || response.status >= 300) {
        const apiError = classifyGitHubApiError(httpFailure(response), {
          host: repo.host,
          nameWithOwner: `${repo.owner}/${repo.name}`,
          fallback: `GitHub get PR for branch HTTP ${response.status}`,
        });
        return { ok: false, reason: githubApiErrorMessage(apiError), apiError };
      }
      const list = Array.isArray(response.body) ? response.body : [];
      if (list.length === 0) {
        return { ok: true, review: null };
      }
      const pr = list[0] as {
        number?: number;
        html_url?: string;
        title?: string;
        state?: string;
        head?: { ref?: string };
        base?: { ref?: string };
      };
      return {
        ok: true,
        review: {
          number: pr.number ?? 0,
          url: pr.html_url ?? '',
          title: pr.title ?? '',
          state: pr.state ?? 'open',
          sourceBranch: pr.head?.ref ?? branch,
          targetBranch: pr.base?.ref ?? '',
        },
      };
    },
    async inspectReview(repo, prNumber): Promise<ForgeInspectReviewResult> {
      return inspectGitHubPullRequest(
        { token: options.token, http: options.http, apiBase },
        repo,
        prNumber,
      );
    },
    async enqueueMergeQueue(repo, input, auth): Promise<ForgeEnqueueResult> {
      const kind = 'enqueue-merge-queue' as const;
      if (!assertForgeWriteAuthorized(auth, kind)) {
        recordForgeAudit({
          provider: 'github',
          kind,
          authorized: false,
          actor: auth.grantedBy || 'unknown',
          detail: 'missing or incomplete authorization',
        });
        return { ok: false, reason: 'unauthorized' };
      }
      const result = await enqueueGitHubPullRequest(
        { token: options.token, http: options.http, apiBase },
        repo,
        input,
      );
      recordForgeAudit({
        provider: 'github',
        kind,
        authorized: true,
        actor: auth.grantedBy,
        detail: result.ok
          ? `enqueue ${result.action} PR #${input.number} on ${repo.owner}/${repo.name}`
          : result.reason,
      });
      return result;
    },
    async setAutoMerge(repo, input: ForgeAutoMergeInput, auth): Promise<ForgeEnqueueResult> {
      const kind = 'auto-merge' as const;
      if (!assertForgeWriteAuthorized(auth, kind)) {
        recordForgeAudit({
          provider: 'github',
          kind,
          authorized: false,
          actor: auth.grantedBy || 'unknown',
          detail: 'missing or incomplete authorization',
        });
        return { ok: false, reason: 'unauthorized' };
      }
      const result = await setGitHubPullRequestAutoMerge(
        { token: options.token, http: options.http, apiBase },
        repo,
        input,
      );
      recordForgeAudit({
        provider: 'github',
        kind,
        authorized: true,
        actor: auth.grantedBy,
        detail: result.ok
          ? `auto-merge ${input.enabled ? 'on' : 'off'} PR #${input.number}`
          : result.reason,
      });
      return result;
    },
  };
}

export type {
  ForgeAuthorization,
  ForgeCreateReviewInput,
  ForgeRepositoryRef,
} from './forge-provider';
