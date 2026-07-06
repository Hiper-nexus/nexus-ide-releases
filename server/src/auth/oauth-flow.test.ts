import { describe, expect, it, vi } from 'vitest';
import { PROVIDERS } from './oauth-providers';
import { authorizeUrl, exchangeCode, makePkce } from './oauth-flow';

describe('oauth-providers.parseProfile', () => {
  it('github: normaliza perfil e email verificado', () => {
    const p = PROVIDERS.github.parseProfile({
      user: { id: 42, login: 'zé', name: 'Zé', avatar_url: 'http://a' },
      emails: [
        { email: 'z@x.com', primary: true, verified: true },
        { email: 'alt@x.com', primary: false, verified: false },
      ],
    });
    expect(p).toEqual({
      provider: 'github',
      providerUserId: '42',
      email: 'z@x.com',
      emailVerified: true,
      name: 'Zé',
      avatar: 'http://a',
    });
  });

  it('google: usa email_verified do userinfo', () => {
    const p = PROVIDERS.google.parseProfile({
      sub: 'g-1',
      email: 'g@x.com',
      email_verified: true,
      name: 'G',
      picture: 'http://p',
    });
    expect(p.providerUserId).toBe('g-1');
    expect(p.emailVerified).toBe(true);
    expect(p.email).toBe('g@x.com');
  });
});

describe('makePkce / authorizeUrl', () => {
  it('challenge é o S256 do verifier (base64url)', () => {
    const { verifier, challenge } = makePkce(() => Buffer.alloc(32, 7));
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).not.toBe(verifier);
  });

  it('authorizeUrl injeta client/redirect/state/challenge', () => {
    const url = authorizeUrl('github', {
      clientId: 'cid',
      redirectUri: 'https://api/cb',
      state: 'st',
      challenge: 'ch',
    });
    expect(url).toContain('client_id=cid');
    expect(url).toContain('state=st');
    expect(url).toContain('code_challenge=ch');
    expect(url).toContain('code_challenge_method=S256');
  });
});

describe('exchangeCode', () => {
  it('github: troca code por token e busca perfil', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'tok' }), {
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: 7, login: 'u', name: 'U', avatar_url: 'a' }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([{ email: 'u@x.com', primary: true, verified: true }]),
        ),
      );
    const profile = await exchangeCode(
      'github',
      { code: 'c', verifier: 'v', clientId: 'id', clientSecret: 's', redirectUri: 'r' },
      { fetchFn: fetchFn as unknown as typeof fetch },
    );
    expect(profile.providerUserId).toBe('7');
    expect(profile.email).toBe('u@x.com');
    expect(fetchFn).toHaveBeenCalledTimes(3);
    // O token endpoint do Google REJEITA JSON — o padrão OAuth 2.0 é
    // form-urlencoded, e o corpo precisa ser parseável como querystring.
    const [, tokenInit] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect((tokenInit.headers as Record<string, string>)['content-type']).toBe(
      'application/x-www-form-urlencoded',
    );
    const body = new URLSearchParams(String(tokenInit.body));
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code_verifier')).toBe('v');
    expect(body.get('client_id')).toBe('id');
  });

  it('erro HTTP na troca de token vira exceção', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }));
    await expect(
      exchangeCode(
        'google',
        { code: 'c', verifier: 'v', clientId: 'id', clientSecret: 's', redirectUri: 'r' },
        { fetchFn: fetchFn as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/401/);
  });
});
