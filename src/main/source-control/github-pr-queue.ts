// Adapted from stablyai/orca @ 93334dc53fccdb7348d09fc28067ba6d3dec36ea
// (src/main/github/client.ts merge-queue probe + setPRAutoMerge +
// github-pr-stack-async-merge.ts). Copyright (c) 2026 Lovecast Inc. — MIT License
// See third_party/licenses/orca-MIT.txt.
// Nexus changes: injected fetch (no `gh` CLI); ForgeAuthorization + audit;
// typed GitHubApiError. Does not replace the local worktree merge-queue.

import {
  classifyAsyncMergeResponse,
  normalizeMergeStateStatus,
  parseRepositoryMergeMetadata,
  planGitHubPREnqueue,
  type AsyncMergeResponse,
} from '../../shared/github-pr-merge-queue';
import {
  classifyGitHubApiError,
  githubApiErrorMessage,
} from '../../vendor/emdash/github/github-api-errors';
import type { GitHubApiError } from '../../vendor/emdash/github/github-api-errors';
import type {
  ForgeEnqueueInput,
  ForgeEnqueueResult,
  ForgeInspectReviewResult,
  ForgePRInspect,
  ForgeRepositoryRef,
} from './forge-provider';
import type { GitHubHttp, GitHubHttpResponse } from './github-forge-provider';

const GRAPHQL_MERGE_METADATA = `query($owner: String!, $repo: String!, $branch: String!, $qualified: String!) {
  repository(owner: $owner, name: $repo) {
    autoMergeAllowed
    mergeQueue(branch: $branch) { id }
    ref(qualifiedName: $qualified) {
      rules(first: 50) { nodes { type } }
    }
  }
}`;

const GRAPHQL_ENABLE_AUTO_MERGE = `mutation($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!) {
  enablePullRequestAutoMerge(input: {
    pullRequestId: $pullRequestId,
    mergeMethod: $mergeMethod
  }) {
    pullRequest { id }
  }
}`;

const GRAPHQL_DISABLE_AUTO_MERGE = `mutation($pullRequestId: ID!) {
  disablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId }) {
    pullRequest { id }
  }
}`;

const GRAPHQL_ENQUEUE = `mutation($pullRequestId: ID!) {
  enqueuePullRequest(input: { pullRequestId: $pullRequestId }) {
    mergeQueueEntry { id }
  }
}`;

const MERGE_METHODS = {
  squash: 'SQUASH',
  merge: 'MERGE',
  rebase: 'REBASE',
} as const;

export type GitHubPrQueueHttp = GitHubHttp & {
  putJson?: GitHubHttp['postJson'];
};

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

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

function fail(
  res: GitHubHttpResponse,
  repo: ForgeRepositoryRef,
  fallback: string,
): { ok: false; reason: string; apiError: GitHubApiError } {
  const apiError = classifyGitHubApiError(httpFailure(res), {
    host: repo.host,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    fallback,
  });
  return { ok: false, reason: githubApiErrorMessage(apiError), apiError };
}

function graphqlErrors(body: unknown): string | null {
  if (!body || typeof body !== 'object' || !('errors' in body)) return null;
  const errors = (body as { errors?: { message?: string }[] }).errors;
  if (!Array.isArray(errors) || errors.length === 0) return null;
  return errors.map((item) => item.message).filter(Boolean).join('; ') || 'GraphQL error';
}

function inspectState(pr: {
  state?: string;
  draft?: boolean;
  merged_at?: string | null;
}): ForgePRInspect['state'] {
  if (pr.merged_at) return 'merged';
  if (pr.draft) return 'draft';
  if (pr.state === 'closed') return 'closed';
  return 'open';
}

export async function inspectGitHubPullRequest(
  options: {
    token: string;
    http: GitHubPrQueueHttp;
    apiBase: string;
  },
  repo: ForgeRepositoryRef,
  prNumber: number,
): Promise<ForgeInspectReviewResult> {
  const headers = authHeaders(options.token);
  const rest = await options.http.getJson(
    `${options.apiBase}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/pulls/${prNumber}`,
    headers,
  );
  if (rest.status < 200 || rest.status >= 300) {
    return fail(rest, repo, `GitHub get PR HTTP ${rest.status}`);
  }
  const pr = (rest.body ?? {}) as {
    number?: number;
    node_id?: string;
    html_url?: string;
    title?: string;
    state?: string;
    draft?: boolean;
    merged_at?: string | null;
    mergeable?: boolean | null;
    mergeable_state?: string;
    auto_merge?: unknown;
    head?: { ref?: string; sha?: string };
    base?: { ref?: string };
    stack?: unknown;
  };
  const targetBranch = pr.base?.ref ?? '';
  const graphql = await options.http.postJson(
    `${options.apiBase}/graphql`,
    {
      query: GRAPHQL_MERGE_METADATA,
      variables: {
        owner: repo.owner,
        repo: repo.name,
        branch: targetBranch,
        qualified: `refs/heads/${targetBranch}`,
      },
    },
    headers,
  );
  let metadata = parseRepositoryMergeMetadata(null, targetBranch || undefined);
  if (graphql.status >= 200 && graphql.status < 300 && !graphqlErrors(graphql.body)) {
    const data = graphql.body as {
      data?: { repository?: Parameters<typeof parseRepositoryMergeMetadata>[0] };
    };
    metadata = parseRepositoryMergeMetadata(data.data?.repository, targetBranch || undefined);
  }
  const mergeable =
    pr.mergeable === true ? 'MERGEABLE' : pr.mergeable === false ? 'CONFLICTING' : 'UNKNOWN';
  const review: ForgePRInspect = {
    number: pr.number ?? prNumber,
    nodeId: typeof pr.node_id === 'string' ? pr.node_id : undefined,
    url: pr.html_url ?? '',
    title: pr.title ?? '',
    state: inspectState(pr),
    sourceBranch: pr.head?.ref ?? '',
    targetBranch,
    headSha: pr.head?.sha,
    mergeable,
    mergeStateStatus: normalizeMergeStateStatus(pr.mergeable_state),
    reviewDecision: null,
    autoMergeEnabled: Boolean(pr.auto_merge),
    autoMergeAllowed: metadata.autoMergeAllowed,
    mergeQueueRequired: metadata.mergeQueueRequired,
    stacked: Boolean(pr.stack),
  };
  return { ok: true, review };
}

