/**
 * Thin GitHub REST helpers (issues + create PR via forge provider).
 * Failures are typed (GitHubApiError) — a GitHub error never collapses into
 * a silently empty list.
 */
import type {
  ExternalIssue,
  ForgePrSummary,
  GitHubApiError,
} from '../../shared/integrations-types';
import {
  classifyGitHubApiError,
  githubApiErrorMessage,
} from '../../vendor/emdash/github/github-api-errors';
import { createGitHubForgeProvider } from '../source-control/github-forge-provider';
import type { ForgeAuthorization } from '../source-control/forge-provider';

export type GithubHttpResponse = {
  status: number;
  body: unknown;
  /** Lowercased response headers — needed to classify SSO/rate-limit. */
  headers?: Record<string, string>;
};

export type GithubHttp = {
  getJson: (
    url: string,
    headers: Record<string, string>,
  ) => Promise<GithubHttpResponse>;
  postJson: (
    url: string,
    body: unknown,
    headers: Record<string, string>,
  ) => Promise<GithubHttpResponse>;
};

function collectHeaders(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

export const defaultGithubHttp: GithubHttp = {
  async getJson(url, headers) {
    const res = await fetch(url, { headers });
    const body = await res.json().catch(() => null);
    return { status: res.status, body, headers: collectHeaders(res) };
  },
  async postJson(url, body, headers) {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const parsed = await res.json().catch(() => null);
    return { status: res.status, body: parsed, headers: collectHeaders(res) };
  },
};

export function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

/** Shape a non-2xx GithubHttpResponse the way the emdash classifier expects
 * (octokit-style error: top-level status + response.headers/data). */
function httpFailure(res: GithubHttpResponse): {
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

function githubFailure(
  error: unknown,
  context: { host: string; nameWithOwner: string; fallback: string },
): { ok: false; error: string; githubError: GitHubApiError } {
  const githubError = classifyGitHubApiError(error, context);
  return { ok: false, error: githubApiErrorMessage(githubError), githubError };
}

export async function listGithubIssues(
  token: string,
  owner: string,
  repo: string,
  opts: { limit: number; state: 'open' | 'closed' | 'all' },
  http: GithubHttp = defaultGithubHttp,
): Promise<
  { ok: true; issues: ExternalIssue[] } | { ok: false; error: string; githubError?: GitHubApiError }
> {
  const url =
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues` +
    `?state=${opts.state}&per_page=${opts.limit}&sort=updated`;
  const context = {
    host: 'github.com',
    nameWithOwner: `${owner}/${repo}`,
    fallback: `GitHub issues request failed`,
  };
  let res: GithubHttpResponse;
  try {
    res = await http.getJson(url, authHeaders(token));
  } catch (err) {
    return githubFailure(err, context);
  }
  if (res.status < 200 || res.status >= 300) {
    return githubFailure(httpFailure(res), {
      ...context,
      fallback: `GitHub issues HTTP ${res.status}`,
    });
  }
  const list = Array.isArray(res.body) ? res.body : [];
  const issues: ExternalIssue[] = list
    .filter((item) => {
      const row = item as { pull_request?: unknown };
      return !row.pull_request; // issues endpoint also returns PRs
    })
    .map((item) => {
      const row = item as {
        id?: number;
        number?: number;
        title?: string;
        html_url?: string;
        state?: string;
        labels?: Array<{ name?: string } | string>;
      };
      const labels = (row.labels ?? []).map((l) =>
        typeof l === 'string' ? l : l.name ?? '',
      ).filter(Boolean);
      return {
        id: `gh-${row.number ?? row.id ?? 0}`,
        provider: 'github' as const,
        number: row.number,
        title: row.title ?? 'issue',
        url: row.html_url ?? '',
        state: row.state ?? 'open',
        labels,
      };
    });
  return { ok: true, issues };
}

export async function listGithubPulls(
  token: string,
  owner: string,
  repo: string,
  http: GithubHttp = defaultGithubHttp,
): Promise<
  { ok: true; prs: ForgePrSummary[] } | { ok: false; error: string; githubError?: GitHubApiError }
> {
  const url =
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls` +
    `?state=open&per_page=20&sort=updated`;
  const context = {
    host: 'github.com',
    nameWithOwner: `${owner}/${repo}`,
    fallback: 'GitHub pulls request failed',
  };
  let res: GithubHttpResponse;
  try {
    res = await http.getJson(url, authHeaders(token));
  } catch (err) {
    return githubFailure(err, context);
  }
  if (res.status < 200 || res.status >= 300) {
    return githubFailure(httpFailure(res), {
      ...context,
      fallback: `GitHub pulls HTTP ${res.status}`,
    });
  }
  const list = Array.isArray(res.body) ? res.body : [];
  const prs: ForgePrSummary[] = list.map((item) => {
    const row = item as {
      number?: number;
      title?: string;
      html_url?: string;
      state?: string;
      head?: { ref?: string };
      base?: { ref?: string };
    };
    return {
      number: row.number ?? 0,
      title: row.title ?? 'PR',
      url: row.html_url ?? '',
      state: row.state ?? 'open',
      sourceBranch: row.head?.ref ?? '',
      targetBranch: row.base?.ref ?? 'main',
    };
  });
  return { ok: true, prs };
}

export async function createGithubPr(
  token: string,
  owner: string,
  name: string,
  input: {
    title: string;
    body: string;
    sourceBranch: string;
    targetBranch: string;
    draft?: boolean;
  },
  http: GithubHttp = defaultGithubHttp,
): Promise<
  | { ok: true; url: string; number: number }
  | { ok: false; error: string; githubError?: GitHubApiError }
> {
  const provider = createGitHubForgeProvider({ token, http });
  const auth: ForgeAuthorization = {
    grantedBy: 'user',
    grantedAt: Date.now(),
    scope: ['create-review'],
    reason: 'user requested PR from Nexus mission UI',
    expiresAt: Date.now() + 60_000,
  };
  let result: Awaited<ReturnType<typeof provider.createReview>>;
  try {
    result = await provider.createReview(
      { owner, name, host: 'github.com' },
      {
        title: input.title,
        body: input.body,
        sourceBranch: input.sourceBranch,
        targetBranch: input.targetBranch,
        draft: input.draft,
      },
      auth,
    );
  } catch (err) {
    return githubFailure(err, {
      host: 'github.com',
      nameWithOwner: `${owner}/${name}`,
      fallback: 'GitHub create PR request failed',
    });
  }
  if (!result.ok) {
    return {
      ok: false,
      error: result.apiError ? githubApiErrorMessage(result.apiError) : result.reason,
      githubError: result.apiError,
    };
  }
  return { ok: true, url: result.url, number: result.number };
}
