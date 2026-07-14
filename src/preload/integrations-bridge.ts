/**
 * Preload bridge for integrations IPC (GitHub / Linear / git SCM / SSH).
 */
import type { IpcRenderer } from 'electron';
import type { IntegrationsApi } from '../shared/integrations-api';
import { INTEGRATIONS_CHANNELS } from '../shared/integrations-types';

export function createIntegrationsBridge(ipcRenderer: IpcRenderer): IntegrationsApi {
  return {
    hasGithubToken: () => ipcRenderer.invoke(INTEGRATIONS_CHANNELS.hasGithubToken),
    hasLinearKey: () => ipcRenderer.invoke(INTEGRATIONS_CHANNELS.hasLinearKey),
    setGithubToken: (token: string) =>
      ipcRenderer.invoke(INTEGRATIONS_CHANNELS.setGithubToken, { token }),
    setLinearKey: (token: string) =>
      ipcRenderer.invoke(INTEGRATIONS_CHANNELS.linearSetKey, { token }),
    gitDiff: () => ipcRenderer.invoke(INTEGRATIONS_CHANNELS.gitDiff),
    gitStatus: () => ipcRenderer.invoke(INTEGRATIONS_CHANNELS.gitStatus),
    gitStage: (paths: string[]) =>
      ipcRenderer.invoke(INTEGRATIONS_CHANNELS.gitStage, { paths }),
    gitUnstage: (paths: string[]) =>
      ipcRenderer.invoke(INTEGRATIONS_CHANNELS.gitUnstage, { paths }),
    gitCommit: (message: string) =>
      ipcRenderer.invoke(INTEGRATIONS_CHANNELS.gitCommit, { message }),
    gitLog: (count?: number) =>
      ipcRenderer.invoke(INTEGRATIONS_CHANNELS.gitLog, { count: count ?? 20 }),
    gitFileDiff: (input) =>
      ipcRenderer.invoke(INTEGRATIONS_CHANNELS.gitFileDiff, input),
    createPr: (req) => ipcRenderer.invoke(INTEGRATIONS_CHANNELS.forgeCreatePr, req),
    listPrs: () => ipcRenderer.invoke(INTEGRATIONS_CHANNELS.forgeListPrs),
    listGithubIssues: (opts) =>
      ipcRenderer.invoke(INTEGRATIONS_CHANNELS.githubListIssues, opts ?? {}),
    listLinearIssues: (opts) =>
      ipcRenderer.invoke(INTEGRATIONS_CHANNELS.linearListIssues, opts ?? {}),
    startPortForward: (req) =>
      ipcRenderer.invoke(INTEGRATIONS_CHANNELS.sshPortForward, req),
    listPortForwards: () => ipcRenderer.invoke(INTEGRATIONS_CHANNELS.sshPortForwardList),
    closePortForward: (id: string) =>
      ipcRenderer.invoke(INTEGRATIONS_CHANNELS.sshPortForwardClose, id),
    remoteWorktreeCreate: (req) =>
      ipcRenderer.invoke(INTEGRATIONS_CHANNELS.remoteWorktreeCreate, req),
  };
}
