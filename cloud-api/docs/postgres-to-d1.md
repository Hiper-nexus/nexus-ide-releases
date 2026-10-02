# PostgreSQL → D1 migration foundation

This folder prepares a D1 schema for the Nexus backend. The operator confirmed
that the old backend contains no real accounts or data and authorized a new,
initially empty D1 database to become authoritative after testing. That operator
confirmation supersedes the earlier assumption that a production data import
was required. PostgreSQL and the existing API were offline during preparation;
there was no independent live row-count audit. No cloud database or deployment
was changed by this schema work, and applying migrations alone does not prove
that the API can be cut over.

## Scope and baseline

`migrations/0001_core.sql` ports the 14 tables in the existing
`nexus-ide/server/src/db/schema.ts` and Drizzle migrations `0000` through `0006`.
`migrations/0002_trial_admin.sql` adds trial, suspension and administrator fields
and a durable audit table. `src/db/schema.ts` defines read-only SQL row contracts with the original
snake_case column names. The migration creates tables and indexes and inserts
only `system_metadata.schema_version = '1'`; it contains no destructive data
commands. The second migration advances `schema_version` to `2`, and
`migrations/0004_oauth_client.sql` advances it to `4` by recording on
`oauth_states.client` which desktop app (`nexus` or `shot`) started a login,
so the callback can pick that client's deep-link scheme.
`migrations/0003_checkout_reservation.sql` advances it to `3` by adding
`accounts.checkout_generation` and `accounts.checkout_open_until`: one open
Stripe Checkout Session per account, replayed through an idempotency key
derived from the generation. Apply all of them through a migration ledger once. This initial migration is not
an upgrade script for a pre-existing D1 schema; do not rerun it against an
existing installation as an import or repair shortcut.

`schema_version` confirms the schema format only. There is deliberately no
`import_complete` marker. A future import marker requires a separately reviewed
import and reconciliation process.

## Fifteen-day trial and administrative licenses

Permanent Free is removed from the product entitlement policy. The historical
`plan='free'` storage value remains for compatibility with existing schema and
license contracts; it never grants indefinite access. The runtime grants a
15-day trial from verified sign-in and denies access after expiration unless a
paid or administratively extended entitlement applies. This migration does not
start a trial or create an administrator.

`accounts.role` is `TEXT NOT NULL DEFAULT 'user'`, constrained to `user|admin`.
Only `admin@volarehost.com.br` and `retornoja@gmail.com` are authorized bootstrap
administrator emails, and assignment must come from a provider-verified email
at the trusted OAuth boundary. Matching `accounts.email` alone is insufficient;
there is no email-based SQL trigger, seed or automatic role update.

`trial_started_at`, `trial_expires_at`, `suspended_at` and `last_seen_at` are
nullable `INTEGER` UTC milliseconds. A trial is either absent (both dates null)
or complete with nonnegative start and end strictly greater than start. Both
trial dates must change in the same statement. The exact 15-day duration is a
runtime policy, allowing an administrator to extend the end date later.
`suspension_reason` is nullable `TEXT` with a 500-character limit.

`admin_audit` stores UUID `id`, nullable account references `actor_account_id`
and `target_account_id`, checked action `suspend|resume|extend_trial`, JSON-valid
`details` text and millisecond `created_at`. Account deletion uses `SET NULL`
on these references so the audit survives. Privileged routes must validate role,
record action details and batch the account mutation with its audit insert.

## Storage contract

| PostgreSQL representation | D1 representation and responsibility |
| --- | --- |
| `uuid` / `gen_random_uuid()` | `TEXT`; preserve existing UUID strings; new IDs supplied by `crypto.randomUUID()` before inserts |
| `boolean` | `INTEGER`, constrained to `0` or `1`; convert before binding |
| PostgreSQL enums | `TEXT` with matching `CHECK` domains |
| `timestamp` / `timestamptz` | `INTEGER` UTC epoch milliseconds, including all nullable time columns |
| Cron `occurrence_at` bigint | Existing epoch milliseconds retained as `INTEGER` |
| `jsonb` | Serialized JSON `TEXT` with `json_valid` checks; parse at reads and stringify at writes |
| `now()` | Millisecond default calculated from SQLite UTC time; runtime may supply explicit `Date.now()` values |
| PostgreSQL tables | SQLite `STRICT` tables reject ISO date text and fractional real values in integer columns |

