/**
 * Preload bridge for integrations IPC (GitHub / Linear / git SCM / SSH).
 */
import type { IpcRenderer } from 'electron';
import type { IntegrationsApi } from '../shared/integrations-api';
import {
  GITHUB_AUTH_ERROR_CHANNEL,
  GITHUB_DEVICE_CODE_CHANNEL,
  INTEGRATIONS_CHANNELS,
} from '../shared/integrations-types';
import type {
  GitHubAuthErrorPayload,
  GitHubDeviceCodePayload,
} from '../shared/integrations-types';

export function createIntegrationsBridge(ipcRenderer: IpcRenderer): IntegrationsApi {
  return {
    hasGithubToken: () => ipcRenderer.invoke(INTEGRATIONS_CHANNELS.hasGithubToken),
    hasLinearKey: () => ipcRenderer.invoke(INTEGRATIONS_CHANNELS.hasLinearKey),
    setGithubToken: (token: string) =>
      ipcRenderer.invoke(INTEGRATIONS_CHANNELS.setGithubToken, { token }),
    setLinearKey: (token: string) =>
      ipcRenderer.invoke(INTEGRATIONS_CHANNELS.linearSetKey, { token }),
    githubDeviceFlowStatus: () =>
      ipcRenderer.invoke(INTEGRATIONS_CHANNELS.githubDeviceFlowStatus),
    startGithubDeviceFlow: () =>
      ipcRenderer.invoke(INTEGRATIONS_CHANNELS.githubDeviceFlowStart),
    cancelGithubDeviceFlow: () =>
      ipcRenderer.invoke(INTEGRATIONS_CHANNELS.githubDeviceFlowCancel),
    onGithubDeviceCode: (cb) => {
      const listener = (_event: unknown, payload: GitHubDeviceCodePayload) => cb(payload);
      ipcRenderer.on(GITHUB_DEVICE_CODE_CHANNEL, listener);
      return () => {
        ipcRenderer.removeListener(GITHUB_DEVICE_CODE_CHANNEL, listener);
      };
    },
    onGithubAuthError: (cb) => {
      const listener = (_event: unknown, payload: GitHubAuthErrorPayload) => cb(payload);
      ipcRenderer.on(GITHUB_AUTH_ERROR_CHANNEL, listener);
      return () => {
        ipcRenderer.removeListener(GITHUB_AUTH_ERROR_CHANNEL, listener);
      };
    },
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
    gitPush: () => ipcRenderer.invoke(INTEGRATIONS_CHANNELS.gitPush),
    gitPull: (opts) => ipcRenderer.invoke(INTEGRATIONS_CHANNELS.gitPull, opts ?? {}),
    gitDiscard: (paths: string[]) =>
      ipcRenderer.invoke(INTEGRATIONS_CHANNELS.gitDiscard, { paths }),
    gitBranches: () => ipcRenderer.invoke(INTEGRATIONS_CHANNELS.gitBranches),
    gitCheckout: (branch: string, create?: boolean) =>
      ipcRenderer.invoke(INTEGRATIONS_CHANNELS.gitCheckout, { branch, create }),
    createPr: (req) => ipcRenderer.invoke(INTEGRATIONS_CHANNELS.forgeCreatePr, req),
    listPrs: () => ipcRenderer.invoke(INTEGRATIONS_CHANNELS.forgeListPrs),
    branchReview: () =>
      ipcRenderer.invoke(INTEGRATIONS_CHANNELS.forgeBranchReview),
    inspectPr: () => ipcRenderer.invoke(INTEGRATIONS_CHANNELS.forgeInspectPr),
    enqueuePr: (req) =>
      ipcRenderer.invoke(INTEGRATIONS_CHANNELS.forgeEnqueuePr, req ?? {}),
    setAutoMerge: (req) =>
      ipcRenderer.invoke(INTEGRATIONS_CHANNELS.forgeSetAutoMerge, req),
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
