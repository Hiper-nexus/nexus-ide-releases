/**
 * Integrations IPC — forge PR, GitHub/Linear issues, git diff, port forward, remote worktree.
 */
import { ipcMain, dialog, BrowserWindow } from 'electron';
import {
  INTEGRATIONS_CHANNELS,
  createPrSchema,
  listIssuesSchema,
  portForwardSchema,
  remoteWorktreeSchema,
  setTokenSchema,
} from '../../shared/integrations-types';
import {
  getRendererWorkspaceScope,
  requireRendererWorkspaceScope,
} from '../persistence/renderer-workspace-scope';
import {
  createGithubPr,
  listGithubIssues,
  listGithubPulls,
} from './github-api';
import { listLinearIssues } from './linear-api';
import {
  gitCurrentBranch,
  gitDiff,
  gitRemoteOrigin,
  gitStatusShort,
  parseGithubRepo,
} from './git-workspace';
import {
  getGithubToken,
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
import { createRemoteHostCapability } from '../remote/remote-capability';

function workspaceCwd(event: Electron.IpcMainInvokeEvent): string {
  const scope = requireRendererWorkspaceScope(event.sender);
  return scope.rootRealPath;
}

export function registerIntegrationsIpc(): void {
  ipcMain.handle(INTEGRATIONS_CHANNELS.hasGithubToken, () => hasGithubToken());
  ipcMain.handle(INTEGRATIONS_CHANNELS.hasLinearKey, () => hasLinearKey());

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

  ipcMain.handle(INTEGRATIONS_CHANNELS.gitDiff, (event) => {
    try {
      const cwd = workspaceCwd(event);
      const diff = gitDiff(cwd);
      if (!diff.ok) return diff;
      return {
        ok: true as const,
        diff: diff.diff,
        branch: gitCurrentBranch(cwd),
        remote: gitRemoteOrigin(cwd),
      };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(INTEGRATIONS_CHANNELS.gitStatus, (event) => {
    try {
      const cwd = workspaceCwd(event);
      return {
        ok: true as const,
        status: gitStatusShort(cwd),
        branch: gitCurrentBranch(cwd),
        remote: gitRemoteOrigin(cwd),
      };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(INTEGRATIONS_CHANNELS.forgeCreatePr, async (event, raw) => {
    const parsed = createPrSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'invalid request' };
    const token = getGithubToken();
    if (!token) return { ok: false, error: 'GitHub token missing — set in Integrations' };
    try {
      const cwd = workspaceCwd(event);
      const repo = parseGithubRepo(gitRemoteOrigin(cwd));
      if (!repo) return { ok: false, error: 'origin is not a GitHub remote' };
      const branch = parsed.data.sourceBranch ?? gitCurrentBranch(cwd);
      if (!branch) return { ok: false, error: 'cannot resolve current branch' };
      const target = parsed.data.targetBranch ?? 'main';
      return createGithubPr(token, repo.owner, repo.name, {
        title: parsed.data.title,
        body: parsed.data.body ?? '',
        sourceBranch: branch,
        targetBranch: target,
        draft: parsed.data.draft,
      });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(INTEGRATIONS_CHANNELS.forgeListPrs, async (event) => {
    const token = getGithubToken();
    if (!token) return { ok: false, error: 'GitHub token missing' };
    try {
      const cwd = workspaceCwd(event);
      const repo = parseGithubRepo(gitRemoteOrigin(cwd));
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
      const repo = parseGithubRepo(gitRemoteOrigin(cwd));
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

  ipcMain.handle(INTEGRATIONS_CHANNELS.sshPortForward, (_e, raw) => {
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
      const transport = createSsh2Transport();
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
          host: parsed.data.host,
          username: parsed.data.username,
          auth: { kind: 'agent', allowedFingerprints: ['*'] },
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
