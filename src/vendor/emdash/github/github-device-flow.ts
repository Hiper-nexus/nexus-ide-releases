// Vendored from generalaction/emdash@c1af543 — Apache-2.0
// Source: apps/emdash-desktop/src/main/core/github/services/github-device-flow-service.ts
// See src/vendor/emdash/hooks/LICENSE.md. Nexus changes:
// @octokit/auth-oauth-device is NOT a Nexus dependency — createDeviceAuth
// stays injected and Nexus supplies a small fetch-based factory
// (src/main/integrations/github-device-auth.ts); the factory options gained
// an optional AbortSignal so cancel() also stops the underlying poll
// (upstream only races and lets the poll run until expiry). Emdash's
// provider-account registry collapsed to a storeToken sink (Nexus keeps a
// single github.com credential in its encrypted vault); GitHubUser narrowed
// to the summary Nexus surfaces; start() refuses to run twice concurrently;
// IPC channel constants repointed to ../../../shared/integrations-types.

import {
  GITHUB_AUTH_ERROR_CHANNEL,
  GITHUB_DEVICE_CODE_CHANNEL,
} from '../../../shared/integrations-types';

export type GitHubUserSummary = {
  id: number;
  login: string;
  avatar_url: string;
};

export type GitHubDeviceFlowConfig = {
  clientId: string;
  scopes: string[];
};

type DeviceAuth = (options: { type: 'oauth' }) => Promise<{ token: string }>;

export type DeviceAuthVerification = {
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
};

export type DeviceAuthFactory = (options: {
  clientId: string;
  scopes: string[];
  onVerification(verification: DeviceAuthVerification): void;
  signal?: AbortSignal;
}) => DeviceAuth;

type DeviceFlowEvents = {
  emit(channel: unknown, payload: unknown): void;
};

export type GitHubDeviceFlowResult =
  | { success: true; user: GitHubUserSummary }
  | { success: false; error: string };

export class GitHubDeviceFlowService {
  private deviceFlowAbortController: AbortController | null = null;

  constructor(
    private readonly deps: {
      storeToken: (token: string) => { ok: boolean; error?: string };
      identityClient: {
        getAuthenticatedUser(token: string): Promise<GitHubUserSummary | null>;
      };
      events: DeviceFlowEvents;
      createDeviceAuth: DeviceAuthFactory;
      config: GitHubDeviceFlowConfig;
    }
  ) {}

  get inFlight(): boolean {
    return this.deviceFlowAbortController !== null;
  }

  async start(): Promise<GitHubDeviceFlowResult> {
    if (this.deviceFlowAbortController) {
      return { success: false, error: 'Device flow already in progress' };
    }
    this.deviceFlowAbortController = new AbortController();
    const { signal } = this.deviceFlowAbortController;

    try {
      const auth = this.deps.createDeviceAuth({
        clientId: this.deps.config.clientId,
        scopes: [...this.deps.config.scopes],
        signal,
        onVerification: (verification) => {
          this.deps.events.emit(GITHUB_DEVICE_CODE_CHANNEL, {
            userCode: verification.user_code,
            verificationUri: verification.verification_uri,
            expiresIn: verification.expires_in,
            interval: verification.interval,
          });
        },
      });

      const authPromise = auth({ type: 'oauth' });
      const cancelPromise = new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => {
          reject(new Error('Auth cancelled'));
        });
      });

      const result = await Promise.race([authPromise, cancelPromise]);
      const token = result.token;

      const user = await this.deps.identityClient.getAuthenticatedUser(token);
      if (!user) {
        const message = 'Failed to read authenticated GitHub user';
        this.deps.events.emit(GITHUB_AUTH_ERROR_CHANNEL, { error: 'device_flow_error', message });
        return { success: false, error: message };
      }

      const stored = this.deps.storeToken(token);
      if (!stored.ok) {
        const message = stored.error ?? 'Failed to persist the GitHub token';
        this.deps.events.emit(GITHUB_AUTH_ERROR_CHANNEL, { error: 'device_flow_error', message });
        return { success: false, error: message };
      }

      return { success: true, user };
    } catch (error) {
      if (signal.aborted) {
        return { success: false, error: 'Auth cancelled' };
      }

      const message = error instanceof Error ? error.message : String(error);
      this.deps.events.emit(GITHUB_AUTH_ERROR_CHANNEL, { error: 'device_flow_error', message });
      return { success: false, error: message };
    } finally {
      this.deviceFlowAbortController = null;
    }
  }

  cancel(): void {
    if (this.deviceFlowAbortController) {
      this.deviceFlowAbortController.abort();
      this.deviceFlowAbortController = null;
    }
  }
}