SQLite affinity may coerce losslessly convertible text to the declared type.
Validate request values at the API boundary; database constraints complement,
rather than replace, schema validation. UUID syntax and hash encoding are runtime
contracts, not additional import restrictions. IDs and hashes remain opaque.
`email` retains the source's case-sensitive uniqueness: normalization belongs in
the identity service, never an implicit new database collation.

`plan`: `free | pro | team`; provider: `github | google`; owner type:
`account | team`; team role: `owner | member`; cron status:
`active | paused | deleted`; authentication flow/channel: `desktop | web`.
Stripe subscription status remains unrestricted `TEXT`, matching the source.
Existing permissiveness for nullable subscription account/team ownership,
invite counters, and seats is preserved for faithful import. Services must
continue validating ownership, seats and invite limits.

## Exact column inventory

`?` below means nullable. Every `*_at`, `current_period_end`, `grace_until` and
`occurrence_at` column is `INTEGER` milliseconds. Other numeric columns are
`INTEGER`; remaining columns are `TEXT`.

| Table | Columns |
| --- | --- |
| `accounts` | `id`, `email`, `name?`, `avatar_url?`, `plan`, `stripe_customer_id?`, `created_at`, `updated_at`, `role`, `trial_started_at?`, `trial_expires_at?`, `suspended_at?`, `suspension_reason?`, `last_seen_at?`, `checkout_generation`, `checkout_open_until?` |
| `identities` | `id`, `account_id`, `provider`, `provider_user_id`, `email?`, `email_verified`, `created_at` |
| `sessions` | `id`, `account_id`, `token_hash`, `expires_at`, `revoked_at?`, `created_at`, `last_used_at?`, `csrf_hash?`, `channel` |
| `refresh_tokens` | `id`, `account_id`, `token_hash`, `rotated_from?`, `used_at?`, `expires_at`, `revoked_at?`, `created_at`, `channel` |
| `oauth_states` | `state`, `provider`, `code_verifier`, `app_state?`, `code_challenge?`, `created_at`, `expires_at`, `flow`, `web_state_hash?` |
| `auth_codes` | `code_hash`, `account_id`, `used_at?`, `expires_at`, `created_at`, `code_challenge?` |
| `teams` | `id`, `name`, `owner_account_id`, `created_at` |
| `team_members` | `team_id`, `account_id`, `role`, `joined_at` |
| `team_invites` | `code_hash`, `code_prefix`, `team_id`, `created_by`, `max_uses`, `used_count`, `expires_at`, `revoked_at?`, `created_at` |
| `subscriptions` | `id`, `owner_type`, `account_id?`, `team_id?`, `stripe_subscription_id`, `stripe_customer_id`, `plan`, `status`, `seats`, `current_period_end?`, `grace_until?`, `created_at`, `updated_at` |
| `stripe_events` | `event_id`, `type`, `processed_at?`, `payload`, `created_at` |
| `cron_schedules` | `account_id`, `project_id`, `schedule_id`, `version`, `definition`, `definition_hash`, `status`, `updated_at` |
| `cron_leases` | `account_id`, `project_id`, `schedule_id`, `occurrence_at`, `token_hash?`, `version`, `expires_at`, `updated_at` |
| `sync_projects` | `account_id`, `project_id`, `revision`, `entities`, `entity_count`, `state_bytes`, `updated_at` |
| `system_metadata` | `key`, `value` |
| `admin_audit` | `id`, `actor_account_id?`, `target_account_id?`, `action`, `details`, `created_at` |

OAuth states add `flow NOT NULL DEFAULT 'desktop'` and nullable
`web_state_hash`; `app_state` is nullable for web login. Desktop route validation
must still require the local nonce. Sessions add nullable `csrf_hash` and
`channel NOT NULL DEFAULT 'desktop'`; refresh tokens add the same channel default.
Web and desktop use the existing session tables. CSRF and web-state columns store
hashes, never cleartext secrets. `auth_codes` retains its desktop PKCE contract.

## Integrity and atomic operations

