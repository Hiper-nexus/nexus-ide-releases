import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/** Schema Drizzle do Auth. Tokens guardados SÓ como sha256 (nunca em claro). */

export const planEnum = pgEnum('plan', ['free', 'pro', 'team']);
export const providerEnum = pgEnum('provider', ['github', 'google']);
export const ownerTypeEnum = pgEnum('owner_type', ['account', 'team']);
export const teamRoleEnum = pgEnum('team_role', ['owner', 'member']);

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
  /** Nonce gerado pelo DESKTOP ao iniciar o login; volta no deep link como
   * ?state= e o app só aceita se casar com o fluxo pendente (anti-CSRF). */
  appState: text('app_state').notNull(),
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

export const teams = pgTable('teams', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  ownerAccountId: uuid('owner_account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const teamMembers = pgTable(
  'team_members',
  {
    teamId: uuid('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
    role: teamRoleEnum('role').notNull(),
    joinedAt: timestamp('joined_at').notNull().defaultNow(),
  },
  // 1 time por conta no v1 → entitlement determinístico (fase 2: soltar)
  (t) => [
    unique('team_members_pk').on(t.teamId, t.accountId),
    unique('team_members_one_team_per_account').on(t.accountId),
  ],
);

export const teamInvites = pgTable('team_invites', {
  codeHash: text('code_hash').primaryKey(), // sha256 — nunca em claro
  codePrefix: text('code_prefix').notNull(), // 4 chars p/ listar/revogar
  teamId: uuid('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  createdBy: uuid('created_by').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  maxUses: integer('max_uses').notNull().default(10),
  usedCount: integer('used_count').notNull().default(0),
  expiresAt: timestamp('expires_at').notNull(),
  revokedAt: timestamp('revoked_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const subscriptions = pgTable('subscriptions', {
  id: uuid('id').defaultRandom().primaryKey(),
  ownerType: ownerTypeEnum('owner_type').notNull(),
  accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }),
  stripeSubscriptionId: text('stripe_subscription_id').notNull().unique(),
  stripeCustomerId: text('stripe_customer_id').notNull(),
  plan: planEnum('plan').notNull(),
  status: text('status').notNull(), // espelho Stripe
  seats: integer('seats').notNull().default(1),
  currentPeriodEnd: timestamp('current_period_end'),
  graceUntil: timestamp('grace_until'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const stripeEvents = pgTable('stripe_events', {
  eventId: text('event_id').primaryKey(),
  type: text('type').notNull(),
  processedAt: timestamp('processed_at'),
  payload: jsonb('payload').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

/** Portable cron definitions. Machine/check-out coordinates never enter it. */
export const cronSchedules = pgTable(
  'cron_schedules',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull(),
    scheduleId: text('schedule_id').notNull(),
    version: integer('version').notNull(),
    definition: jsonb('definition').notNull(),
    definitionHash: text('definition_hash').notNull(),
    status: text('status').notNull(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'cron_schedules_pk',
      columns: [table.accountId, table.projectId, table.scheduleId],
    }),
    index('cron_schedules_project_status_idx').on(
      table.accountId,
      table.projectId,
      table.status,
    ),
    check('cron_schedules_version_check', sql`${table.version} > 0`),
    check(
      'cron_schedules_status_check',
      sql`${table.status} IN ('active', 'paused', 'deleted')`,
    ),
  ],
);

/** Server-time lease authority. Only a token hash is persisted. */
export const cronLeases = pgTable(
  'cron_leases',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull(),
    scheduleId: text('schedule_id').notNull(),
    occurrenceAt: bigint('occurrence_at', { mode: 'number' }).notNull(),
    tokenHash: text('token_hash'),
    version: integer('version').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'cron_leases_pk',
      columns: [
        table.accountId,
        table.projectId,
        table.scheduleId,
        table.occurrenceAt,
      ],
    }),
    index('cron_leases_expiry_idx').on(table.expiresAt),
    check('cron_leases_version_check', sql`${table.version} > 0`),
  ],
);

/** Account-scoped portable sync state. No machine or credential material. */
export const syncProjects = pgTable(
  'sync_projects',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull(),
    revision: integer('revision').notNull(),
    entities: jsonb('entities').notNull(),
    entityCount: integer('entity_count').notNull(),
    stateBytes: integer('state_bytes').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'sync_projects_pk',
      columns: [table.accountId, table.projectId],
    }),
    index('sync_projects_account_updated_idx').on(
      table.accountId,
      table.updatedAt,
    ),
    check('sync_projects_revision_check', sql`${table.revision} > 0`),
    check(
      'sync_projects_entity_count_check',
      sql`${table.entityCount} >= 0 AND ${table.entityCount} <= 1000`,
    ),
    check(
      'sync_projects_state_bytes_check',
      sql`${table.stateBytes} >= 0 AND ${table.stateBytes} <= 196608`,
    ),
  ],
);

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
  code_verifier text NOT NULL, app_state text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  expires_at timestamp NOT NULL);