async function runGraphql(
  options: { token: string; http: GitHubPrQueueHttp; apiBase: string },
  repo: ForgeRepositoryRef,
  query: string,
  variables: Record<string, unknown>,
  fallback: string,
): Promise<{ ok: true } | { ok: false; reason: string; apiError?: GitHubApiError }> {
  const res = await options.http.postJson(
    `${options.apiBase}/graphql`,
    { query, variables },
    authHeaders(options.token),
  );
  if (res.status < 200 || res.status >= 300) {
    return fail(res, repo, fallback);
  }
  const gqlError = graphqlErrors(res.body);
  if (gqlError) {
    return { ok: false, reason: gqlError };
  }
  return { ok: true };
}

async function enqueueStackAsync(
  options: { token: string; http: GitHubPrQueueHttp; apiBase: string },
  repo: ForgeRepositoryRef,
  input: ForgeEnqueueInput,
  inspect: ForgePRInspect,
): Promise<ForgeEnqueueResult> {
  const putJson = options.http.putJson;
  if (!putJson) {
    return { ok: false, reason: 'HTTP PUT is required for stacked GitHub merge-async' };
  }
  const mergeAction =
    inspect.mergeQueueRequired === true ? 'merge_queue' : 'direct_merge';
  const body: Record<string, string> = { merge_action: mergeAction };
  if (mergeAction === 'direct_merge') {
    body.merge_method = input.mergeMethod ?? 'squash';
  }
  if (inspect.headSha) body.sha = inspect.headSha;
  const res = await putJson(
    `${options.apiBase}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/pulls/${input.number}/merge-async`,
    body,
    authHeaders(options.token),
  );
  if (res.status < 200 || res.status >= 300) {
    return fail(res, repo, `GitHub merge-async HTTP ${res.status}`);
  }
  const classified = classifyAsyncMergeResponse((res.body ?? {}) as AsyncMergeResponse);
  if (classified.kind === 'failure') {
    return { ok: false, reason: classified.message };
  }
  return { ok: true, action: 'stack' };
}

export async function enqueueGitHubPullRequest(
  options: {
    token: string;
    http: GitHubPrQueueHttp;
    apiBase: string;
  },
  repo: ForgeRepositoryRef,
  input: ForgeEnqueueInput,
): Promise<ForgeEnqueueResult> {
  const inspected = await inspectGitHubPullRequest(options, repo, input.number);
  if (!inspected.ok) return inspected;
  if (!inspected.review) {
    return { ok: false, reason: 'pull request not found' };
  }
  const review = inspected.review;
  const plan = planGitHubPREnqueue({
    mergeQueueRequired: review.mergeQueueRequired,
    stacked: review.stacked,
    mode: input.mode,
  });
  if (plan.kind === 'refuse') {
    return { ok: false, reason: plan.reason };
  }
  if (plan.kind === 'stack-async') {
    return enqueueStackAsync(options, repo, input, review);
  }
  if (!review.nodeId) {
    return { ok: false, reason: 'Could not resolve GitHub pull request ID' };
  }
  if (plan.kind === 'enqueue-now') {
    const result = await runGraphql(
      options,
      repo,
      GRAPHQL_ENQUEUE,
      { pullRequestId: review.nodeId },
      'GitHub enqueuePullRequest failed',
    );
    return result.ok ? { ok: true, action: 'enqueued' } : result;
  }
  const result = await runGraphql(
    options,
    repo,
    GRAPHQL_ENABLE_AUTO_MERGE,
    {
      pullRequestId: review.nodeId,
      mergeMethod: MERGE_METHODS[input.mergeMethod ?? 'squash'],
    },
    'GitHub enablePullRequestAutoMerge failed',
  );
  return result.ok ? { ok: true, action: 'when-ready' } : result;
}

export async function setGitHubPullRequestAutoMerge(
  options: {
    token: string;
    http: GitHubPrQueueHttp;
    apiBase: string;
  },
  repo: ForgeRepositoryRef,
  input: { number: number; enabled: boolean; mergeMethod?: 'squash' | 'merge' | 'rebase' },
): Promise<ForgeEnqueueResult> {
  const inspected = await inspectGitHubPullRequest(options, repo, input.number);
  if (!inspected.ok) return inspected;
  if (!inspected.review?.nodeId) {
    return { ok: false, reason: 'Could not resolve GitHub pull request ID' };
  }
  if (inspected.review.stacked && input.enabled) {
    return {
      ok: false,
      reason: 'GitHub does not support auto-merge for stacked pull requests.',
    };
  }
  if (!input.enabled) {
    const result = await runGraphql(
      options,
      repo,
      GRAPHQL_DISABLE_AUTO_MERGE,
      { pullRequestId: inspected.review.nodeId },
      'GitHub disablePullRequestAutoMerge failed',
    );
    return result.ok ? { ok: true, action: 'when-ready' } : result;
  }
  return enqueueGitHubPullRequest(options, repo, {
    number: input.number,
    mode: 'when-ready',
    mergeMethod: input.mergeMethod,
  });
}
