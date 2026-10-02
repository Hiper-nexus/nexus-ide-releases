-- One open Stripe Checkout Session per account. Every attempt made while the
-- window is open replays the same session through a Stripe idempotency key
-- derived from checkout_generation, so two tabs or the site plus the app can
-- never open two payable sessions for one account.
ALTER TABLE accounts ADD COLUMN checkout_generation INTEGER NOT NULL DEFAULT 0
  CHECK (checkout_generation >= 0);
ALTER TABLE accounts ADD COLUMN checkout_open_until INTEGER;

UPDATE system_metadata SET value = '3' WHERE key = 'schema_version';