All source account/team foreign keys retain `ON DELETE CASCADE`.
`refresh_tokens.rotated_from` intentionally remains an opaque nullable UUID
without a foreign key, matching the source and allowing expired parent cleanup.
Cron leases remain independent of schedule deletion, also matching the source.
Provider/subject uniqueness, unique token/code hashes, unique Stripe subscription
IDs and the one-team-per-account constraint remain enforced. Team membership
uses the original composite uniqueness as a composite primary key, with no change
to allowed membership pairs. Sync projects and cron primary keys include
`account_id`, so identical project IDs are independent between accounts.

Indexes cover identity ownership, session/refresh ownership and expiration,
OAuth/code expiration, team ownership, subscription owner lookups, Stripe event
processing, cron expiry/status cleanup, and account-scoped sync ordering.

D1 `batch()` accepts prepared statements and executes the sequence atomically;
a failed statement aborts/rolls back the batch. Replace interactive PostgreSQL
transactions with batches whose IDs and inputs are known in advance. This
includes account plus identity creation, token-pair issuance, identity moves,
and billing mirror plus event completion. Network calls belong outside batches.
See the [official D1 batch documentation](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).

PostgreSQL `FOR UPDATE`, `pg_advisory_xact_lock`, `hashtext`, and transaction
callbacks are not portable. Rewrite team-seat allocation, sync project-count
limits and cron definition/lease checks as SQL predicates evaluated atomically
with writes, or use a coordination primitive when the full invariant cannot fit
one batch. A read followed by an unconditional write is insufficient.

Refresh/code consumption must remain a conditional `UPDATE ... RETURNING` with
unused, unrevoked and unexpired predicates; refresh consumption also matches the
channel. One request wins and subsequent consumers receive no row. Coordinate
successor token insertion with consumption; schema tests alone do not prove
runtime refresh rotation/reuse handling. D1 enforces foreign keys; do not disable
them for imports. See [official D1 foreign-key guidance](https://developers.cloudflare.com/d1/sql-api/foreign-keys/).

## Import requirements only if legacy data is later discovered

The operator-authorized empty database path does not need a legacy data import.
If that premise changes, complete the following before migrating real records:

1. Recover access to PostgreSQL, inspect actual applied migrations and snapshot
   a consistent source. Capture counts for every table, including ephemeral
   auth state, active subscriptions and account-scoped sync/cron data.
2. Export without raw token material. Preserve IDs and already stored SHA-256
   digests. Convert booleans and JSON explicitly. Interpret source naive auth
   timestamps as UTC only after verifying their actual write-time convention;
   use timezone-aware cron/sync values directly. Explicitly define rounding of
   sub-millisecond PostgreSQL precision.
3. Import into an authorized target in parent-first order: accounts, teams,
   identities/auth rows, team members/invites/subscriptions, Stripe events,
   cron and sync rows. Preserve nullable values and source ownership shape.
   Reject malformed dates, JSON and unsupported enum values for investigation.
4. Reconcile table counts and per-account counts, duplicate subjects/hashes,
   foreign keys, active billing entitlements, PKCE challenges, sync revisions,
   entity counts/state bytes and cron leases. Test native bearer auth, web cookie
   auth, expiry, refresh reuse and concurrent seat/project/lease operations.
5. Define write freeze or delta catch-up, callback and webhook routing, rollback,
   and cache/session compatibility before traffic changes. Record any verified
   import marker only after these checks; `schema_version` never substitutes for
   them. Keep the source snapshot available for rollback.

## Local verification

Run `node --test tests/schema.test.mjs` on Node 22 with built-in `node:sqlite`.
Tests use an in-memory database with `PRAGMA foreign_keys=ON` and the real
migration. They cover identities, transaction rollback, account isolation,
single-consumer refresh predicates, channel defaults, web state nullability,
one-team membership, enum/JSON/boolean/numeric validation, cascades and integer
timestamp storage, default user roles without email bootstrap, checked roles,
complete trial intervals and audit records surviving actor/target deletion.
The SQLite transaction test models the expected D1 batch
atomicity; it does not exercise the Cloudflare binding or prove production
import/deployment. Node 22 may emit its expected experimental SQLite warning.
