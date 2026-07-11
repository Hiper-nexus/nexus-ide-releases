// Adapted from stablyai/orca @ 143c36e566483006fe54fa2716b019ec00599752
// Copyright (c) 2026 Lovecast Inc. — MIT License
// See third_party/licenses/orca-MIT.txt. Nexus changes: GitHub adapter with
// mandatory ForgeAuthorization + audit log; HTTP transport injected; get PR for branch.

import type {
  ForgeCreateReviewResult,
  ForgeGetReviewForBranchResult,
  ForgeProvider,
} from './forge-provider';
// re-exported types below
import {
  assertForgeWriteAuthorized,
  recordForgeAudit,
} from './forge-provider';

export type GitHubHttp = {
  postJson: (
    url: string,
    body: unknown,
    headers: Record<string, string>,
  ) => Promise<{ status: number; body: unknown }>;
  getJson: (
    url: string,
    headers: Record<string, string>,
  ) => Promise<{ status: number; body: unknown }>;
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
      return { ok: false, reason: `http-${response.status}` };
    },
    async getReviewForBranch(repo, branch): Promise<ForgeGetReviewForBranchResult> {
      // GitHub: GET /repos/{owner}/{repo}/pulls?head={owner}:{branch}&state=open
      const head = `${repo.owner}:${branch}`;
      const url =
        `${apiBase}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/pulls` +
        `?head=${encodeURIComponent(head)}&state=open&per_page=1`;
      const response = await options.http.getJson(url, authHeaders(options.token));
      if (response.status < 200 || response.status >= 300) {
        return { ok: false, reason: `http-${response.status}` };
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
  };
}

export type {
  ForgeAuthorization,
  ForgeCreateReviewInput,
  ForgeRepositoryRef,
} from './forge-provider';
