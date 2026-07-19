/**
 * GitHub Device Flow glue (Nexus-authored, no electron imports so the whole
 * module is unit-testable):
 *
 * - resolveGithubOauthClientId: env NEXUS_GITHUB_OAUTH_CLIENT_ID (dev
 *   override) → settings.json `integrations.githubOauthClientId`. There is NO
 *   registered Nexus OAuth App yet; without a client id the renderer keeps
 *   the browser-login option hidden (see githubDeviceFlowStatus IPC).
 * - createFetchDeviceAuth: fetch-based replacement for the octokit
 *   @octokit/auth-oauth-device factory the vendored emdash service expects
 *   (the repo vendors emdash code but does not add the octokit dependency).
 *   Honors the AbortSignal the vendored service forwards from cancel().
 * - getGithubAuthenticatedUser: identity probe backing the vendored service.
 */
import type { GithubHttp } from './github-api';
import { authHeaders, defaultGithubHttp } from './github-api';
import type {
  DeviceAuthVerification,
  GitHubUserSummary,
} from '../../vendor/emdash/github/github-device-flow';

export const GITHUB_OAUTH_CLIENT_ID_ENV = 'NEXUS_GITHUB_OAUTH_CLIENT_ID';

/** Scopes our issues/PRs surface needs (same set emdash requests). */
export const GITHUB_DEVICE_FLOW_SCOPES = ['repo', 'read:user', 'read:org'];

export function resolveGithubOauthClientId(
  env: NodeJS.ProcessEnv = process.env,
  settings: { githubOauthClientId?: string } = {},
): string | null {
  const fromEnv = env[GITHUB_OAUTH_CLIENT_ID_ENV]?.trim();
  if (fromEnv) return fromEnv;
  const fromSettings = settings.githubOauthClientId?.trim();
  return fromSettings || null;
}

export const GITHUB_DEVICE_FLOW_UNAVAILABLE_HINT =
  'Login GitHub pelo navegador (Device Flow) exige um OAuth App próprio: ' +
  `defina ${GITHUB_OAUTH_CLIENT_ID_ENV} ou integrations.githubOauthClientId ` +
  'em ~/.nexus/settings.json. Enquanto isso, use PAT ou `gh auth login`.';

const DEFAULT_LOGIN_BASE_URL = 'https://github.com';
const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const SLOW_DOWN_EXTRA_MS = 5_000;

type FetchLike = (
  url: string,
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

type DeviceAuthDeps = {
  fetchImpl?: FetchLike;
  loginBaseUrl?: string;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
};

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Auth cancelled'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function postOAuthForm(
  fetchImpl: FetchLike,
  url: string,
  params: Record<string, string>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw new Error('Auth cancelled');
    throw err;
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const description =
      body && typeof body.error_description === 'string'
        ? body.error_description
        : `HTTP ${res.status}`;
    throw new Error(`GitHub device flow request failed: ${description}`);
  }
  return body ?? {};
}

function stringField(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function numberField(body: Record<string, unknown>, key: string): number | null {
  const value = body[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function parseDeviceCodeResponse(body: Record<string, unknown>): DeviceAuthVerification & {
  device_code: string;
} {
  const deviceCode = stringField(body, 'device_code');
  const userCode = stringField(body, 'user_code');
  const verificationUri = stringField(body, 'verification_uri');
  const expiresIn = numberField(body, 'expires_in');
  const interval = numberField(body, 'interval') ?? 5;
  if (!deviceCode || !userCode || !verificationUri || expiresIn === null) {
    throw new Error('GitHub device flow: unexpected device code response');
  }
  return {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: verificationUri,
    expires_in: expiresIn,
    interval,
  };
}

/**
 * Replacement for octokit's createOAuthDeviceAuth with the same call shape:
 * request a device code, hand it to onVerification, then poll the access
 * token endpoint honoring authorization_pending / slow_down / expiry.
 */
export function createFetchDeviceAuth(
  options: {
    clientId: string;
    scopes: string[];
    onVerification(verification: DeviceAuthVerification): void;
    signal?: AbortSignal;
  },
  deps: DeviceAuthDeps = {},
): (input: { type: 'oauth' }) => Promise<{ token: string }> {
  const fetchImpl = deps.fetchImpl ?? (fetch as unknown as FetchLike);
  const base = deps.loginBaseUrl ?? DEFAULT_LOGIN_BASE_URL;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? (() => Date.now());

  return async () => {
    const { signal } = options;
    const codeBody = await postOAuthForm(
      fetchImpl,
      `${base}/login/device/code`,
      { client_id: options.clientId, scope: options.scopes.join(' ') },
      signal,
    );
    const verification = parseDeviceCodeResponse(codeBody);
    options.onVerification({
      user_code: verification.user_code,
      verification_uri: verification.verification_uri,
      expires_in: verification.expires_in,
      interval: verification.interval,
    });

    const deadline = now() + verification.expires_in * 1000;
    let intervalMs = Math.max(1, verification.interval) * 1000;

    for (;;) {
      if (signal?.aborted) throw new Error('Auth cancelled');
      await sleep(intervalMs, signal);
      const tokenBody = await postOAuthForm(
        fetchImpl,
        `${base}/login/oauth/access_token`,
        {
          client_id: options.clientId,
          device_code: verification.device_code,
          grant_type: DEVICE_CODE_GRANT,
        },
        signal,
      );
      const accessToken = stringField(tokenBody, 'access_token');
      if (accessToken) return { token: accessToken };

      switch (stringField(tokenBody, 'error')) {
        case 'authorization_pending':
          break;
        case 'slow_down':
          intervalMs += SLOW_DOWN_EXTRA_MS;
          break;
        case 'expired_token':
          throw new Error('GitHub device code expired — start the login again.');
        case 'access_denied':
          throw new Error('GitHub login was denied.');
        default:
          throw new Error(
            `GitHub device flow failed: ${
              stringField(tokenBody, 'error_description') ??
              stringField(tokenBody, 'error') ??
              'unknown error'
            }`,
          );
      }
      if (now() > deadline) {
        throw new Error('GitHub device code expired — start the login again.');
      }
    }
  };
}

/** Identity probe backing the vendored device-flow service (GET /user). */
export async function getGithubAuthenticatedUser(
  token: string,
  http: GithubHttp = defaultGithubHttp,
): Promise<GitHubUserSummary | null> {
  const res = await http.getJson('https://api.github.com/user', authHeaders(token));
  if (res.status < 200 || res.status >= 300) return null;
  const body = res.body as { id?: unknown; login?: unknown; avatar_url?: unknown } | null;
  if (!body || typeof body.id !== 'number' || typeof body.login !== 'string') {
    return null;
  }
  return {
    id: body.id,
    login: body.login,
    avatar_url: typeof body.avatar_url === 'string' ? body.avatar_url : '',
  };
}
