/**
 * Nexus-authored suite for the fetch-based device auth factory (octokit
 * replacement) and the OAuth client-id resolution chain.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  GITHUB_DEVICE_FLOW_UNAVAILABLE_HINT,
  GITHUB_OAUTH_CLIENT_ID_ENV,
  createFetchDeviceAuth,
  getGithubAuthenticatedUser,
  resolveGithubOauthClientId,
} from './github-device-auth';
import type { GithubHttp } from './github-api';

type FetchImpl = (
  url: string,
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

const DEVICE_CODE_BODY = {
  device_code: 'dc-1',
  user_code: 'ABCD-1234',
  verification_uri: 'https://github.com/login/device',
  expires_in: 900,
  interval: 5,
};

function deps(over: {
  fetchImpl: FetchImpl;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}) {
  return {
    fetchImpl: over.fetchImpl,
    sleep: over.sleep ?? (async () => {}),
    now: over.now ?? (() => 0),
  };
}

describe('createFetchDeviceAuth', () => {
  it('requests a device code, reports verification and polls until the token', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl: FetchImpl = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      if (url.endsWith('/login/device/code')) return jsonResponse(DEVICE_CODE_BODY);
      return jsonResponse({ access_token: 'gho_xyz', token_type: 'bearer', scope: 'repo' });
    };
    const onVerification = vi.fn();

    const auth = createFetchDeviceAuth(
      { clientId: 'cid', scopes: ['repo', 'read:user'], onVerification },
      deps({ fetchImpl }),
    );
    await expect(auth({ type: 'oauth' })).resolves.toEqual({ token: 'gho_xyz' });

    expect(calls[0]).toEqual({
      url: 'https://github.com/login/device/code',
      body: { client_id: 'cid', scope: 'repo read:user' },
    });
    expect(onVerification).toHaveBeenCalledWith({
      user_code: 'ABCD-1234',
      verification_uri: 'https://github.com/login/device',
      expires_in: 900,
      interval: 5,
    });
    expect(calls[1]).toEqual({
      url: 'https://github.com/login/oauth/access_token',
      body: {
        client_id: 'cid',
        device_code: 'dc-1',
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      },
    });
  });

  it('keeps polling through authorization_pending and slows down on slow_down', async () => {
    const waits: number[] = [];
    let poll = 0;
    const fetchImpl: FetchImpl = async (url) => {
      if (url.endsWith('/login/device/code')) return jsonResponse(DEVICE_CODE_BODY);
      poll += 1;
      if (poll === 1) return jsonResponse({ error: 'authorization_pending' });
      if (poll === 2) return jsonResponse({ error: 'slow_down' });
      return jsonResponse({ access_token: 'gho_done' });
    };

    const auth = createFetchDeviceAuth(
      { clientId: 'cid', scopes: ['repo'], onVerification: () => {} },
      deps({
        fetchImpl,
        sleep: async (ms) => {
          waits.push(ms);
        },
      }),
    );
    await expect(auth({ type: 'oauth' })).resolves.toEqual({ token: 'gho_done' });
    // 5s interval, then +5s after slow_down.
    expect(waits).toEqual([5000, 5000, 10000]);
  });

  it('fails on expired_token and on access_denied', async () => {
    for (const [grantError, expected] of [
      ['expired_token', /expired/i],
      ['access_denied', /denied/i],
    ] as const) {
      const fetchImpl: FetchImpl = async (url) =>
        url.endsWith('/login/device/code')
          ? jsonResponse(DEVICE_CODE_BODY)
          : jsonResponse({ error: grantError });
      const auth = createFetchDeviceAuth(
        { clientId: 'cid', scopes: ['repo'], onVerification: () => {} },
        deps({ fetchImpl }),
      );
      await expect(auth({ type: 'oauth' })).rejects.toThrow(expected);
    }
  });

  it('aborts the wait when the signal fires (cancel)', async () => {
    const controller = new AbortController();
    const fetchImpl: FetchImpl = async (url) => {
      if (url.endsWith('/login/device/code')) return jsonResponse(DEVICE_CODE_BODY);
      return jsonResponse({ error: 'authorization_pending' });
    };
    const auth = createFetchDeviceAuth(
      { clientId: 'cid', scopes: ['repo'], onVerification: () => {}, signal: controller.signal },
      deps({
        fetchImpl,
        sleep: async (_ms, signal) => {
          controller.abort();
          if (signal?.aborted) throw new Error('Auth cancelled');
        },
      }),
    );
    await expect(auth({ type: 'oauth' })).rejects.toThrow('Auth cancelled');
  });

  it('rejects a malformed device code response', async () => {
    const fetchImpl: FetchImpl = async () => jsonResponse({ unexpected: true });
    const auth = createFetchDeviceAuth(
      { clientId: 'cid', scopes: ['repo'], onVerification: () => {} },
      deps({ fetchImpl }),
    );
    await expect(auth({ type: 'oauth' })).rejects.toThrow(/unexpected device code response/);
  });
});

describe('resolveGithubOauthClientId', () => {
  it('prefers the env override over settings', () => {
    expect(
      resolveGithubOauthClientId(
        { [GITHUB_OAUTH_CLIENT_ID_ENV]: ' env-id ' } as NodeJS.ProcessEnv,
        { githubOauthClientId: 'settings-id' },
      ),
    ).toBe('env-id');
  });

  it('falls back to settings and then to null', () => {
    expect(resolveGithubOauthClientId({} as NodeJS.ProcessEnv, { githubOauthClientId: 's' })).toBe(
      's',
    );
    expect(resolveGithubOauthClientId({} as NodeJS.ProcessEnv, {})).toBeNull();
  });

  it('ships a hint explaining how to enable the flow', () => {
    expect(GITHUB_DEVICE_FLOW_UNAVAILABLE_HINT).toContain(GITHUB_OAUTH_CLIENT_ID_ENV);
  });
});

describe('getGithubAuthenticatedUser', () => {
  function httpWith(status: number, body: unknown): GithubHttp {
    return {
      getJson: vi.fn(async () => ({ status, body })),
      postJson: vi.fn(),
    };
  }

  it('maps GET /user into the user summary', async () => {
    const user = await getGithubAuthenticatedUser(
      'tok',
      httpWith(200, { id: 7, login: 'monalisa', avatar_url: 'https://a/7' }),
    );
    expect(user).toEqual({ id: 7, login: 'monalisa', avatar_url: 'https://a/7' });
  });

  it('returns null on non-2xx or malformed bodies', async () => {
    await expect(getGithubAuthenticatedUser('tok', httpWith(401, {}))).resolves.toBeNull();
    await expect(
      getGithubAuthenticatedUser('tok', httpWith(200, { login: 'no-id' })),
    ).resolves.toBeNull();
  });
});
