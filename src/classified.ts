import type { Config } from './config.js';

// ?1 = now (epoch ms), ?2 = JSON array of allowlisted admin emails. Mirrors accountAccess:
// suspension wins, then paid or authorized admin, then a running trial.
export const LIVE = "((s.status IN('active','trialing') AND s.current_period_end>?1) OR (s.status='past_due' AND s.grace_until>?1))";
export const CLASSIFIED = `WITH paid AS (
    SELECT s.account_id FROM subscriptions s WHERE s.owner_type='account' AND ${LIVE}
    UNION SELECT m.account_id FROM team_members m JOIN subscriptions s ON s.owner_type='team' AND s.team_id=m.team_id WHERE ${LIVE}
  ), flagged AS (
    SELECT a.*, (a.role='admin' AND EXISTS(SELECT 1 FROM identities i WHERE i.account_id=a.id AND i.email_verified=1 AND lower(i.email) IN (SELECT value FROM json_each(?2)))) AS is_admin FROM accounts a
  ), classified AS (
    SELECT f.*, CASE WHEN f.suspended_at IS NOT NULL THEN 'suspended' WHEN f.is_admin OR f.id IN (SELECT account_id FROM paid) THEN 'active' WHEN f.trial_expires_at>?1 THEN 'trial' ELSE 'expired' END AS situation FROM flagged f
  )`;

export function adminEmails(config: Config): string {
  return JSON.stringify(config.ADMIN_EMAILS.split(',').map(value => value.trim().toLowerCase()).filter(Boolean));
}
