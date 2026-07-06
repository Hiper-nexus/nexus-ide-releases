import crypto from 'node:crypto';
import { PROVIDERS, type OAuthProfile, type Provider } from './oauth-providers';

/** PKCE + authorize URL + troca de code. HTTP injetado (testável sem rede). */

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

export function makePkce(
  rand: () => Buffer = () => crypto.randomBytes(32),
): { verifier: string; challenge: string } {
  const verifier = b64url(rand());
  const challenge = b64url(
    crypto.createHash('sha256').update(verifier).digest(),
  );
  return { verifier, challenge };
}

export function authorizeUrl(
  provider: Provider,
  p: { clientId: string; redirectUri: string; state: string; challenge: string },
): string {
  const def = PROVIDERS[provider];
  const q = new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    response_type: 'code',
    scope: def.scope,
    state: p.state,
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
  });
  return `${def.authUrl}?${q.toString()}`;
}

export interface HttpDeps {
  fetchFn: typeof fetch;
}

export async function exchangeCode(
  provider: Provider,
  p: {
    code: string;
    verifier: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  },
  http: HttpDeps,
): Promise<OAuthProfile> {
  const def = PROVIDERS[provider];
  const tokenRes = await http.fetchFn(def.tokenUrl, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: p.clientId,
      client_secret: p.clientSecret,
      code: p.code,
      redirect_uri: p.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: p.verifier,
    }),
  });
  if (!tokenRes.ok) {
    throw new Error(`${provider} token exchange HTTP ${tokenRes.status}`);
  }
  const token = (await tokenRes.json()) as { access_token?: string };
  if (!token.access_token) throw new Error(`${provider}: sem access_token`);

  const auth = { authorization: `Bearer ${token.access_token}` };
  const userRes = await http.fetchFn(def.userUrl, { headers: auth });
  if (!userRes.ok) throw new Error(`${provider} userinfo HTTP ${userRes.status}`);
  const user = await userRes.json();

  if (provider === 'github') {
    const emailsRes = await http.fetchFn(def.emailsUrl!, { headers: auth });
    const emails = emailsRes.ok ? await emailsRes.json() : [];
    return def.parseProfile({ user, emails });
  }
  return def.parseProfile(user);
}
