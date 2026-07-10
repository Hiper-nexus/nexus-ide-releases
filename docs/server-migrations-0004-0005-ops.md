# Ops notes — cron (0004) + sync (0005) migrations

## Rollback (manual; drizzle is forward-only)

If **not** yet serving production traffic on these tables:

```sql
DROP TABLE IF EXISTS cron_leases;
DROP TABLE IF EXISTS cron_schedules;
DROP TABLE IF EXISTS sync_projects;
-- then remove journal tags 0004/0005 if you re-bootstrap
```

Order matters: drop child/dependent tables first (leases before schedules if any FKs between them — currently only FKs to `accounts`).

## Deploy lock risk on live `accounts`

`ALTER TABLE … ADD CONSTRAINT … REFERENCES accounts(id)` briefly locks `accounts` while validating.

Mitigations:

1. Deploy in low traffic, or
2. Prefer empty greenfield apply before launch traffic, or
3. Future hardening: create FK `NOT VALID` then `VALIDATE CONSTRAINT` in a second window (not in current SQL).

## Timestamps

`cron_schedules.updated_at`, `cron_leases.*`, and `sync_projects.updated_at` use `timestamptz` so portable cron/sync are UTC-safe.

## Soft-deleted schedules

`cleanupExpired` hard-deletes rows with `status = 'deleted'` older than `DELETED_CRON_SCHEDULE_TTL_MS` (30 days).
