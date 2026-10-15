/**
 * Integrations IPC — forge PR, GitHub/Linear issues, git diff, port forward, remote worktree.
 */
import { ipcMain, dialog, BrowserWindow } from 'electron';
import { porcelainZToLf } from '../../shared/git-scm';
import {
  INTEGRATIONS_CHANNELS,
  createPrSchema,
  enqueuePrSchema,
  gitCheckoutSchema,
  gitCommitSchema,
  gitFileDiffSchema,
  gitLogSchema,
  gitPathsSchema,
  gitPullSchema,
  listIssuesSchema,
  portForwardSchema,
  remoteWorktreeSchema,
  setAutoMergeSchema,
  setTokenSchema,
} from '../../shared/integrations-types';
import {
  getRendererWorkspaceScope,
  requireRendererWorkspaceScope,
} from '../persistence/renderer-workspace-scope';
import { enumerateSshAgentFingerprints } from './ssh-agent-identities';
import {
  defaultGithubHttp,
  listGithubIssues,
  listGithubPulls,
} from './github-api';
import {
  GITHUB_DEVICE_FLOW_SCOPES,
  GITHUB_DEVICE_FLOW_UNAVAILABLE_HINT,
  createFetchDeviceAuth,
  getGithubAuthenticatedUser,
  resolveGithubOauthClientId,
} from './github-device-auth';
import { GitHubDeviceFlowService } from '../../vendor/emdash/github/github-device-flow';
import { getIntegrationsSettings } from '../persistence/settings-store';
import { listLinearIssues } from './linear-api';
import {
  gitBranchPushState,
  gitBranches,
  gitCheckoutBranch,
  gitCommitMessage,
  gitCurrentBranch,
  gitDefaultBranch,
  gitDiff,
  gitDiscard,
  gitFileDiff,
  gitLogOneline,
  gitPullCurrentBranch,
  gitPushCurrentBranch,
  gitRemoteOrigin,
  gitScmStatus,
  gitStage,
  gitUnstage,
  parseGithubRepo,
} from './git-workspace';
import { orchestratePrCreation } from './pr-orchestration';
import {
  resolveForgeProvider,
  selectForge,
} from '../source-control/forge-registry';
import type {
  ForgeAuthorization,
  ForgeProviderId,
} from '../source-control/forge-provider';
import {
  getGithubToken,
  getGitlabToken,
  getLinearKey,
  hasGithubToken,
  hasLinearKey,
  setGithubToken,
  setLinearKey,
} from './token-vault';

import {
  closePortForward,
  listPortForwards,
  startPortForward,
} from './port-forward';
import { createSsh2Transport, remoteWorktreeCreate } from './ssh2-transport';
import { createSshSessionManager } from '../remote/ssh/ssh-session-manager';
import { resolveSshConnectDefaults } from '../remote/ssh/ssh-config-service';
import type { SshProxySpec } from '../remote/ssh/proxied-connect-config';
import { createRemoteHostCapability } from '../remote/remote-capability';

/** Token da forge do remote atual (vault/env + sessão gh/glab). */
function forgeTokenFor(providerId: ForgeProviderId): string | null {
  if (providerId === 'gitlab') return getGitlabToken();
  if (providerId === 'github') return getGithubToken();
  return null;
}

function forgeTokenMissingHint(providerId: ForgeProviderId): string {
  if (providerId === 'gitlab') {
    return 'Token GitLab ausente — rode `glab auth login` ou defina NEXUS_GITLAB_TOKEN.';
  }
  return 'GitHub token missing — cole um PAT em Integrações ou rode `gh auth login`.';
}

function workspaceCwd(event: Electron.IpcMainInvokeEvent): string {
  const scope = requireRendererWorkspaceScope(event.sender);
  return scope.rootRealPath;
}

/** The single in-flight device flow (one browser login at a time). */
let activeDeviceFlow: GitHubDeviceFlowService | null = null;

function githubDeviceFlowClientId(): string | null {
  return resolveGithubOauthClientId(process.env, getIntegrationsSettings());
}

