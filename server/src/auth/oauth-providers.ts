export type Provider = 'github' | 'google';

export interface OAuthProfile {
  provider: Provider;
  providerUserId: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  avatar: string | null;
}

interface GithubUser {
  id: number;
  login?: string;
  name?: string | null;
  avatar_url?: string | null;
}
interface GithubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}
interface GoogleUser {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string | null;
  picture?: string | null;
}

export interface ProviderDef {
  authUrl: string;
  tokenUrl: string;
  userUrl: string;
  emailsUrl?: string;
  scope: string;
  parseProfile(raw: unknown): OAuthProfile;
}

export const PROVIDERS: Record<Provider, ProviderDef> = {
  github: {
    authUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userUrl: 'https://api.github.com/user',
    emailsUrl: 'https://api.github.com/user/emails',
    scope: 'read:user user:email',
    parseProfile(raw) {
      const r = raw as { user: GithubUser; emails: GithubEmail[] };
      const primary =
        r.emails.find((e) => e.primary) ?? r.emails[0] ?? undefined;
      return {
        provider: 'github',
        providerUserId: String(r.user.id),
        email: primary?.email ?? null,
        emailVerified: primary?.verified ?? false,
        name: r.user.name ?? r.user.login ?? null,
        avatar: r.user.avatar_url ?? null,
      };
    },
  },
  google: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    scope: 'openid email profile',
    parseProfile(raw) {
      const r = raw as GoogleUser;
      return {
        provider: 'google',
        providerUserId: r.sub,
        email: r.email ?? null,
        emailVerified: r.email_verified ?? false,
        name: r.name ?? null,
        avatar: r.picture ?? null,
      };
    },
  },
};
