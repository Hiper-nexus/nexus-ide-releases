import { z } from 'zod';
import { HTTPException } from 'hono/http-exception';
import type { OAuthProfile } from './accounts.js';
import type { Provider } from './db/schema.js';
import { readBoundedBody } from './http.js';
const PROVIDER_TIMEOUT_MS = 8000;
const MAX_PROVIDER_BYTES = 64 * 1024;
const tokenSchema = z.object({ access_token: z.string().min(1).max(8192) });
const optionalText = z.string().max(512).nullable().optional();
const optionalAvatar = z.url().refine(value => new URL(value).protocol === 'https:').nullable().optional();
const googleSchema = z.object({ sub: z.string().min(1).max(255), email: z.email().max(320).optional(), email_verified: z.boolean().optional(), name: optionalText, picture: optionalAvatar });
const githubSchema = z.object({ id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), login: z.string().min(1).max(255).optional(), name: optionalText, avatar_url: optionalAvatar });
const emailsSchema = z.array(z.object({ email: z.email().max(320), primary: z.boolean(), verified: z.boolean() })).max(100);
export const PROVIDERS = {
    google: { authUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token', userUrl: 'https://openidconnect.googleapis.com/v1/userinfo', scope: 'openid email profile' },
    github: { authUrl: 'https://github.com/login/oauth/authorize', tokenUrl: 'https://github.com/login/oauth/access_token', userUrl: 'https://api.github.com/user', scope: 'read:user user:email' },
} as const;
export function authorizeUrl(provider: Provider, input: {
    clientId: string;
    redirectUri: string;
    state: string;
    challenge: string;
}): string {
    const definition = PROVIDERS[provider];
    const query = new URLSearchParams({ client_id: input.clientId, redirect_uri: input.redirectUri, response_type: 'code', scope: definition.scope, state: input.state, code_challenge: input.challenge, code_challenge_method: 'S256' });
    return `${definition.authUrl}?${query}`;
}
async function providerJson<T>(fetchFn: typeof fetch, url: string, init: RequestInit, schema: z.ZodType<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(new Error('Provider timeout'));
        }, PROVIDER_TIMEOUT_MS);
    });
    const request = async () => {
        const response = await fetchFn(url, { ...init, signal: controller.signal, redirect: 'error' });
        if (!response.ok) throw new Error('Provider request rejected');
        const body = await readBoundedBody(new Request(url, { method: 'POST', body: response.body, headers: response.headers, duplex: 'half' } as RequestInit), MAX_PROVIDER_BYTES);
        return schema.parse(JSON.parse(body));
    };
    try { return await Promise.race([request(), deadline]); }
    catch { throw new HTTPException(502, { message: 'Não foi possível validar o login no provedor. Tente novamente.' }); }
    finally { clearTimeout(timer); }
}
export async function exchangeCode(provider: Provider, input: {
    code: string;
    verifier: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
}, fetchFn: typeof fetch): Promise<OAuthProfile> {
    const definition = PROVIDERS[provider];
    const token = await providerJson(fetchFn, definition.tokenUrl, {
        method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: input.clientId, client_secret: input.clientSecret, code: input.code, redirect_uri: input.redirectUri, grant_type: 'authorization_code', code_verifier: input.verifier }).toString(),
    }, tokenSchema);
    const headers = { authorization: `Bearer ${token.access_token}`, accept: 'application/json', 'User-Agent': 'NexusIDE-Cloud' };
    if (provider === 'google') {
        const user = await providerJson(fetchFn, definition.userUrl, { headers }, googleSchema);
        return { provider, subject: user.sub, email: user.email ?? null, verified: user.email_verified === true && Boolean(user.email), name: user.name ?? null, avatar: user.picture ?? null };
    }
    const user = await providerJson(fetchFn, definition.userUrl, { headers }, githubSchema);
    const emails = await providerJson(fetchFn, 'https://api.github.com/user/emails', { headers }, emailsSchema);
    const primary = emails.find(value => value.primary && value.verified);
    return { provider, subject: String(user.id), email: primary?.email ?? null, verified: Boolean(primary), name: user.name ?? user.login ?? null, avatar: user.avatar_url ?? null };
}
