// Vendored from generalaction/emdash@c1af543 — Apache-2.0
// Source: apps/emdash-desktop/src/main/core/github/services/github-api-errors.ts
//   (auth_required/account_host_mismatch constructors from
//    services/github-api-auth-errors.ts; wire-tag naming follows
//    pull-requests/pr-sync-errors.ts)
// See src/vendor/emdash/hooks/LICENSE.md. Nexus changes: ts-pattern and the
// @shared/repository-ref host helpers dropped (Nexus is github.com-only, GHE
// hint inlined); taxonomy renamed to the Nexus IPC wire tags
// (not_found_or_no_access → not_found, api_error → unknown);
// account_host_mismatch carries no accountId (Nexus keeps a single github.com
// credential); added the githubApiErrorMessage formatter (upstream formats
// via ts-pattern in pr-sync-errors.ts). Classification logic is upstream's.

/**
 * Typed GitHub failure taxonomy — the anti "swallowed error" contract: a
 * GitHub call either returns data or one of these, never a silently empty
 * list. Plain structured-cloneable objects so they can cross IPC and the UI
 * can render actionable state (SSO link, rate-limit reset, ...).
 */
export type GitHubApiError =
  | { type: 'auth_required'; host: string; message: string; hint?: string; status?: number }
  | {
      type: 'not_found';
      host: string;
      nameWithOwner?: string;
      message: string;
      status?: number;
    }
  | {
      type: 'sso_required';
      host: string;
      message: string;
      status: 403;
      ssoUrl?: string;
    }
  | {
      type: 'rate_limited';
      host: string;
      message: string;
      status: 200 | 403 | 429;
      resetAt?: string;
    }
  | { type: 'forbidden'; host: string; message: string; status: 403 }
  | { type: 'host_unreachable'; host: string; reason: string }
  | {
      type: 'account_host_mismatch';
      host: string;
      accountHost: string;
      message: string;
      hint?: string;
    }
  | { type: 'unknown'; message: string; status?: number };

export type GitHubApiErrorContext = {
  host?: string;
  nameWithOwner?: string;
  fallback: string;
};

type GitHubGraphQlError = {
  message?: unknown;
  type?: unknown;
  extensions?: { code?: unknown };
};

function statusNumber(value: unknown): number | null {
  const status = Number(value);
  return Number.isFinite(status) ? status : null;
}

