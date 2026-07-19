// Vendored from generalaction/emdash@c1af543 — Apache-2.0
// Source: apps/emdash-desktop/src/main/core/github/services/github-device-flow-service.db.test.ts
// See src/vendor/emdash/hooks/LICENSE.md. Nexus changes: upstream's
// DB-fixture suite rewritten pure — the account registry is a storeToken
// sink mock, the octokit device auth is a factory mock (emits the code,
// resolves/aborts the poll), and the new storeToken-failure + in-flight
// guard paths are covered.

import { describe, expect, it, vi } from 'vitest';
import {
  GITHUB_AUTH_ERROR_CHANNEL,
  GITHUB_DEVICE_CODE_CHANNEL,
} from '../../../shared/integrations-types';
import {
  GitHubDeviceFlowService,
  type DeviceAuthFactory,
  type GitHubUserSummary,
} from './github-device-flow';

const user: GitHubUserSummary = {
  id: 42,
  login: 'monalisa',
  avatar_url: 'https://avatars.githubusercontent.com/u/42',
};

function makeService(over: {
  storeToken?: (token: string) => { ok: boolean; error?: string };
  getAuthenticatedUser?: (token: string) => Promise<GitHubUserSummary | null>;
  emit?: (channel: unknown, payload: unknown) => void;
  createDeviceAuth?: DeviceAuthFactory;
}) {
  const emit = over.emit ?? vi.fn();
  const storeToken = over.storeToken ?? vi.fn(() => ({ ok: true as const }));
  const getAuthenticatedUser = over.getAuthenticatedUser ?? vi.fn(async () => user);
  const createDeviceAuth =
    over.createDeviceAuth ??
    (({ onVerification }) => {
      onVerification({
        user_code: 'ABCD-1234',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      });
      return async () => ({ token: 'gho_device' });
    });
  const service = new GitHubDeviceFlowService({
    storeToken,
    identityClient: { getAuthenticatedUser },
    events: { emit },
    createDeviceAuth,
    config: { clientId: 'client-id', scopes: ['repo'] },
  });
  return { service, emit, storeToken, getAuthenticatedUser };
}

describe('GitHubDeviceFlowService', () => {
  it('emits the device code, polls to a token and stores it in the vault sink', async () => {
    const { service, emit, storeToken } = makeService({});

    await expect(service.start()).resolves.toEqual({ success: true, user });

    expect(emit).toHaveBeenCalledWith(GITHUB_DEVICE_CODE_CHANNEL, {
      userCode: 'ABCD-1234',
      verificationUri: 'https://github.com/login/device',
      expiresIn: 900,
      interval: 5,
    });
    expect(storeToken).toHaveBeenCalledWith('gho_device');
  });

  it('passes clientId/scopes and an abort signal to the device auth factory', async () => {
    const createDeviceAuth = vi.fn<DeviceAuthFactory>(
      () => async () => ({ token: 'gho_device' })
    );
    const { service } = makeService({ createDeviceAuth });

    await service.start();

    expect(createDeviceAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: 'client-id',
        scopes: ['repo'],
        signal: expect.any(AbortSignal),
      })
    );
  });

  it('returns an error when the token cannot identify a user', async () => {
    const emit = vi.fn();
    const storeToken = vi.fn(() => ({ ok: true as const }));
    const { service } = makeService({
      emit,
      storeToken,
      getAuthenticatedUser: vi.fn(async () => null),
    });

    await expect(service.start()).resolves.toEqual({
      success: false,
      error: 'Failed to read authenticated GitHub user',
    });
    expect(storeToken).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(
      GITHUB_AUTH_ERROR_CHANNEL,
      expect.objectContaining({ error: 'device_flow_error' })
    );
  });

  it('returns an error when the vault sink refuses the token', async () => {
    const { service } = makeService({
      storeToken: () => ({ ok: false, error: 'secure storage unavailable' }),
    });

    await expect(service.start()).resolves.toEqual({
      success: false,
      error: 'secure storage unavailable',
    });
  });

  it('cancel() aborts an in-flight flow and resolves as Auth cancelled', async () => {
    let resolveAuth: ((value: { token: string }) => void) | null = null;
    const createDeviceAuth: DeviceAuthFactory = () =>
      () =>
        new Promise<{ token: string }>((resolve) => {
          resolveAuth = resolve;
        });
    const { service, storeToken } = makeService({ createDeviceAuth });

    const started = service.start();
    expect(service.inFlight).toBe(true);
    service.cancel();
    expect(service.inFlight).toBe(false);

    await expect(started).resolves.toEqual({ success: false, error: 'Auth cancelled' });
    // A late token from the abandoned poll must not be stored. TS narrows the
    // binding to null (it is only set inside the promise executor), so cast.
    (resolveAuth as ((value: { token: string }) => void) | null)?.({
      token: 'gho_late',
    });
    expect(storeToken).not.toHaveBeenCalled();
  });

  it('surfaces factory errors through the auth error channel', async () => {
    const emit = vi.fn();
    const createDeviceAuth: DeviceAuthFactory = () => async () => {
      throw new Error('expired_token');
    };
    const { service } = makeService({ emit, createDeviceAuth });

    await expect(service.start()).resolves.toEqual({
      success: false,
      error: 'expired_token',
    });
    expect(emit).toHaveBeenCalledWith(GITHUB_AUTH_ERROR_CHANNEL, {
      error: 'device_flow_error',
      message: 'expired_token',
    });
  });

  it('refuses a second start while one is in flight', async () => {
    const createDeviceAuth: DeviceAuthFactory = () => () => new Promise(() => {});
    const { service } = makeService({ createDeviceAuth });

    const first = service.start();
    await expect(service.start()).resolves.toEqual({
      success: false,
      error: 'Device flow already in progress',
    });
    service.cancel();
    await first;
  });
});