CREATE TABLE auth_codes (
  code_hash text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  used_at timestamp, expires_at timestamp NOT NULL,
  created_at timestamp NOT NULL DEFAULT now());
CREATE TYPE owner_type AS ENUM ('account','team');
CREATE TYPE team_role AS ENUM ('owner','member');
CREATE TABLE teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  owner_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at timestamp NOT NULL DEFAULT now());
CREATE TABLE team_members (
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role team_role NOT NULL,
  joined_at timestamp NOT NULL DEFAULT now(),
  UNIQUE(team_id, account_id), UNIQUE(account_id));
CREATE TABLE team_invites (
  code_hash text PRIMARY KEY, code_prefix text NOT NULL,
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  max_uses int NOT NULL DEFAULT 10, used_count int NOT NULL DEFAULT 0,
  expires_at timestamp NOT NULL, revoked_at timestamp,
  created_at timestamp NOT NULL DEFAULT now());
CREATE TABLE subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type owner_type NOT NULL,
  account_id uuid REFERENCES accounts(id) ON DELETE CASCADE,
  team_id uuid REFERENCES teams(id) ON DELETE CASCADE,
  stripe_subscription_id text NOT NULL UNIQUE,
  stripe_customer_id text NOT NULL,
  plan plan NOT NULL, status text NOT NULL, seats int NOT NULL DEFAULT 1,
  current_period_end timestamp, grace_until timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now());
CREATE TABLE stripe_events (
  event_id text PRIMARY KEY, type text NOT NULL,
  processed_at timestamp, payload jsonb NOT NULL,
  created_at timestamp NOT NULL DEFAULT now());
CREATE TABLE cron_schedules (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  project_id text NOT NULL,
  schedule_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  definition jsonb NOT NULL,
  definition_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('active','paused','deleted')),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT cron_schedules_pk PRIMARY KEY (account_id, project_id, schedule_id));
CREATE INDEX cron_schedules_project_status_idx
  ON cron_schedules(account_id, project_id, status);
CREATE TABLE cron_leases (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  project_id text NOT NULL,
  schedule_id text NOT NULL,
  occurrence_at bigint NOT NULL,
  token_hash text,
  version integer NOT NULL CHECK (version > 0),
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cron_leases_pk PRIMARY KEY
    (account_id, project_id, schedule_id, occurrence_at));
CREATE INDEX cron_leases_expiry_idx ON cron_leases(expires_at);
CREATE TABLE sync_projects (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  project_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  entities jsonb NOT NULL,
  entity_count integer NOT NULL CHECK (entity_count >= 0 AND entity_count <= 1000),
  state_bytes integer NOT NULL CHECK (state_bytes >= 0 AND state_bytes <= 196608),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sync_projects_pk PRIMARY KEY (account_id, project_id));
CREATE INDEX sync_projects_account_updated_idx
  ON sync_projects(account_id, updated_at);
`;