function apiStatus(error: unknown): number | null {
  if (error && typeof error === 'object' && 'status' in error) {
    const status = statusNumber((error as { status: unknown }).status);
    if (status !== null) return status;
  }
  return statusNumber(headerValue(error, 'status'));
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = (error as { code: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function responseData(error: unknown): unknown {
  if (!error || typeof error !== 'object' || !('response' in error)) return undefined;
  return (error as { response?: { data?: unknown } }).response?.data;
}

function graphQlErrors(error: unknown): GitHubGraphQlError[] {
  if (!error || typeof error !== 'object') return [];

  if ('errors' in error) {
    const errors = (error as { errors?: unknown }).errors;
    if (Array.isArray(errors)) return errors as GitHubGraphQlError[];
  }

  if ('response' in error) {
    const response = (error as { response?: unknown }).response;
    if (response && typeof response === 'object' && 'errors' in response) {
      const errors = (response as { errors?: unknown }).errors;
      if (Array.isArray(errors)) return errors as GitHubGraphQlError[];
    }
  }

  const data = responseData(error);
  if (data && typeof data === 'object' && 'errors' in data) {
    const errors = (data as { errors?: unknown }).errors;
    if (Array.isArray(errors)) return errors as GitHubGraphQlError[];
  }

  return [];
}

function responseMessage(error: unknown): string | undefined {
  const data = responseData(error);
  if (data && typeof data === 'object' && 'message' in data) {
    const message = (data as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  if (error instanceof Error && error.message.trim()) return error.message;
  return undefined;
}

function firstGraphQlErrorMessage(error: unknown): string | undefined {
  const errors = graphQlErrors(error);
  const first = errors[0];
  if (!first || typeof first !== 'object' || !('message' in first)) return undefined;
  const message = (first as { message?: unknown }).message;
  return typeof message === 'string' && message.trim() ? message : undefined;
}

function errorMessage(error: unknown, fallback: string): string {
  return firstGraphQlErrorMessage(error) ?? responseMessage(error) ?? fallback;
}

function headerValue(error: unknown, headerName: string): string | undefined {
  const responseHeaders =
    error && typeof error === 'object' && 'response' in error
      ? (error as { response?: { headers?: Record<string, unknown> } }).response?.headers
      : undefined;
  const topLevelHeaders =
    error && typeof error === 'object' && 'headers' in error
      ? (error as { headers?: Record<string, unknown> }).headers
      : undefined;
  const headers = responseHeaders ?? topLevelHeaders;
  if (!headers) return undefined;
  const normalizedHeaderName = headerName.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== normalizedHeaderName) continue;
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
  }
  return undefined;
}

function isNetworkConnectivityError(error: unknown): boolean {
  const text = errorText(error);
  const code = errorCode(error);
  return Boolean(
    code?.startsWith('ECONN') ||
    code === 'ETIMEDOUT' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    /connect timeout|network error|fetch failed|socket hang up|dns|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED/i.test(
      text
    )
  );
}

function rateLimitResetAt(error: unknown): string | undefined {
  const reset = headerValue(error, 'x-ratelimit-reset');
  if (!reset) return undefined;
  const seconds = Number(reset);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return new Date(seconds * 1000).toISOString();
}

function isRateLimitError(error: unknown, status: number, message: string): boolean {
  if (status === 429) return true;
  if (headerValue(error, 'x-ratelimit-remaining') === '0') return true;
  return /rate limit|secondary rate limit|abuse detection/i.test(message);
}

function isRateLimitMessage(error: unknown, message: string): boolean {
  return (
    graphQlErrors(error).some((item) =>
      /rate limit|secondary rate limit|abuse detection/i.test(String(item.message ?? ''))
    ) || /rate limit|secondary rate limit|abuse detection/i.test(message)
  );
}

function ssoUrl(error: unknown): string | undefined {
  const header = headerValue(error, 'x-github-sso');
  const match = /url=([^;]+)/i.exec(header ?? '');
  return match?.[1];
}

function isSsoRequired(error: unknown, message: string): boolean {
  if (headerValue(error, 'x-github-sso')) return true;
  return /saml|single sign-on|sso/i.test(message);
}

function graphQlErrorCode(error: GitHubGraphQlError): string | undefined {
  if (typeof error.type === 'string' && error.type.trim()) return error.type;
  const code = error.extensions?.code;
  return typeof code === 'string' && code.trim() ? code : undefined;
}

function hasGraphQlNotFoundError(error: unknown, message: string): boolean {
  return (
    graphQlErrors(error).some(
      (item) =>
        graphQlErrorCode(item)?.toUpperCase() === 'NOT_FOUND' ||
        /could not resolve to a repository|repository .* not found/i.test(
          String(item.message ?? '')
        )
    ) || /could not resolve to a repository|repository .* not found/i.test(message)
  );
}

function hasGraphQlForbiddenError(error: unknown): boolean {
  return graphQlErrors(error).some((item) => graphQlErrorCode(item)?.toUpperCase() === 'FORBIDDEN');
}

function repositoryTarget(host: string, nameWithOwner?: string): string {
  return nameWithOwner ? `${nameWithOwner} on ${host}` : `this repository on ${host}`;
}

function authHint(host: string): string {
  return host === 'github.com'
    ? 'Connect GitHub from the Integrations panel (PAT, `gh auth login` or device flow).'
    : `Run: gh auth login --hostname ${host}`;
}

export function githubApiAuthRequired(
  host: string
): Extract<GitHubApiError, { type: 'auth_required' }> {
  const hint = authHint(host);
  if (host === 'github.com') {
    return {
      type: 'auth_required',
      host,
      message: `GitHub authentication required. ${hint}`,
      hint,
    };
  }
  return {
    type: 'auth_required',
    host,
    message: `GitHub Enterprise authentication required for ${host}. ${hint}`,
    hint,
  };
}

export function githubApiAccountHostMismatch(
  host: string,
  accountHost: string
): Extract<GitHubApiError, { type: 'account_host_mismatch' }> {
  return {
    type: 'account_host_mismatch',
    host,
    accountHost,
    message: `The saved GitHub credential is for ${accountHost}, but this repository uses ${host}.`,
    hint: authHint(host),
  };
}

export function classifyGitHubApiError(
  error: unknown,
  context: GitHubApiErrorContext
): GitHubApiError {
  const { host, nameWithOwner, fallback } = context;
  const status = apiStatus(error);
  const message = errorMessage(error, fallback);

  if (host && status === 401) {
    return { ...githubApiAuthRequired(host), status };
  }

  if (host && status === 404) {
    return {
      type: 'not_found',
      host,
      nameWithOwner,
      status,
      message: `${repositoryTarget(host, nameWithOwner)} was not found, or the selected GitHub account does not have access.`,
    };
  }

  if (host && hasGraphQlNotFoundError(error, message)) {
    return {
      type: 'not_found',
      host,
      nameWithOwner,
      status: status ?? undefined,
      message: `${repositoryTarget(host, nameWithOwner)} was not found, or the selected GitHub account does not have access.`,
    };
  }

  if (host && status === 403 && isSsoRequired(error, message)) {
    return {
      type: 'sso_required',
      host,
      status,
      ssoUrl: ssoUrl(error),
      message,
    };
  }

  if (host && !status && isSsoRequired(error, message)) {
    return {
      type: 'sso_required',
      host,
      status: 403,
      ssoUrl: ssoUrl(error),
      message,
    };
  }

  if (host && status && isRateLimitError(error, status, message)) {
    return {
      type: 'rate_limited',
      host,
      status: status === 200 || status === 429 ? status : 403,
      resetAt: rateLimitResetAt(error),
      message,
    };
  }

  if (host && !status && isRateLimitMessage(error, message)) {
    return {
      type: 'rate_limited',
      host,
      status: 200,
      resetAt: rateLimitResetAt(error),
      message,
    };
  }

  if (host && !status && hasGraphQlForbiddenError(error)) {
    return {
      type: 'forbidden',
      host,
      status: 403,
      message,
    };
  }

  if (host && status === 403) {
    return {
      type: 'forbidden',
      host,
      status,
      message,
    };
  }

  if (host && isNetworkConnectivityError(error)) {
    return { type: 'host_unreachable', host, reason: errorText(error) };
  }

  return {
    type: 'unknown',
    status: status ?? undefined,
    message,
  };
}

/**
 * Printable, actionable one-liner for a typed error (upstream formats with
 * ts-pattern in pr-sync-errors.ts; Nexus keeps a plain switch). Structured
 * fields stay available for richer UI (SSO link, reset countdown).
 */
export function githubApiErrorMessage(error: GitHubApiError): string {
  switch (error.type) {
    case 'host_unreachable':
      return `Unable to reach ${error.host}: ${error.reason}`;
    case 'sso_required':
      return error.ssoUrl
        ? `${error.message} Authorize SSO: ${error.ssoUrl}`
        : error.message;
    case 'rate_limited':
      return error.resetAt
        ? `${error.message} (rate limit resets at ${error.resetAt})`
        : error.message;
    default:
      return error.message;
  }
}
