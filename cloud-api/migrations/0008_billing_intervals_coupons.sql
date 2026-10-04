-- Intervalos de cobrança do Pro (além do mensal) e cupons de desconto compartilháveis.
-- O preço mensal não muda. Desligar um cupom só impede checkout novo: o histórico de usos fica.

ALTER TABLE accounts ADD COLUMN checkout_interval TEXT NOT NULL DEFAULT 'month'
  CHECK (checkout_interval IN ('month', 'quarter', 'semiannual', 'year'));
ALTER TABLE accounts ADD COLUMN checkout_coupon TEXT NOT NULL DEFAULT ''
  CHECK (length(checkout_coupon) <= 32);
ALTER TABLE accounts ADD COLUMN checkout_session_id TEXT
  CHECK (checkout_session_id IS NULL OR length(checkout_session_id) <= 255);

ALTER TABLE subscriptions ADD COLUMN billing_interval TEXT
  CHECK (billing_interval IS NULL OR billing_interval IN ('month', 'quarter', 'semiannual', 'year'));

CREATE TABLE discount_coupons (
  id TEXT PRIMARY KEY NOT NULL,
  code TEXT NOT NULL UNIQUE CHECK (length(code) BETWEEN 3 AND 32),
  kind TEXT NOT NULL CHECK (kind IN ('percent', 'amount')),
  value INTEGER NOT NULL CHECK (
    (kind = 'percent' AND value BETWEEN 1 AND 100)
    OR (kind = 'amount' AND value BETWEEN 1 AND 100000000)
  ),
  expires_at INTEGER CHECK (expires_at IS NULL OR expires_at >= 0),
  max_redemptions INTEGER CHECK (max_redemptions IS NULL OR max_redemptions > 0),
  redeemed_count INTEGER NOT NULL DEFAULT 0 CHECK (redeemed_count >= 0),
  intervals TEXT NOT NULL CHECK (json_valid(intervals) AND length(intervals) <= 80),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  stripe_coupon_id TEXT CHECK (stripe_coupon_id IS NULL OR length(stripe_coupon_id) BETWEEN 1 AND 40),
  created_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  disabled_at INTEGER CHECK (disabled_at IS NULL OR disabled_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
) STRICT;
CREATE UNIQUE INDEX discount_coupons_stripe_idx ON discount_coupons(stripe_coupon_id) WHERE stripe_coupon_id IS NOT NULL;
CREATE INDEX discount_coupons_created_idx ON discount_coupons(created_at);

CREATE TABLE coupon_redemptions (
  id TEXT PRIMARY KEY NOT NULL,
  coupon_id TEXT NOT NULL REFERENCES discount_coupons(id),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  interval TEXT NOT NULL CHECK (interval IN ('month', 'quarter', 'semiannual', 'year')),
  stripe_subscription_id TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (coupon_id, stripe_subscription_id)
) STRICT;
CREATE INDEX coupon_redemptions_coupon_idx ON coupon_redemptions(coupon_id);

-- Novas ações: criar e desligar cupom. SQLite não altera CHECK inline (mesmo método da 0006).
CREATE TABLE admin_audit_v4 (
  id TEXT PRIMARY KEY NOT NULL,
  actor_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  target_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK (action IN (
    'suspend', 'resume', 'extend_trial', 'mint_license_code', 'revoke_license_code', 'test_notice',
    'create_coupon', 'disable_coupon'
  )),
  details TEXT NOT NULL CHECK (json_valid(details)),
  created_at INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
) STRICT;
INSERT INTO admin_audit_v4(id, actor_account_id, target_account_id, action, details, created_at)
  SELECT id, actor_account_id, target_account_id, action, details, created_at FROM admin_audit;
DROP TABLE admin_audit;
ALTER TABLE admin_audit_v4 RENAME TO admin_audit;
CREATE INDEX admin_audit_actor_created_idx ON admin_audit(actor_account_id, created_at);
CREATE INDEX admin_audit_target_created_idx ON admin_audit(target_account_id, created_at);
CREATE INDEX admin_audit_created_idx ON admin_audit(created_at);

UPDATE system_metadata SET value = '8' WHERE key = 'schema_version';
