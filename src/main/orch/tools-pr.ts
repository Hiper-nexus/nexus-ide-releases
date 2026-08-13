import type { McpToolDef } from './mcp-protocol';
import { str } from './tool-util';
import { resolveCwdForScope } from './workspace-path';
import { executionScopeFor } from './gate';
import { defaultGithubHttp } from '../integrations/github-api';
import {
  gitCurrentBranch,
  gitRemoteOrigin,
} from '../integrations/git-workspace';
import { getGithubToken } from '../integrations/token-vault';
import {
  resolveForgeProvider,
  selectForge,
} from '../source-control/forge-registry';
import type { ForgeAuthorization } from '../source-control/forge-provider';
import type { GitHubHttp } from '../source-control/github-forge-provider';

export type PrToolDeps = {
  token: () => string | null;
  remoteUrl: (cwd: string) => string | null;
  currentBranch: (cwd: string) => string | null;
  http: GitHubHttp;
  now?: () => number;
};

const defaultDeps: PrToolDeps = {
  token: getGithubToken,
  remoteUrl: gitRemoteOrigin,
  currentBranch: gitCurrentBranch,
  http: defaultGithubHttp,
};

function resolveCwd(ctx: Parameters<typeof executionScopeFor>[0], cwdOverride?: string): string {
  return resolveCwdForScope(executionScopeFor(ctx), cwdOverride);
}

function operatorAuth(now: number, reason: string): ForgeAuthorization {
  return {
    grantedBy: 'mcp-agent',
    grantedAt: now,
    scope: ['enqueue-merge-queue', 'auto-merge'],
    reason,
    expiresAt: now + 2 * 60_000,
  };
}

