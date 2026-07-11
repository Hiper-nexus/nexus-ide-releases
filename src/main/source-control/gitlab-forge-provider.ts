// Adapted from stablyai/orca @ 143c36e566483006fe54fa2716b019ec00599752
// Copyright (c) 2026 Lovecast Inc. — MIT License
// See third_party/licenses/orca-MIT.txt. Nexus changes: GitLab adapter with
// mandatory ForgeAuthorization + audit log; HTTP transport injected.

import type {
  ForgeCreateReviewResult,
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
};

export type GitLabForgeOptions = {
  readonly token: string;
  readonly http: GitLabHttp;
  readonly apiBase?: string;
};

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
        {
          'PRIVATE-TOKEN': options.token,
          'Content-Type': 'application/json',
        },
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
  };
}