function deviceFlowUnavailable(): { ok: false; error: string } {
  return { ok: false, error: GITHUB_DEVICE_FLOW_UNAVAILABLE_HINT };
}

export function registerIntegrationsIpc(): void {
  ipcMain.handle(INTEGRATIONS_CHANNELS.hasGithubToken, () => hasGithubToken());
  ipcMain.handle(INTEGRATIONS_CHANNELS.hasLinearKey, () => hasLinearKey());

  ipcMain.handle(INTEGRATIONS_CHANNELS.githubDeviceFlowStatus, () => {
    if (githubDeviceFlowClientId()) return { available: true };
    return { available: false, hint: GITHUB_DEVICE_FLOW_UNAVAILABLE_HINT };
  });

  ipcMain.handle(INTEGRATIONS_CHANNELS.githubDeviceFlowStart, async (event) => {
    const clientId = githubDeviceFlowClientId();
    if (!clientId) return deviceFlowUnavailable();
    activeDeviceFlow?.cancel();
    const service = new GitHubDeviceFlowService({
      // Same encrypted vault slot the PAT flow uses (token-vault).
      storeToken: (token) => setGithubToken(token),
      identityClient: { getAuthenticatedUser: (token) => getGithubAuthenticatedUser(token) },
      events: {
        emit: (channel, payload) => {
          if (typeof channel === 'string' && !event.sender.isDestroyed()) {
            event.sender.send(channel, payload);
          }
        },
      },
      createDeviceAuth: createFetchDeviceAuth,
      config: { clientId, scopes: [...GITHUB_DEVICE_FLOW_SCOPES] },
    });
    activeDeviceFlow = service;
    try {
      const result = await service.start();
      if (!result.success) return { ok: false, error: result.error };
      return {
        ok: true,
        user: { login: result.user.login, avatarUrl: result.user.avatar_url },
      };
    } finally {
      if (activeDeviceFlow === service) activeDeviceFlow = null;
    }
  });

  ipcMain.handle(INTEGRATIONS_CHANNELS.githubDeviceFlowCancel, () => {
    activeDeviceFlow?.cancel();
    activeDeviceFlow = null;
    return { ok: true };
  });

  ipcMain.handle(INTEGRATIONS_CHANNELS.setGithubToken, (_e, raw) => {
    const parsed = setTokenSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'invalid token' };
    return setGithubToken(parsed.data.token);
  });

  ipcMain.handle(INTEGRATIONS_CHANNELS.linearSetKey, (_e, raw) => {
    const parsed = setTokenSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'invalid key' };
    return setLinearKey(parsed.data.token);
  });

  ipcMain.handle(INTEGRATIONS_CHANNELS.gitDiff, async (event) => {
    try {
      const cwd = workspaceCwd(event);
      const diff = await gitDiff(cwd);
      if (!diff.ok) return diff;
      return {
        ok: true as const,
        diff: diff.diff,
        branch: await gitCurrentBranch(cwd),
        remote: await gitRemoteOrigin(cwd),
      };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(INTEGRATIONS_CHANNELS.gitStatus, async (event) => {
    try {
      const cwd = workspaceCwd(event);
      const scm = await gitScmStatus(cwd);
      if (!scm.ok) return scm;
      // Legacy callers expect a printable LF `status` string.
      return {
        ...scm,
        status: porcelainZToLf(scm.raw),
      };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(INTEGRATIONS_CHANNELS.gitStage, async (event, raw) => {
    const parsed = gitPathsSchema.safeParse(raw);
    if (!parsed.success) return { ok: false as const, error: 'invalid paths' };
    try {
      return await gitStage(workspaceCwd(event), parsed.data.paths);
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(INTEGRATIONS_CHANNELS.gitUnstage, async (event, raw) => {
    const parsed = gitPathsSchema.safeParse(raw);
    if (!parsed.success) return { ok: false as const, error: 'invalid paths' };
    try {
      return await gitUnstage(workspaceCwd(event), parsed.data.paths);
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(INTEGRATIONS_CHANNELS.gitCommit, async (event, raw) => {
    const parsed = gitCommitSchema.safeParse(raw);
    if (!parsed.success) return { ok: false as const, error: 'invalid commit message' };
    try {
      return await gitCommitMessage(workspaceCwd(event), parsed.data.message);
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(INTEGRATIONS_CHANNELS.gitLog, async (event, raw) => {
    const parsed = gitLogSchema.safeParse(raw ?? {});
    if (!parsed.success) return { ok: false as const, error: 'invalid log request' };
    try {
      return await gitLogOneline(workspaceCwd(event), parsed.data.count);
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(INTEGRATIONS_CHANNELS.gitFileDiff, async (event, raw) => {
    const parsed = gitFileDiffSchema.safeParse(raw);
    if (!parsed.success) return { ok: false as const, error: 'invalid diff request' };
    try {
      return await gitFileDiff(workspaceCwd(event), parsed.data.path, {
        staged: parsed.data.staged,
        untracked: parsed.data.untracked,
      });
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(INTEGRATIONS_CHANNELS.gitPush, async (event) => {
    try {
      const cwd = workspaceCwd(event);
      const branch = await gitCurrentBranch(cwd);
      if (!branch) return { ok: false as const, error: 'sem branch para enviar' };
      return await gitPushCurrentBranch(cwd, branch);
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(INTEGRATIONS_CHANNELS.gitPull, async (event, raw) => {
    const parsed = gitPullSchema.safeParse(raw ?? {});
    try {
      return await gitPullCurrentBranch(workspaceCwd(event), parsed.success ? parsed.data?.rebase : false);
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(INTEGRATIONS_CHANNELS.gitDiscard, async (event, raw) => {
    const parsed = gitPathsSchema.safeParse(raw);
    if (!parsed.success) return { ok: false as const, error: 'caminhos inválidos para descarte' };
    try {
      return await gitDiscard(workspaceCwd(event), parsed.data.paths);
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(INTEGRATIONS_CHANNELS.gitBranches, async (event) => {
    try {
      return await gitBranches(workspaceCwd(event));
    } catch (err) {
      return { ok: false as const, current: null, branches: [], error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(INTEGRATIONS_CHANNELS.gitCheckout, async (event, raw) => {
    const parsed = gitCheckoutSchema.safeParse(raw);
    if (!parsed.success) return { ok: false as const, error: 'dados de branch inválidos' };
    try {
      return await gitCheckoutBranch(workspaceCwd(event), parsed.data.branch, parsed.data.create);
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });


  ipcMain.handle(INTEGRATIONS_CHANNELS.forgeCreatePr, async (event, raw) => {
    const parsed = createPrSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'invalid request' };
    try {
      const cwd = workspaceCwd(event);
      const forge = selectForge(await gitRemoteOrigin(cwd));
      if (!forge) {
        return { ok: false, error: 'origin não é um remote hospedado reconhecido' };
      }
      const token = forgeTokenFor(forge.providerId);
      if (!token) {
        return { ok: false, error: forgeTokenMissingHint(forge.providerId) };
      }
      // Camada forge de verdade (paridade Orca): GitHub E GitLab criam
      // review pelo MESMO caminho autorizado+auditado do provider.
      const provider = resolveForgeProvider(forge, token, defaultGithubHttp);
      if (!provider.enabled || !provider.supportsReviewCreation) {
        return {
          ok: false,
          error: `criação de PR/MR ainda não suportada para ${forge.providerId}`,
        };
      }
      const repo = { owner: forge.owner, name: forge.name, host: forge.host };
      const authorization: ForgeAuthorization = {
        grantedBy: 'operator-ui',
        grantedAt: Date.now(),
        scope: ['create-review'],
        reason: 'Criar PR/MR pelo painel de integrações',
        expiresAt: Date.now() + 2 * 60_000,
      };
      // Regras de PR (no-self-target + push gate needsPush = !isOnRemote ||
      // aheadCount > 0) vivem na função pura orchestratePrCreation, testada
      // em pr-orchestration.test.ts.
      return orchestratePrCreation(
        { sourceBranch: parsed.data.sourceBranch, targetBranch: parsed.data.targetBranch },
        {
          currentBranch: () => gitCurrentBranch(cwd),
          defaultBranch: () => gitDefaultBranch(cwd),
          branchPushState: (branch) => gitBranchPushState(cwd, branch),
          push: (branch) => gitPushCurrentBranch(cwd, branch),
          host: forge.host,
          createPr: async ({ sourceBranch, targetBranch }) => {
            const result = await provider.createReview(
              repo,
              {
                title: parsed.data.title,
                body: parsed.data.body ?? '',
                sourceBranch,
                targetBranch,
                draft: parsed.data.draft,
              },
              authorization,
            );
            return result.ok
              ? { ok: true, url: result.url, number: result.number }
              : { ok: false, error: result.reason, githubError: result.apiError };
          },
        },
      );
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(INTEGRATIONS_CHANNELS.forgeBranchReview, async (event) => {
    try {
      const cwd = workspaceCwd(event);
      const forge = selectForge(await gitRemoteOrigin(cwd));
      if (!forge) {
        return { ok: false, error: 'origin não é um remote hospedado reconhecido' };
      }
      const token = forgeTokenFor(forge.providerId);
      if (!token) {
        return { ok: false, error: forgeTokenMissingHint(forge.providerId) };
      }
      const branch = await gitCurrentBranch(cwd);
      if (!branch) return { ok: false, error: 'não consegui resolver a branch atual' };
      const provider = resolveForgeProvider(forge, token, defaultGithubHttp);
      if (!provider.getReviewForBranch) {
        return { ok: true, branch, review: null };
      }
      const result = await provider.getReviewForBranch(
        { owner: forge.owner, name: forge.name, host: forge.host },
        branch,
      );
      if (!result.ok) {
        return { ok: false, error: result.reason, githubError: result.apiError };
      }
      return { ok: true, branch, review: result.review };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(INTEGRATIONS_CHANNELS.forgeInspectPr, async (event) => {
    try {
      const cwd = workspaceCwd(event);
      const forge = selectForge(await gitRemoteOrigin(cwd));
      if (!forge) {
        return { ok: false, error: 'origin não é um remote hospedado reconhecido' };
      }
      const token = forgeTokenFor(forge.providerId);
      if (!token) {
        return { ok: false, error: forgeTokenMissingHint(forge.providerId) };
      }
      const branch = await gitCurrentBranch(cwd);
      if (!branch) return { ok: false, error: 'não consegui resolver a branch atual' };
      const provider = resolveForgeProvider(forge, token, defaultGithubHttp);
      if (!provider.getReviewForBranch || !provider.inspectReview) {
        return { ok: true, branch, review: null };
      }
      const listed = await provider.getReviewForBranch(
        { owner: forge.owner, name: forge.name, host: forge.host },
        branch,
      );
      if (!listed.ok) {
        return { ok: false, error: listed.reason, githubError: listed.apiError };
      }
      if (!listed.review) return { ok: true, branch, review: null };
      const inspected = await provider.inspectReview(
        { owner: forge.owner, name: forge.name, host: forge.host },
        listed.review.number,
      );
      if (!inspected.ok) {
        return { ok: false, error: inspected.reason, githubError: inspected.apiError };
      }
      return { ok: true, branch, review: inspected.review };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(INTEGRATIONS_CHANNELS.forgeEnqueuePr, async (event, raw) => {
    const parsed = enqueuePrSchema.safeParse(raw ?? {});
    if (!parsed.success) return { ok: false, error: 'invalid request' };
    try {
      const cwd = workspaceCwd(event);
      const forge = selectForge(await gitRemoteOrigin(cwd));
      if (!forge) {
        return { ok: false, error: 'origin não é um remote hospedado reconhecido' };
      }
      const token = forgeTokenFor(forge.providerId);
      if (!token) {
        return { ok: false, error: forgeTokenMissingHint(forge.providerId) };
      }
      const provider = resolveForgeProvider(forge, token, defaultGithubHttp);
      if (!provider.enqueueMergeQueue) {
        return { ok: false, error: `merge queue ainda não suportada para ${forge.providerId}` };
      }
      let number = parsed.data.number;
      if (!number) {
        const branch = await gitCurrentBranch(cwd);
        if (!branch || !provider.getReviewForBranch) {
          return { ok: false, error: 'informe o número do PR' };
        }
        const listed = await provider.getReviewForBranch(
          { owner: forge.owner, name: forge.name, host: forge.host },
          branch,
        );
        if (!listed.ok) return { ok: false, error: listed.reason, githubError: listed.apiError };
        number = listed.review?.number;
      }
      if (!number) return { ok: false, error: 'nenhum PR aberto nesta branch' };
      const authorization: ForgeAuthorization = {
        grantedBy: 'operator-ui',
        grantedAt: Date.now(),
        scope: ['enqueue-merge-queue', 'auto-merge'],
        reason: 'Enfileirar PR na merge queue do GitHub',
        expiresAt: Date.now() + 2 * 60_000,
      };
      const result = await provider.enqueueMergeQueue(
        { owner: forge.owner, name: forge.name, host: forge.host },
        {
          number,
          mode: parsed.data.mode,
          mergeMethod: parsed.data.mergeMethod,
        },
        authorization,
      );
      return result.ok
        ? { ok: true, action: result.action, number }
        : { ok: false, error: result.reason, githubError: result.apiError };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(INTEGRATIONS_CHANNELS.forgeSetAutoMerge, async (event, raw) => {
    const parsed = setAutoMergeSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'invalid request' };
    try {
      const cwd = workspaceCwd(event);
      const forge = selectForge(await gitRemoteOrigin(cwd));
      if (!forge) {
        return { ok: false, error: 'origin não é um remote hospedado reconhecido' };
      }
      const token = forgeTokenFor(forge.providerId);
      if (!token) {
        return { ok: false, error: forgeTokenMissingHint(forge.providerId) };
      }
      const provider = resolveForgeProvider(forge, token, defaultGithubHttp);
      if (!provider.setAutoMerge) {
        return { ok: false, error: `auto-merge ainda não suportado para ${forge.providerId}` };
      }
      let number = parsed.data.number;
      if (!number) {
        const branch = await gitCurrentBranch(cwd);
        if (!branch || !provider.getReviewForBranch) {
          return { ok: false, error: 'informe o número do PR' };
        }
        const listed = await provider.getReviewForBranch(
          { owner: forge.owner, name: forge.name, host: forge.host },
          branch,
        );
        if (!listed.ok) return { ok: false, error: listed.reason, githubError: listed.apiError };
        number = listed.review?.number;
      }
      if (!number) return { ok: false, error: 'nenhum PR aberto nesta branch' };
      const authorization: ForgeAuthorization = {
        grantedBy: 'operator-ui',
        grantedAt: Date.now(),
        scope: ['auto-merge', 'enqueue-merge-queue'],
        reason: 'Ligar ou desligar auto-merge do GitHub',
        expiresAt: Date.now() + 2 * 60_000,
      };
      const result = await provider.setAutoMerge(
        { owner: forge.owner, name: forge.name, host: forge.host },
        {
          number,
          enabled: parsed.data.enabled,
          mergeMethod: parsed.data.mergeMethod,
        },
        authorization,
      );
      return result.ok
        ? { ok: true, action: result.action, number }
        : { ok: false, error: result.reason, githubError: result.apiError };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(INTEGRATIONS_CHANNELS.forgeListPrs, async (event) => {
    const token = getGithubToken();
    if (!token) return { ok: false, error: 'GitHub token missing' };
    try {
      const cwd = workspaceCwd(event);
      const repo = parseGithubRepo(await gitRemoteOrigin(cwd));
      if (!repo) return { ok: false, error: 'origin is not a GitHub remote' };
      return listGithubPulls(token, repo.owner, repo.name);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(INTEGRATIONS_CHANNELS.githubListIssues, async (event, raw) => {
    const parsed = listIssuesSchema.safeParse(raw ?? {});
    if (!parsed.success) return { ok: false, error: 'invalid request' };
    const token = getGithubToken();
    if (!token) return { ok: false, error: 'GitHub token missing' };
    try {
      const cwd = workspaceCwd(event);
      const repo = parseGithubRepo(await gitRemoteOrigin(cwd));
      if (!repo) return { ok: false, error: 'origin is not a GitHub remote' };
      return listGithubIssues(token, repo.owner, repo.name, parsed.data);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(INTEGRATIONS_CHANNELS.linearListIssues, async (_event, raw) => {
    const parsed = listIssuesSchema.safeParse(raw ?? {});
    if (!parsed.success) return { ok: false, error: 'invalid request' };
    const key = getLinearKey();
    if (!key) return { ok: false, error: 'Linear API key missing' };
    return listLinearIssues(key, parsed.data.limit);
  });

  ipcMain.handle(INTEGRATIONS_CHANNELS.sshPortForward, async (_e, raw) => {
    const parsed = portForwardSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'invalid request' };
    return startPortForward(parsed.data);
  });

  ipcMain.handle(INTEGRATIONS_CHANNELS.sshPortForwardList, () => listPortForwards());

  ipcMain.handle(INTEGRATIONS_CHANNELS.sshPortForwardClose, (_e, raw) => {
    const id = typeof raw === 'string' ? raw : (raw as { id?: string })?.id;
    if (!id) return { ok: false, error: 'missing id' };
    return { ok: closePortForward(id) };
  });

  ipcMain.handle(INTEGRATIONS_CHANNELS.remoteWorktreeCreate, async (event, raw) => {
    const parsed = remoteWorktreeSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'invalid request' };
    // Scope must exist (project open); remote path is explicit.
    getRendererWorkspaceScope(event.sender);
    try {
      // When `host` is a ~/.ssh/config alias, apply the effective OpenSSH
      // settings (hostname/port/ProxyJump/ProxyCommand) resolved via the
      // vendored ssh -G resolver. A non-alias host is NEVER rewritten, and
      // the explicit username always wins. Host key verification is
      // unaffected: the transport pins the RESOLVED host:port in the
      // known-hosts vault either way.
      const sshDefaults = await resolveSshConnectDefaults(parsed.data.host);
      const proxy: SshProxySpec | undefined = sshDefaults?.proxyJump
        ? { kind: 'jump', jumpSpec: sshDefaults.proxyJump }
        : sshDefaults?.proxyCommand
          ? { kind: 'command', command: sshDefaults.proxyCommand }
          : undefined;
      const transport = createSsh2Transport({ proxy });
      const mgr = createSshSessionManager();
      const cap = createRemoteHostCapability({
        kind: 'ssh',
        hostId: parsed.data.host,
        displayName: `${parsed.data.username}@${parsed.data.host}`,
        scope: requireRendererWorkspaceScope(event.sender),
        paired: true,
      });
      const session = await mgr.connect(
        cap,
        {
          host: sshDefaults?.host ?? parsed.data.host,
          port: sshDefaults?.port,
          username: parsed.data.username,
          auth: { kind: 'agent', allowedFingerprints: await enumerateSshAgentFingerprints() },
          // Trust-on-first-use: show the SHA256 host-key fingerprint in a native
          // (non-forgeable) dialog before pinning it. A changed key is rejected
          // by the transport regardless — this hook only gates the first sight.
          confirmUnknownHostKey: ({ host, port, fingerprint }) => {
            const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
            const opts = {
              type: 'warning' as const,
              buttons: ['Cancelar', 'Confiar e conectar'],
              defaultId: 0,
              cancelId: 0,
              title: 'Chave SSH desconhecida',
              message: `Primeira conexão a ${host}:${port}. Confirme a impressão digital da chave do host:`,
              detail: `${fingerprint}\n\nConfie apenas se ela corresponde à chave real do servidor (verifique fora de banda, ex.: ssh-keyscan).`,
              noLink: true,
            };
            return (
              (win
                ? dialog.showMessageBoxSync(win, opts)
                : dialog.showMessageBoxSync(opts)) === 1
            );
          },
        },
        transport,
      );
      try {
        // Session manager rejects empty allowlist; use privateKey path in production.
        // For agent auth with '*', relax: reconnect with password-less agent if ssh2 present.
        return await remoteWorktreeCreate(
          session.transport,
          parsed.data.remotePath,
          parsed.data.branch,
        );
      } finally {
        await session.disconnect();
      }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
}
