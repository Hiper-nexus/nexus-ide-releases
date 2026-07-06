export interface ApiDeps {
  backendUrl: string;
  fetchFn: typeof fetch;
  getSecret: (key: string) => string | null;
  setSecret: (key: string, value: string) => { ok: boolean; error?: string };
}

export interface ApiResult {
  status: number;
  json: unknown;
}

function defaultDeps(): ApiDeps {
  // Lazy require: secrets-store importa electron/safeStorage indiretamente no app.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const secrets = require('./persistence/secrets-store') as typeof import('./persistence/secrets-store');
  return {
    backendUrl: process.env.NEXUS_BACKEND_URL ?? 'https://api.nexuside.app',
    fetchFn: fetch,
    getSecret: (key) => secrets.getSecret(key),
    setSecret: (key, value) => secrets.setSecret(key, value),
  };
}

function urlFor(deps: ApiDeps, path: string): string {
  return `${deps.backendUrl.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

async function doFetch(
  deps: ApiDeps,
  path: string,
  init: { method?: string; body?: unknown },
  session: string,
): Promise<Response> {
  return deps.fetchFn(urlFor(deps, path), {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${session}`,
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

async function tryRefresh(deps: ApiDeps): Promise<string | null> {
  const refresh = deps.getSecret('auth:refresh');
  if (!refresh) return null;
  try {
    const res = await deps.fetchFn(urlFor(deps, '/v1/auth/refresh'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      ok?: boolean;
      data?: { session?: string; refresh?: string };
    };
    const session = body.data?.session;
    const nextRefresh = body.data?.refresh;
    if (!body.ok || !session || !nextRefresh) return null;
    if (!deps.setSecret('auth:session', session).ok) return null;
    if (!deps.setSecret('auth:refresh', nextRefresh).ok) return null;
    return session;
  } catch {
    return null;
  }
}

export async function apiFetch(
  path: string,
  init: { method?: string; body?: unknown } = {},
  deps: ApiDeps = defaultDeps(),
): Promise<ApiResult> {
  const session = deps.getSecret('auth:session');
  if (!session) return { status: 401, json: null };
  try {
    let res = await doFetch(deps, path, init, session);
    if (res.status === 401) {
      const renewed = await tryRefresh(deps);
      if (!renewed) return { status: 401, json: null };
      res = await doFetch(deps, path, init, renewed);
    }
    return { status: res.status, json: await res.json().catch(() => null) };
  } catch {
    return { status: 0, json: null };
  }
}