export function buildPrTools(overrides: Partial<PrToolDeps> = {}): McpToolDef[] {
  const deps: PrToolDeps = { ...defaultDeps, ...overrides };
  const now = deps.now ?? Date.now;

  const inspect: McpToolDef = {
    name: 'nexus_pr_inspect',
    description:
      'Inspect the open GitHub pull request for the current branch, including ' +
      'whether the base uses GitHub merge queue. Use this before saying a PR ' +
      'can be merged directly — a queue branch must be enqueued (Merge when ready).',
    inputSchema: {
      type: 'object',
      properties: {
        number: {
          type: 'number',
          description: 'PR number (defaults to the open PR on the current branch)',
        },
        cwd: {
          type: 'string',
          description: 'Working directory (defaults to workspace root)',
        },
      },
    },
    handler: async (args, ctx) => {
      const cwd = resolveCwd(ctx, str(args, 'cwd'));
      const remote = deps.remoteUrl(cwd);
      const forge = selectForge(remote);
      if (!forge) {
        return { ok: false, error: 'origin não é um remote hospedado reconhecido' };
      }
      const token = deps.token();
      if (!token) {
        return { ok: false, error: 'GitHub token ausente' };
      }
      const provider = resolveForgeProvider(forge, token, deps.http);
      const repo = { owner: forge.owner, name: forge.name, host: forge.host };
      let number =
        typeof args.number === 'number' && Number.isInteger(args.number)
          ? args.number
          : undefined;
      if (!number) {
        const branch = deps.currentBranch(cwd);
        if (!branch || !provider.getReviewForBranch) {
          return { ok: true, branch: branch ?? null, review: null };
        }
        const listed = await provider.getReviewForBranch(repo, branch);
        if (!listed.ok) return { ok: false, error: listed.reason };
        if (!listed.review) return { ok: true, branch, review: null };
        number = listed.review.number;
      }
      if (!provider.inspectReview) {
        return { ok: false, error: `inspect de PR não suportado em ${forge.providerId}` };
      }
      const inspected = await provider.inspectReview(repo, number);
      if (!inspected.ok) return { ok: false, error: inspected.reason };
      return {
        ok: true,
        review: inspected.review,
        note:
          inspected.review?.mergeQueueRequired === true
            ? 'A branch-alvo usa merge queue do GitHub. Não faça merge direto — use nexus_pr_enqueue.'
            : undefined,
      };
    },
  };

  const enqueue: McpToolDef = {
    name: 'nexus_pr_enqueue',
    description:
      'Add the current (or numbered) GitHub pull request to the GitHub merge ' +
      'queue. Default is Merge when ready (auto-merge). mode=now enqueues ' +
      'immediately. Stacked PRs use GitHub merge-async, like Orca.',
    inputSchema: {
      type: 'object',
      properties: {
        number: {
          type: 'number',
          description: 'PR number (defaults to the open PR on the current branch)',
        },
        mode: {
          type: 'string',
          enum: ['when-ready', 'now'],
          description: 'when-ready (default) or now',
        },
        mergeMethod: {
          type: 'string',
          enum: ['squash', 'merge', 'rebase'],
        },
        cwd: {
          type: 'string',
          description: 'Working directory (defaults to workspace root)',
        },
      },
    },
    handler: async (args, ctx) => {
      const cwd = resolveCwd(ctx, str(args, 'cwd'));
      const remote = deps.remoteUrl(cwd);
      const forge = selectForge(remote);
      if (!forge) {
        return { ok: false, error: 'origin não é um remote hospedado reconhecido' };
      }
      const token = deps.token();
      if (!token) {
        return { ok: false, error: 'GitHub token ausente' };
      }
      const provider = resolveForgeProvider(forge, token, deps.http);
      if (!provider.enqueueMergeQueue) {
        return { ok: false, error: `merge queue não suportada em ${forge.providerId}` };
      }
      const repo = { owner: forge.owner, name: forge.name, host: forge.host };
      let number =
        typeof args.number === 'number' && Number.isInteger(args.number)
          ? args.number
          : undefined;
      if (!number) {
        const branch = deps.currentBranch(cwd);
        if (!branch || !provider.getReviewForBranch) {
          return { ok: false, error: 'informe number do PR' };
        }
        const listed = await provider.getReviewForBranch(repo, branch);
        if (!listed.ok) return { ok: false, error: listed.reason };
        number = listed.review?.number;
      }
      if (!number) return { ok: false, error: 'nenhum PR aberto nesta branch' };
      const mode = str(args, 'mode');
      const mergeMethod = str(args, 'mergeMethod');
      const result = await provider.enqueueMergeQueue(
        repo,
        {
          number,
          mode: mode === 'now' || mode === 'when-ready' ? mode : undefined,
          mergeMethod:
            mergeMethod === 'squash' || mergeMethod === 'merge' || mergeMethod === 'rebase'
              ? mergeMethod
              : undefined,
        },
        operatorAuth(now(), 'Enfileirar PR na merge queue do GitHub via MCP'),
      );
      return result.ok
        ? { ok: true, action: result.action, number }
        : { ok: false, error: result.reason };
    },
  };

  const autoMerge: McpToolDef = {
    name: 'nexus_pr_auto_merge',
    description:
      'Enable or disable GitHub auto-merge on the current (or numbered) PR. ' +
      'On a merge-queue branch this is the same as Merge when ready.',
    inputSchema: {
      type: 'object',
      properties: {
        enabled: {
          type: 'boolean',
          description: 'true to enable, false to disable',
        },
        number: { type: 'number' },
        mergeMethod: {
          type: 'string',
          enum: ['squash', 'merge', 'rebase'],
        },
        cwd: { type: 'string' },
      },
      required: ['enabled'],
    },
    handler: async (args, ctx) => {
      const cwd = resolveCwd(ctx, str(args, 'cwd'));
      const remote = deps.remoteUrl(cwd);
      const forge = selectForge(remote);
      if (!forge) {
        return { ok: false, error: 'origin não é um remote hospedado reconhecido' };
      }
      const token = deps.token();
      if (!token) {
        return { ok: false, error: 'GitHub token ausente' };
      }
      const provider = resolveForgeProvider(forge, token, deps.http);
      if (!provider.setAutoMerge) {
        return { ok: false, error: `auto-merge não suportado em ${forge.providerId}` };
      }
      const repo = { owner: forge.owner, name: forge.name, host: forge.host };
      let number =
        typeof args.number === 'number' && Number.isInteger(args.number)
          ? args.number
          : undefined;
      if (!number) {
        const branch = deps.currentBranch(cwd);
        if (!branch || !provider.getReviewForBranch) {
          return { ok: false, error: 'informe number do PR' };
        }
        const listed = await provider.getReviewForBranch(repo, branch);
        if (!listed.ok) return { ok: false, error: listed.reason };
        number = listed.review?.number;
      }
      if (!number) return { ok: false, error: 'nenhum PR aberto nesta branch' };
      if (typeof args.enabled !== 'boolean') {
        throw new Error('enabled is required');
      }
      const mergeMethod = str(args, 'mergeMethod');
      const result = await provider.setAutoMerge(
        repo,
        {
          number,
          enabled: args.enabled,
          mergeMethod:
            mergeMethod === 'squash' || mergeMethod === 'merge' || mergeMethod === 'rebase'
              ? mergeMethod
              : undefined,
        },
        operatorAuth(now(), 'Auto-merge do GitHub via MCP'),
      );
      return result.ok
        ? { ok: true, action: result.action, number, enabled: args.enabled }
        : { ok: false, error: result.reason };
    },
  };

  return [inspect, enqueue, autoMerge];
}
