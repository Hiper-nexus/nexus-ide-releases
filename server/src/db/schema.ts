import {
  boolean,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

/** Schema Drizzle do Auth. Tokens guardados SÓ como sha256 (nunca em claro). */

export const planEnum = pgEnum('plan', ['free', 'pro', 'team']);
export const providerEnum = pgEnum('provider', ['github', 'google']);

export const accounts = pgTable('accounts', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name'),
  avatarUrl: text('avatar_url'),
  plan: planEnum('plan').notNull().default('free'),
  stripeCustomerId: text('stripe_customer_id'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const identities = pgTable(
  'identities',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    provider: providerEnum('provider').notNull(),
    providerUserId: text('provider_user_id').notNull(),
    email: text('email'),
    emailVerified: boolean('email_verified').notNull().default(false),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  // Invariante central de identidade: um subject OAuth = uma identity.
  // Sem isso, dois primeiros logins concorrentes duplicariam contas.
  (t) => [unique('identities_provider_subject_unique').on(t.provider, t.providerUserId)],
);

export const sessions = pgTable('sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at').notNull(),
  revokedAt: timestamp('revoked_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at'),
});

export const refreshTokens = pgTable('refresh_tokens', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  rotatedFrom: uuid('rotated_from'),
  usedAt: timestamp('used_at'),
  expiresAt: timestamp('expires_at').notNull(),
  revokedAt: timestamp('revoked_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const oauthStates = pgTable('oauth_states', {
  state: text('state').primaryKey(),
  provider: providerEnum('provider').notNull(),
  codeVerifier: text('code_verifier').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  expiresAt: timestamp('expires_at').notNull(),
});

export const authCodes = pgTable('auth_codes', {
  codeHash: text('code_hash').primaryKey(),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  usedAt: timestamp('used_at'),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

/** DDL literal para testes (pglite) — a produção usa migrations do drizzle-kit. */
export const CREATE_TABLES_SQL = `
CREATE TYPE plan AS ENUM ('free','pro','team');
CREATE TYPE provider AS ENUM ('github','google');
CREATE TABLE accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE, name text, avatar_url text,
  plan plan NOT NULL DEFAULT 'free', stripe_customer_id text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now());
CREATE TABLE identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider provider NOT NULL, provider_user_id text NOT NULL,
  email text, email_verified boolean NOT NULL DEFAULT false,
  created_at timestamp NOT NULL DEFAULT now(),
  UNIQUE(provider, provider_user_id));
CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE, expires_at timestamp NOT NULL,
  revoked_at timestamp, created_at timestamp NOT NULL DEFAULT now(),
  last_used_at timestamp);
CREATE TABLE refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE, rotated_from uuid,
  used_at timestamp, expires_at timestamp NOT NULL, revoked_at timestamp,
  created_at timestamp NOT NULL DEFAULT now());
CREATE TABLE oauth_states (
  state text PRIMARY KEY, provider provider NOT NULL,
  code_verifier text NOT NULL, created_at timestamp NOT NULL DEFAULT now(),
  expires_at timestamp NOT NULL);
CREATE TABLE auth_codes (
  code_hash text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  used_at timestamp, expires_at timestamp NOT NULL,
  created_at timestamp NOT NULL DEFAULT now());
`;
