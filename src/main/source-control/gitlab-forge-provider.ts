// Adapted from stablyai/orca @ f352b6b08d9028ba8b577d6ac8a8247c2a6c9c92
// Copyright (c) 2026 Lovecast Inc. — MIT License
// See third_party/licenses/orca-MIT.txt. Nexus changes: GitLab adapter with
// mandatory ForgeAuthorization + audit log; HTTP transport injected; get MR for branch.
// Resync 2026-09-11: src/main/gitlab/client.ts (this file's upstream origin)
// was sliced into ~40 files at this pin; reviewed the 33 commits since 143c36e
// touching src/main/gitlab. The one REST-shaped fix — guard against a non-array
// API body (#12911) — targets the `glab` CLI JSON-parse path (JSON.parse(stdout)
// on an error envelope), which this adapter's direct HTTP transport doesn't
// share; this file already guards non-array bodies via
// `Array.isArray(response.body) ? response.body : []`. Rest of the window is
// self-hosted-instance routing and Checks-panel pipeline traces, both part of
// the hosted-review graph Nexus does not import. No port applies.

import type {
  ForgeCreateReviewResult,
  ForgeGetReviewForBranchResult,
  ForgeProvider,
} from './forge-provider';
import {
  assertForgeWriteAuthorized,
  recordForgeAudit,
} from './forge-provider';

export type GitLabHttp = {
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

export type GitLabForgeOptions = {
  readonly token: string;
  readonly http: GitLabHttp;
  readonly apiBase?: string;
};

function authHeaders(token: string): Record<string, string> {
  return {
    'PRIVATE-TOKEN': token,
    'Content-Type': 'application/json',
  };
}

export function createGitLabForgeProvider(options: GitLabForgeOptions): ForgeProvider {
  const apiBase = options.apiBase ?? 'https://gitlab.com/api/v4';
  return {
    id: 'gitlab',
    supportsReviewCreation: true,
    enabled: true,
    async createReview(repo, input, auth): Promise<ForgeCreateReviewResult> {
      const kind = 'create-review' as const;
      if (!assertForgeWriteAuthorized(auth, kind)) {
        recordForgeAudit({
          provider: 'gitlab',
          kind,
          authorized: false,
          actor: auth.grantedBy || 'unknown',
          detail: 'missing or incomplete authorization',
        });
        return { ok: false, reason: 'unauthorized' };
      }
      const project = encodeURIComponent(`${repo.owner}/${repo.name}`);
      const url = `${apiBase}/projects/${project}/merge_requests`;
      const response = await options.http.postJson(
        url,
        {
          title: input.title,
          description: input.body,
          source_branch: input.sourceBranch,
          target_branch: input.targetBranch,
          draft: input.draft ?? false,
        },
        authHeaders(options.token),
      );
      if (response.status >= 200 && response.status < 300) {
        const body = response.body as { web_url?: string; iid?: number };
        recordForgeAudit({
          provider: 'gitlab',
          kind,
          authorized: true,
          actor: auth.grantedBy,
          detail: `created MR !${body.iid ?? '?'} on ${repo.owner}/${repo.name}`,
        });
        return {
          ok: true,
          url: body.web_url ?? '',
          number: body.iid ?? 0,
        };
      }
      recordForgeAudit({
        provider: 'gitlab',
        kind,
        authorized: true,
        actor: auth.grantedBy,
        detail: `API status ${response.status}`,
      });
      return { ok: false, reason: `http-${response.status}` };
    },
    async getReviewForBranch(repo, branch): Promise<ForgeGetReviewForBranchResult> {
      const project = encodeURIComponent(`${repo.owner}/${repo.name}`);
      const url =
        `${apiBase}/projects/${project}/merge_requests` +
        `?source_branch=${encodeURIComponent(branch)}&state=opened&per_page=1`;
      const response = await options.http.getJson(url, authHeaders(options.token));
      if (response.status < 200 || response.status >= 300) {
        return { ok: false, reason: `http-${response.status}` };
      }
      const list = Array.isArray(response.body) ? response.body : [];
      if (list.length === 0) {
        return { ok: true, review: null };
      }
      const mr = list[0] as {
        iid?: number;
        web_url?: string;
        title?: string;
        state?: string;
        source_branch?: string;
        target_branch?: string;
      };
      return {
        ok: true,
        review: {
          number: mr.iid ?? 0,
          url: mr.web_url ?? '',
          title: mr.title ?? '',
          state: mr.state ?? 'opened',
          sourceBranch: mr.source_branch ?? branch,
          targetBranch: mr.target_branch ?? '',
        },
      };
    },
  };
}
