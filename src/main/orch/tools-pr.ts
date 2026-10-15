import { assertMcpInvocationCurrent, type McpToolDef } from './mcp-protocol';
import { str } from './tool-util';
import { prCreateArgsSchema } from './mcp-args-validation';
import { assertIsolatedWriterGitTool } from './isolated-writer-policy';
import { resolveCwdForScope } from './workspace-path';
import { executionScopeFor } from './gate';
import { defaultGithubHttp } from '../integrations/github-api';
import {
  gitCurrentBranch,
  gitDefaultBranch,
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
  remoteUrl: (cwd: string) => string | null | Promise<string | null>;
  currentBranch: (cwd: string) => string | null | Promise<string | null>;
  defaultBranch: (cwd: string) => string | Promise<string>;
  http: GitHubHttp;
  now?: () => number;
};

const defaultDeps: PrToolDeps = {
  token: getGithubToken,
  remoteUrl: gitRemoteOrigin,
  currentBranch: gitCurrentBranch,
  defaultBranch: gitDefaultBranch,
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

function githubAuthNeeded() {
  return {
    ok: false,
    code: 'auth_needed',
    error: 'GitHub sem autenticação válida neste computador. Conclua gh auth login --hostname github.com ' +
      'no terminal do operador ou conecte GitHub nas integrações do Nexus; depois tente novamente. ' +
      'Um login em outra máquina não autentica este computador.',
  };
}

export function buildPrTools(overrides: Partial<PrToolDeps> = {}): McpToolDef[] {
  const deps: PrToolDeps = { ...defaultDeps, ...overrides };
  const now = deps.now ?? Date.now;

  const create: McpToolDef = {
    name: 'nexus_pr_create',
    description:
      'Create a GitHub pull request from an already published branch in this checkout. ' +
      'Works for the operator without a mission or worktree. Does not push commits. ' +
      'Defaults head to the current branch and base to origin/HEAD (fallback main). ' +
      'Uses the configured GitHub credential or the native gh login on this machine.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 256 },
        body: { type: 'string', maxLength: 65_536, description: 'PR description; empty string is allowed' },
        head: { type: 'string', maxLength: 255, description: 'Published branch within origin (defaults to current branch)' },
        base: { type: 'string', maxLength: 255, description: 'Target branch (defaults to origin/HEAD)' },
        draft: { type: 'boolean' },
        cwd: { type: 'string', description: 'Directory inside the authorized checkout' },
      },
      required: ['title', 'body'],
      additionalProperties: false,
    },
    handler: async (args, ctx, invocation) => {
      assertIsolatedWriterGitTool(ctx, 'nexus_pr_create');
      const input = prCreateArgsSchema.parse(args);
      const cwd = resolveCwd(ctx, input.cwd);
      const forge = selectForge(await deps.remoteUrl(cwd));
      // This credential belongs to GitHub only; never hand it to another forge.
      if (!forge || forge.providerId !== 'github' || forge.host !== 'github.com') {
        return { ok: false, error: 'origin precisa apontar para um repositório do GitHub.com' };
      }
      const head = input.head ?? (await deps.currentBranch(cwd));
      if (!head) return { ok: false, error: 'HEAD destacado: selecione uma branch antes de criar o PR' };
      const base = input.base ?? (await deps.defaultBranch(cwd));
      prCreateArgsSchema.parse({ ...input, head, base });
      if (head === base) return { ok: false, error: 'head e base são a mesma branch; selecione a branch do trabalho' };
      const token = deps.token();
      if (!token) return githubAuthNeeded();
      assertMcpInvocationCurrent(invocation);
      const provider = resolveForgeProvider(forge, token, deps.http);
      try {
        const grantedAt = now();
        const result = await provider.createReview(
          { owner: forge.owner, name: forge.name, host: forge.host },
          { title: input.title, body: input.body, sourceBranch: head, targetBranch: base, draft: input.draft },
          { grantedBy: 'mcp-agent', grantedAt, scope: ['create-review'],
            reason: 'Criar PR do GitHub via MCP', expiresAt: grantedAt + 2 * 60_000 },
        );
        if (result.ok) return { ok: true, url: result.url, number: result.number };
        if (result.apiError?.type === 'auth_required') return githubAuthNeeded();
        return { ok: false, error: result.reason, githubError: result.apiError };
      } catch {
        // Transport errors may embed authorization headers. Never return them.
        return { ok: false, error: 'Falha ao consultar GitHub. Confira a conexão e use nexus_pr_inspect antes de repetir: o PR pode ter sido criado.' };
      }
    },
  };

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
      const remote = await deps.remoteUrl(cwd);
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
        const branch = await deps.currentBranch(cwd);
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
      const remote = await deps.remoteUrl(cwd);
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
        const branch = await deps.currentBranch(cwd);
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
      const remote = await deps.remoteUrl(cwd);
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
        const branch = await deps.currentBranch(cwd);
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

  return [create, inspect, enqueue, autoMerge];
}
