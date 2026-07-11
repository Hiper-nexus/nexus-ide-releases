/**
 * Minimal Linear GraphQL client (list issues).
 * Adapted patterns from stablyai/orca linear handlers (MIT) — Nexus thin client.
 * See third_party/licenses/orca-MIT.txt.
 */
import type { ExternalIssue } from '../../shared/integrations-types';

const LINEAR_API = 'https://api.linear.app/graphql';

export type LinearHttp = {
  postJson: (
    url: string,
    body: unknown,
    headers: Record<string, string>,
  ) => Promise<{ status: number; body: unknown }>;
};

export const defaultLinearHttp: LinearHttp = {
  async postJson(url, body, headers) {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const parsed = await res.json().catch(() => null);
    return { status: res.status, body: parsed };
  },
};

const ISSUES_QUERY = `
query NexusIssues($first: Int!) {
  issues(first: $first, orderBy: updatedAt) {
    nodes {
      id
      identifier
      title
      url
      state { name }
      labels { nodes { name } }
    }
  }
}
`;

export async function listLinearIssues(
  apiKey: string,
  limit: number,
  http: LinearHttp = defaultLinearHttp,
): Promise<{ ok: true; issues: ExternalIssue[] } | { ok: false; error: string }> {
  const res = await http.postJson(
    LINEAR_API,
    { query: ISSUES_QUERY, variables: { first: limit } },
    {
      Authorization: apiKey,
      'Content-Type': 'application/json',
    },
  );
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, error: `Linear HTTP ${res.status}` };
  }
  const body = res.body as {
    errors?: Array<{ message?: string }>;
    data?: {
      issues?: {
        nodes?: Array<{
          id?: string;
          identifier?: string;
          title?: string;
          url?: string;
          state?: { name?: string };
          labels?: { nodes?: Array<{ name?: string }> };
        }>;
      };
    };
  };
  if (body.errors?.length) {
    return { ok: false, error: body.errors[0]?.message ?? 'Linear GraphQL error' };
  }
  const nodes = body.data?.issues?.nodes ?? [];
  const issues: ExternalIssue[] = nodes.map((n) => ({
    id: n.id ?? n.identifier ?? 'linear-unknown',
    provider: 'linear' as const,
    title: n.title ?? n.identifier ?? 'issue',
    url: n.url ?? '',
    state: n.state?.name ?? 'unknown',
    labels: (n.labels?.nodes ?? []).map((l) => l.name ?? '').filter(Boolean),
  }));
  return { ok: true, issues };
}
